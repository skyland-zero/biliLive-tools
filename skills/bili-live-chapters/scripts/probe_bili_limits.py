#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""复验 B站 分段章节的数量上限：扫长视频的 player/v2 `view_points`。

用法:
    python probe_bili_limits.py [--max-videos 400] [--duration-min 1800]

判定：
  type=2 且 from < to  → 分段章节（真正限制在 10 个以内）
  type=1 且 from == to → 看点类标记（另一个功能，数量上限不同）
只用 B站公开接口，无需登录。
"""
import argparse
import hashlib
import http.cookiejar
import json
import sys
import time
import urllib.parse
import urllib.request

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/124.0 Safari/537.36")
MIXIN = [46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42, 19,
         29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4,
         22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52]
KEYWORDS = ["直播回放", "录播", "歌回", "直播录像", "游戏实况", "演唱会 录播", "课程", "讲座",
            "全程回放", "电影解说合集", "舞台剧", "综艺", "访谈", "发布会", "赛事回放", "合集"]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--max-videos", type=int, default=400, help="最多检查多少个长视频")
    ap.add_argument("--duration-min", type=int, default=1800, help="只看时长 >= 该秒数的视频")
    args = ap.parse_args()

    cj = http.cookiejar.CookieJar()
    op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cj))
    op.addheaders = [("User-Agent", UA), ("Referer", "https://www.bilibili.com/")]

    def get(url):
        for _ in range(3):
            try:
                with op.open(url, timeout=20) as r:
                    return json.loads(r.read().decode("utf-8", "replace"))
            except Exception:
                time.sleep(1.0)
        return {}

    try:
        op.open("https://www.bilibili.com/", timeout=20).read()
    except Exception:
        pass

    nav = get("https://api.bilibili.com/x/web-interface/nav").get("data") or {}
    img = (nav.get("wbi_img") or {}).get("img_url", "").rsplit("/", 1)[-1].split(".")[0]
    sub = (nav.get("wbi_img") or {}).get("sub_url", "").rsplit("/", 1)[-1].split(".")[0]
    key = "".join((img + sub)[i] for i in MIXIN)[:32] if img and sub else None

    def search(kw, page):
        p = {"search_type": "video", "keyword": kw, "page": page, "duration": 4, "order": "click",
             "wts": int(time.time())}
        if key:
            q = urllib.parse.urlencode(sorted(p.items()))
            p["w_rid"] = hashlib.md5((q + key).encode()).hexdigest()
            r = get("https://api.bilibili.com/x/web-interface/wbi/search/type?" +
                    urllib.parse.urlencode(sorted(p.items())))
        else:
            r = {}
        if r.get("code") != 0:
            r = get("https://api.bilibili.com/x/web-interface/search/type?" +
                    urllib.parse.urlencode({k: v for k, v in p.items() if k != "w_rid"}))
        return (r.get("data") or {}).get("result") or []

    seen, hist, checked, best = set(), {}, 0, None
    for kw in KEYWORDS:
        for page in (1, 2, 3):
            if checked >= args.max_videos:
                break
            for r in search(kw, page):
                bv = r.get("bvid")
                if not bv or bv in seen:
                    continue
                seen.add(bv)
                v = get(f"https://api.bilibili.com/x/web-interface/view?bvid={bv}").get("data") or {}
                if v.get("duration", 0) < args.duration_min:
                    continue
                checked += 1
                pts = (get(f"https://api.bilibili.com/x/player/v2?aid={v['aid']}&cid={v['cid']}")
                       .get("data") or {}).get("view_points") or []
                chapters = [p for p in pts if (p.get("from") or 0) < (p.get("to") or 0)]
                points = [p for p in pts if (p.get("from") or 0) >= (p.get("to") or 0)]
                if chapters:
                    hist[len(chapters)] = hist.get(len(chapters), 0) + 1
                    print(f"  章节 {len(chapters):2d} | 看点 {len(points):2d} | "
                          f"{v['duration']//60:5d}min | {bv} | {v['title'][:34]}")
                    if not best or len(chapters) > best[0]:
                        best = (len(chapters), bv, v["title"], [p.get("content") for p in chapters])
                if checked >= args.max_videos:
                    break
            time.sleep(0.3)
        if checked >= args.max_videos:
            break

    print(f"\n检查 {checked} 个 >= {args.duration_min//60} 分钟的视频，其中有分段章节的 {sum(hist.values())} 个")
    print("分段章节数量分布:", dict(sorted(hist.items())))
    if best:
        print(f"最多：{best[0]} 章  {best[1]}  {best[2][:40]}")
        print("  标题示例: " + " | ".join(str(c)[:20] for c in best[3][:12]))


if __name__ == "__main__":
    main()
