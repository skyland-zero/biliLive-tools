import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import AutoImport from "unplugin-auto-import/vite";
import Components from "unplugin-vue-components/vite";
import { NaiveUiResolver } from "unplugin-vue-components/resolvers";

const appRoot = resolve(__dirname, "../app");
const rendererRoot = resolve(appRoot, "src/renderer");
const desktopSrc = resolve(__dirname, "src").replace(/\\/g, "/");

const appVersion = JSON.parse(readFileSync(resolve(appRoot, "package.json"), "utf-8")).version;
process.env.VITE_VERSION = appVersion;

// https://vite.dev/config/
export default defineConfig(async () => {
  const host = process.env.TAURI_DEV_HOST;

  return {
    root: rendererRoot,
    envDir: appRoot,
    resolve: {
      alias: [
        { find: /^\/@desktop\//, replacement: `${desktopSrc}/` },
        { find: "@renderer", replacement: resolve(rendererRoot, "src") },
        { find: "@types", replacement: resolve(appRoot, "src/types") },
      ],
    },
    plugins: [
      vue({
        script: {
          defineModel: true,
        },
      }),
      AutoImport({
        dts: false,
        imports: [
          "vue",
          {
            "naive-ui": ["useDialog", "useMessage", "useNotification", "useLoadingBar"],
          },
          "pinia",
          {
            "@renderer/hooks/useNotice": ["useNotice"],
          },
        ],
      }),
      Components({
        dts: false,
        resolvers: [NaiveUiResolver()],
      }),
      {
        // 复用 app 的 renderer 入口，在其之前插入 Tauri 适配层
        // 必须在 pre 阶段执行：build 时 Vite 会在此之后采集 script 标签
        name: "inject-desktop-adapter",
        transformIndexHtml: {
          order: "pre",
          handler(html: string) {
            return html.replace('src="/src/main.ts"', 'src="/@desktop/bootstrap.ts"');
          },
        },
      },
    ],
    clearScreen: false,
    optimizeDeps: {
      // bootstrap 入口是注入的，扫描不到适配层的依赖，
      // 不预构建会在首次加载时触发 optimize + 整页 reload
      include: [
        "@tauri-apps/api/core",
        "@tauri-apps/api/event",
        "@tauri-apps/plugin-dialog",
        "@tauri-apps/plugin-opener",
        "path-unified",
      ],
    },
    server: {
      port: 28081,
      strictPort: true,
      host: host || false,
      hmr: host
        ? {
            protocol: "ws",
            host,
            port: 28082,
          }
        : undefined,
      watch: {
        ignored: ["**/src-tauri/**"],
      },
      // 提前转换渲染层入口图，与 sidecar 启动并行
      warmup: {
        clientFiles: ["./src/main.ts"],
      },
    },
    build: {
      outDir: resolve(__dirname, "dist"),
      emptyOutDir: true,
      target: process.env.TAURI_ENV_PLATFORM === "darwin" ? "safari13" : "chrome105",
      minify: !process.env.TAURI_ENV_DEBUG ? "esbuild" : false,
      sourcemap: !!process.env.TAURI_ENV_DEBUG,
    },
  };
});
