import { describe, it, expect, vi, beforeEach } from "vitest";
import { sendByWxPusher } from "../src/notify.js";

describe("sendByWxPusher", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("当 spt 为空时应该抛出错误", async () => {
    await expect(sendByWxPusher("测试标题", "测试详情", { spt: "" })).rejects.toThrow(
      "WxPusher spt 不能为空",
    );
  });

  it("正常发送且接口返回 1000 时成功", async () => {
    const mockResponse = { code: 1000, msg: "处理成功", data: [], success: true };
    const fetchMock = vi.fn().mockResolvedValue({
      json: () => Promise.resolve(mockResponse),
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await sendByWxPusher("标题", "内容", { spt: "SPT_test123" });
    expect(result).toEqual(mockResponse);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe("https://wxpusher.zjiecode.com/api/send/message/simple-push");
    expect(options.method).toBe("POST");
    expect(options.headers["Content-Type"]).toBe("application/json");

    const body = JSON.parse(options.body);
    expect(body.spt).toBe("SPT_test123");
    expect(body.summary).toBe("标题");
    expect(body.contentType).toBe(2);
    expect(body.content).toContain("标题");
    expect(body.content).toContain("内容");
  });

  it("当接口返回非 1000 错误码时应该抛出错误", async () => {
    const mockResponse = { code: 1001, msg: "SPT已失效", success: false };
    const fetchMock = vi.fn().mockResolvedValue({
      json: () => Promise.resolve(mockResponse),
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(sendByWxPusher("标题", "内容", { spt: "SPT_invalid" })).rejects.toThrow(
      "SPT已失效",
    );
  });
});
