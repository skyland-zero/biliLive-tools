<template>
  <n-space vertical>
    <n-layout :has-sider="!isMobile" class="layout" position="absolute">
      <n-layout-sider
        v-if="!isMobile"
        bordered
        collapse-mode="width"
        :collapsed-width="64"
        :width="208"
        :collapsed="collapsed"
        :show-trigger="false"
        :native-scrollbar="false"
        class="app-sider"
      >
        <div class="sider-wrapper">
          <div class="sider-header" :class="{ collapsed }">
            <template v-if="!collapsed">
              <div class="sider-brand-group">
                <div
                  class="brand-icon-box"
                  title="直播录制"
                  @click="router.push({ name: 'recorder' })"
                >
                  <n-icon :size="16" color="#ffffff">
                    <LiveTvRound />
                  </n-icon>
                </div>
                <div
                  class="status-pill"
                  :class="{ warning: quenuStore.runningTaskNum > 0 }"
                  :title="
                    quenuStore.runningTaskNum > 0
                      ? `当前有 ${quenuStore.runningTaskNum} 个任务在运行，点击查看队列`
                      : '系统运行正常，点击进入直播间'
                  "
                  @click="handleStatusClick"
                >
                  <span class="status-dot"></span>
                  <span class="status-text">
                    {{
                      quenuStore.runningTaskNum > 0
                        ? `任务中 (${quenuStore.runningTaskNum})`
                        : "系统就绪"
                    }}
                  </span>
                </div>
              </div>
              <n-button
                quaternary
                circle
                size="small"
                class="collapse-trigger-btn"
                title="折叠导航"
                @click="collapsed = true"
              >
                <template #icon>
                  <n-icon size="16">
                    <ChevronBackOutline />
                  </n-icon>
                </template>
              </n-button>
            </template>
            <template v-else>
              <div class="collapsed-brand" title="点击展开导航" @click="collapsed = false">
                <div class="brand-icon-box">
                  <n-icon :size="18" color="#ffffff">
                    <LiveTvRound />
                  </n-icon>
                </div>
                <span
                  class="collapsed-status-pip"
                  :class="{ warning: quenuStore.runningTaskNum > 0 }"
                ></span>
              </div>
            </template>
          </div>

          <div class="sider-menu-body">
            <n-scrollbar>
              <n-menu
                v-model:value="activeKey"
                v-model:expanded-keys="expandedMenuKeys"
                class="main-menu"
                :collapsed="collapsed"
                :collapsed-width="64"
                :collapsed-icon-size="20"
                :options="menuOptions"
              />
            </n-scrollbar>
          </div>

          <div class="sider-footer">
            <n-menu
              v-model:value="activeKey"
              class="footer-menu"
              :collapsed="collapsed"
              :collapsed-width="64"
              :collapsed-icon-size="20"
              :options="footerMenuOptions"
              default-expand-all
            />
          </div>
        </div>
      </n-layout-sider>

      <n-layout :class="['main-container', route.name, { mobile: isMobile }]">
        <div v-if="isMobile" class="mobile-header">
          <n-button quaternary class="mobile-menu-trigger" @click="mobileMenuVisible = true">
            <template #icon>
              <n-icon size="36">
                <MenuOutline />
              </n-icon>
            </template>
          </n-button>
          <div class="mobile-header-title">biliLive-tools</div>
        </div>
        <router-view v-slot="{ Component }">
          <keep-alive
            :include="[
              'Home',
              'Dashboard',
              'Upload',
              'DanmakuFactory',
              'Convert2Mp4',
              'VideoMerge',
              'FlvRepair',
              'BiliDownload',
              'recorder',
              'videoCut',
              'Queue',
              'User',
              'About',
              'FileSync',
              'FileBrowser',
            ]"
          >
            <component :is="Component" />
          </keep-alive>
        </router-view>
      </n-layout>
    </n-layout>
  </n-space>
  <n-drawer v-model:show="mobileMenuVisible" placement="left" :width="280">
    <n-drawer-content
      body-content-style="padding: 0; display: flex; flex-direction: column;"
      class="mobile-drawer-content"
    >
      <div class="mobile-drawer-header">
        <span class="mobile-drawer-title">biliLive-tools</span>
      </div>
      <div class="mobile-drawer-body">
        <n-scrollbar>
          <n-menu
            v-model:value="activeKey"
            v-model:expanded-keys="expandedMenuKeys"
            class="mobile-main-menu"
            :options="menuOptions"
          />
        </n-scrollbar>
      </div>
      <div class="mobile-drawer-footer">
        <n-menu
          v-model:value="activeKey"
          class="mobile-footer-menu"
          :options="footerMenuOptions"
          default-expand-all
        />
      </div>
    </n-drawer-content>
  </n-drawer>
  <AppSettingDialog v-model="settingVisible" ref="settingDialogRef"></AppSettingDialog>
  <ChangelogModal v-model:visible="changelogVisible"></ChangelogModal>
  <logModal v-model:visible="logVisible"></logModal>
</template>

<script setup lang="ts">
defineOptions({
  name: "Main",
});
import { useStorage } from "@vueuse/core";
import { useBreakpoints } from "@renderer/hooks/useBreakpoints";
import { NIcon } from "naive-ui";
import { RouterLink, useRoute, useRouter } from "vue-router";
import {
  BuildOutline as BuildIcon,
  FolderOpenOutline as FolderIcon,
  InformationCircleOutline as InfoIcon,
  GitPullRequestOutline as QueueIcon,
  SettingsOutline as SettingIcon,
  LogOutOutline,
  MenuOutline,
  ChevronBackOutline,
} from "@vicons/ionicons5";
import { DashboardOutlined as DashboardIcon, LiveTvRound } from "@vicons/material";
import { VideoClip20Regular } from "@vicons/fluent";

import defaultUserAvatar from "../../assets/images/moehime.jpg";
import AppSettingDialog from "../../pages/setting/index.vue";
import ChangelogModal from "../../components/ChangelogModal.vue";
import logModal from "../../components/logModal.vue";
import { useUserInfoStore, useQueueStore, useAppConfig } from "../../stores";
import { commonApi } from "@renderer/apis";
import logSvg from "./logSvg.vue";
import eventBus from "@renderer/utils/eventBus";

import type { MenuOption } from "naive-ui";

const quenuStore = useQueueStore();
const appConfig = useAppConfig();

const { userInfo } = storeToRefs(useUserInfoStore());

const route = useRoute();
const activeKey = ref("recorder");
activeKey.value = (route.name as string) || "recorder";
const collapsed = useStorage("collapsed", false);
const expandedMenuKeys = useStorage<Array<string | number>>("menu-expanded-keys", [
  "videoProcessing",
  "tools",
]);
const mobileMenuVisible = ref(false);
const { isMobile } = useBreakpoints();

appConfig.getAppConfig();
quenuStore.init();

watch(
  () => route.fullPath,
  () => {
    activeKey.value = route.name as string;
    mobileMenuVisible.value = false;
  },
  { immediate: true },
);

watch(isMobile, (value) => {
  if (!value) {
    mobileMenuVisible.value = false;
  }
});

function renderIcon(icon: Component) {
  return () => h(NIcon, null, { default: () => h(icon) });
}
const isWeb = computed(() => window?.isWeb);

function renderQueueIcon(icon: Component) {
  return () =>
    h(
      "div",
      {
        style: { position: "relative" },
      },
      [
        h(
          "span",
          {
            style: {
              color: "red",
              position: "absolute",
              right: "-4px",
              top: "-4px",
              fontSize: "12px",
            },
          },
          quenuStore.runningTaskNum || "",
        ),
        h(NIcon, null, { default: () => h(icon) }),
      ],
    );
}

function renderImg(src: string) {
  return () =>
    h("img", {
      src,
      style: { height: "25px", width: "25px", "border-radius": "50%" },
      referrerpolicy: "no-referrer",
    });
}

const router = useRouter();

const handleStatusClick = () => {
  if (quenuStore.runningTaskNum > 0) {
    router.push({ name: "Queue" });
  } else {
    router.push({ name: "recorder" });
  }
};
const footerMenuOptions = computed<MenuOption[]>(() => {
  const menus: MenuOption[] = [
    {
      label: () =>
        h(
          RouterLink,
          {
            to: {
              name: "User",
            },
          },
          { default: () => "账号管理" },
        ),
      key: "User",
      icon: renderImg(userInfo.value?.profile?.face || defaultUserAvatar),
    },
    {
      label: () =>
        h(
          "a",
          {
            onClick: () => {
              openSetting();
            },
          },
          { default: () => "系统设置" },
        ),
      key: "setting",
      icon: renderIcon(SettingIcon),
    },
  ];

  if (isWeb.value) {
    menus.push({
      label: () =>
        h(
          "a",
          {
            onClick: () => {
              logVisible.value = true;
            },
          },
          { default: () => "运行日志" },
        ),
      key: "log",
      icon: renderIcon(logSvg),
    });
  }

  menus.push({
    label: () =>
      h(
        RouterLink,
        {
          to: {
            name: "About",
          },
        },
        { default: () => "关于软件" },
      ),
    key: "About",
    icon: renderIcon(InfoIcon),
  });

  if (isWeb.value) {
    menus.push({
      label: () =>
        h(
          "a",
          {
            onClick: () => {
              window.localStorage.removeItem("api");
              window.localStorage.setItem("key", "");
              router.push({ name: "Login" });
            },
          },
          { default: () => "退出登录" },
        ),
      key: "logout",
      icon: renderIcon(LogOutOutline),
    });
  }

  return menus;
});

const menuOptions = computed<MenuOption[]>(() => {
  const toolsSubMenus = [
    {
      key: "Upload",
      label: () =>
        h(
          RouterLink,
          {
            to: {
              name: "Upload",
            },
          },
          { default: () => "B站上传" },
        ),
    },
    {
      key: "DanmakuFactory",
      label: () =>
        h(
          RouterLink,
          {
            to: {
              name: "DanmakuFactory",
            },
          },
          { default: () => "弹幕转换" },
        ),
    },
    {
      key: "BiliDownload",
      label: () =>
        h(
          RouterLink,
          {
            to: {
              name: "BiliDownload",
            },
          },
          { default: () => "下载订阅" },
        ),
    },
    {
      key: "FileSync",
      label: () =>
        h(
          RouterLink,
          {
            to: {
              name: "FileSync",
            },
          },
          { default: () => "文件同步" },
        ),
    },
  ];

  const videoProcessingSubMenus = [
    {
      key: "Home",
      label: () =>
        h(
          RouterLink,
          {
            to: {
              name: "Home",
            },
          },
          { default: () => "视频压制" },
        ),
    },
    {
      key: "videoCut",
      label: () => {
        if (!isWeb.value && appConfig.appConfig.cutPageInNewWindow) {
          return h(
            "a",
            {
              onClick: async () => {
                await window.api.common.createSubWindow({
                  routeName: "videoCut",
                  hideAside: true,
                  maximized: true,
                  hideMenuBar: appConfig.appConfig.menuBarVisible ? false : true,
                });
              },
            },
            { default: () => "视频切片" },
          );
        } else {
          return h(
            RouterLink,
            {
              to: {
                name: "videoCut",
              },
            },
            { default: () => "视频切片" },
          );
        }
      },
    },
    {
      key: "Convert2Mp4",
      label: () =>
        h(
          RouterLink,
          {
            to: {
              name: "Convert2Mp4",
            },
          },
          { default: () => "格式转码" },
        ),
    },
    {
      key: "VideoMerge",
      label: () =>
        h(
          RouterLink,
          {
            to: {
              name: "VideoMerge",
            },
          },
          { default: () => "视频合并" },
        ),
    },
    {
      key: "FlvRepair",
      label: () =>
        h(
          RouterLink,
          {
            to: {
              name: "FlvRepair",
            },
          },
          { default: () => "FLV 修复" },
        ),
    },
  ];
  const menus: MenuOption[] = [
    {
      key: "recorder",
      label: () =>
        h(
          RouterLink,
          {
            to: {
              name: "recorder",
            },
          },
          { default: () => "直播录制" },
        ),
      icon: renderIcon(LiveTvRound),
    },
    {
      label: () =>
        h(
          RouterLink,
          {
            to: {
              name: "Dashboard",
            },
          },
          { default: () => "数据看板" },
        ),
      key: "Dashboard",
      icon: renderIcon(DashboardIcon),
    },
    {
      label: () =>
        h(
          RouterLink,
          {
            to: {
              name: "Queue",
            },
          },
          { default: () => "任务队列" },
        ),
      key: "Queue",
      icon: renderQueueIcon(QueueIcon),
    },
    {
      label: () => h("span", "视频处理"),
      key: "videoProcessing",
      icon: renderIcon(VideoClip20Regular),
      children: videoProcessingSubMenus,
    },
    {
      label: () => h("span", "实用工具"),
      key: "tools",
      icon: renderIcon(BuildIcon),
      children: toolsSubMenus,
    },
  ];
  if (isWeb.value) {
    menus.push({
      label: () =>
        h(
          RouterLink,
          {
            to: {
              name: "FileBrowser",
            },
          },
          { default: () => "文件浏览" },
        ),
      key: "FileBrowser",
      icon: renderIcon(FolderIcon),
    });
  }

  return menus;
});

const settingVisible = ref(false);

onMounted(() => {
  eventBus.on("open-setting-dialog", ({ extra }) => {
    openSetting("webhook", extra);
  });
});

const settingDialogRef = ref<InstanceType<typeof AppSettingDialog> | null>(null);
const openSetting = async (
  tab?: string,
  extra?: {
    roomId?: string;
  },
) => {
  settingVisible.value = true;
  if (tab) {
    setTimeout(() => {
      settingDialogRef.value?.set(tab, extra);
    }, 500);
  }
};

const logVisible = ref(false);
window?.api?.openSetting(() => {
  openSetting();
});
window?.api?.openLog(() => {
  logVisible.value = true;
});
window?.api?.openChangelog(() => {
  changelogVisible.value = true;
});

const notification = useNotification();

// const { notification } = createDiscreteApi(["message", "dialog", "notification", "loadingBar"]);

window.addEventListener("unhandledrejection", (error) => {
  notification.error({
    title: String(error.reason).replace("Error: ", ""),
    duration: 3000,
  });
});

// 更新日志处理
const changelogVisible = ref(false);
const initChanglog = async () => {
  const data = JSON.parse(localStorage.getItem("changelog") || "{}");
  const version = await commonApi.version();
  if (!data[version]) {
    changelogVisible.value = true;
  }
};
initChanglog();
</script>

<style lang="less">
@import "../../assets/css/styles.less";

.layout {
  inset: 0;
}

.main-container {
  margin: 15px;
  margin-right: 0px;

  & > .n-layout-scroll-container {
    padding-right: 10px;
    overflow-x: auto;
  }
  &.videoCut,
  &.LiveVideoPlayer {
    margin: 0px;
    margin-left: 15px;
    margin-right: 10px;
    & > .n-layout-scroll-container {
      padding-right: 0px;
    }
  }

  &.mobile {
    margin: 0;

    & > .n-layout-scroll-container {
      padding: 0 10px 10px 10px;
    }
  }
}

.mobile-header {
  position: sticky;
  top: 0;
  z-index: 20;
  display: flex;
  align-items: center;
  gap: 8px;
  background: var(--bg-primary);
  border-bottom: 1px solid var(--border-secondary);
  margin-bottom: 10px;
  padding: 10px 0;
}

.mobile-menu-trigger {
  flex: none;
}

.mobile-header-title {
  font-size: 18px;
  font-weight: bold;
  color: var(--text-primary);
}

.app-sider {
  height: 100%;
  background: var(--bg-primary);

  & > .n-layout-sider-scroll-container {
    height: 100%;
    overflow: hidden !important;
  }
}

.sider-wrapper {
  display: flex;
  flex-direction: column;
  height: 100%;
  width: 100%;
  overflow: hidden;
}

.sider-header {
  height: 50px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 12px 0 14px;
  border-bottom: 1px solid var(--border-secondary);
  flex-shrink: 0;

  &.collapsed {
    padding: 0;
    justify-content: center;
  }

  .collapse-trigger-btn {
    color: var(--text-secondary);
    &:hover {
      color: var(--text-primary);
    }
  }
}

.sider-brand-group {
  display: flex;
  align-items: center;
  gap: 8px;
}

.brand-icon-box {
  width: 28px;
  height: 28px;
  border-radius: 8px;
  background: linear-gradient(135deg, #18a058 0%, #36ad6a 100%);
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  box-shadow: 0 2px 6px rgba(24, 160, 88, 0.25);
  cursor: pointer;
  transition: transform 0.2s ease;

  &:hover {
    transform: scale(1.05);
  }
}

.status-pill {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 3px 8px;
  border-radius: 999px;
  background: var(--bg-hover);
  border: 1px solid var(--border-secondary);
  font-size: 11px;
  cursor: pointer;
  transition: all 0.2s ease;
  user-select: none;

  &:hover {
    border-color: var(--color-primary);
    transform: translateY(-1px);
  }

  .status-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background-color: var(--color-primary);
    box-shadow: 0 0 0 2px rgba(24, 160, 88, 0.2);
    animation: status-pulse 2s infinite ease-in-out;
  }

  .status-text {
    color: var(--text-secondary);
    font-size: 11px;
    line-height: 1;
    font-weight: 500;
  }

  &.warning {
    border-color: rgba(212, 136, 6, 0.3);
    background: rgba(212, 136, 6, 0.08);

    .status-dot {
      background-color: var(--color-warning);
      box-shadow: 0 0 0 2px rgba(212, 136, 6, 0.25);
    }
    .status-text {
      color: var(--color-warning);
      font-weight: 600;
    }
  }
}

.collapsed-brand {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;

  .brand-icon-box {
    width: 32px;
    height: 32px;
  }

  .collapsed-status-pip {
    position: absolute;
    top: -2px;
    right: -2px;
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background-color: var(--color-primary);
    border: 2px solid var(--bg-primary);

    &.warning {
      background-color: var(--color-warning);
    }
  }
}

@keyframes status-pulse {
  0%,
  100% {
    transform: scale(0.9);
    opacity: 0.8;
  }
  50% {
    transform: scale(1.15);
    opacity: 1;
  }
}

.sider-menu-body {
  flex: 1;
  min-height: 0;
  overflow: hidden;

  .main-menu {
    padding: 6px 0;
  }
}

.sider-footer {
  flex-shrink: 0;
  border-top: 1px solid var(--border-secondary);
  background: var(--bg-primary);
  padding: 4px 0;

  .footer-menu {
    border-top: none;
  }
}

.mobile-drawer-header {
  height: 52px;
  display: flex;
  align-items: center;
  padding: 0 20px;
  border-bottom: 1px solid var(--border-secondary);
  font-size: 16px;
  font-weight: 700;
  color: var(--text-primary);
  flex-shrink: 0;
}

.mobile-drawer-body {
  flex: 1;
  min-height: 0;
  overflow: hidden;
}

.mobile-drawer-footer {
  flex-shrink: 0;
  border-top: 1px solid var(--border-secondary);
  background: var(--bg-primary);
  padding: 4px 0;
}

.mobile-drawer-content {
  > .n-drawer-body {
    min-height: 0;
  }
}
</style>
