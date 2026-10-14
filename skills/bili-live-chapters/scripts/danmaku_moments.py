#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""弹幕文本（dump_danmaku.py 的输出）→ 每分钟条数 / 复读刷屏 / 关键词簇 / 空档 / 说话最多的人。

用法:
    python danmaku_moments.py <danmaku.txt> [--interval 300] [--min-repeat 3]

用途：定位话题转折和名场面（"发了"=抽奖、"[大哭]"=走心/唱歌、💃=唱跳、对面/豆汁=PK、
棋盘/手机屏幕=小游戏、886/晚安=下播）。
"""
import argparse
import collections
import io
import re
import sys

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

PAT = re.compile(r"^\[(\d+):(\d\d)(?:\.(\d))?\]\s*(.*?):\s*(.*)$")

GROUPS = {
    "抽奖/礼物": ["发了", "盾", "虎粮", "情书", "小电视", "盲盒", "守护", "续费", "抽奖", "上头条"],
    "唱歌/点歌": ["好听", "点歌", "送花", "心动", "大哭", "泪", "唱", "歌"],
    "整活/笑点": ["哈哈", "笑死", "离谱", "演员", "演技", "整活", "绷不住"],
    "PK/连麦": ["对面", "上豆汁", "连麦", "pk", "PK", "对面上的"],
    "小游戏": ["五子棋", "棋盘", "禁手", "上号", "开黑", "赢了", "输了", "寄", "陪玩", "兼职"],
    "时差/日常": ["几点", "时差", "吃饭", "外卖", "饭菜", "洗", "睡"],
    "下播": ["886", "晚安", "下播", "再见"],
}


def hhmmss(sec):
    m, s = divmod(int(sec), 60)
    h, m = divmod(m, 60)
    return f"{h}:{m:02d}:{s:02d}" if h else f"{m:02d}:{s:02d}"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("danmaku")
    ap.add_argument("--interval", type=int, default=300, help="复读统计窗口（秒），默认 300")
    ap.add_argument("--min-repeat", type=int, default=3)
    args = ap.parse_args()

    items, users = [], collections.Counter()
    for line in io.open(args.danmaku, encoding="utf-8", errors="replace"):
        m = PAT.match(line.strip())
        if not m:
            continue
        t = int(m.group(1)) * 60 + int(m.group(2))
        items.append((t, m.group(4), m.group(5)))
        users[m.group(4)] += 1
    if not items:
        print("没解析到弹幕行，检查输入是否是 dump_danmaku.py 的输出")
        return 1
    print(f"弹幕 {len(items)} 条，{hhmmss(items[0][0])} ~ {hhmmss(items[-1][0])}")

    per_min = collections.Counter(t // 60 for t, _, _ in items)
    top = per_min.most_common(12)
    print("\n最热闹的分钟 top12:")
    for m, c in top:
        print(f"  {hhmmss(m*60)}  {c} 条")

    print(f"\n复读刷屏（{args.interval//60} 分钟窗口内同一句 >= {args.min_repeat} 次）:")
    buck = collections.defaultdict(collections.Counter)
    for t, _, x in items:
        if len(x) >= 2 and not x.startswith("["):
            buck[t // args.interval][x] += 1
    rows = []
    for b in sorted(buck):
        for x, c in buck[b].most_common(4):
            if c >= args.min_repeat:
                rows.append((b * args.interval, c, x))
    for t, c, x in rows:
        print(f"  {hhmmss(t)}  x{c:<3} {x[:44]}")
    if not rows:
        print("  （无）")

    print("\n关键词簇（命中时间区间，>=3 条才算）:")
    for name, kws in GROUPS.items():
        hits = [t for t, _, x in items if any(k in x for k in kws)]
        clusters, cur = [], []
        for t in hits:
            if cur and t - cur[-1] > 150:
                clusters.append(cur)
                cur = []
            cur.append(t)
        if cur:
            clusters.append(cur)
        big = [c for c in clusters if len(c) >= 3]
        line = " | ".join(f"{hhmmss(c[0])}-{hhmmss(c[-1])}({len(c)})" for c in big[:8])
        print(f"  {name:>9}: {line or '—'}")

    gaps = [(b - a, a, b) for a, b in zip([i[0] for i in items], [i[0] for i in items][1:]) if b - a >= 300]
    print("\n弹幕空档 >=5 分钟:")
    print("  （无）" if not gaps else "")
    for dt, a, b in sorted(gaps, reverse=True)[:8]:
        print(f"  {hhmmss(a)} -> {hhmmss(b)}  ({dt/60:.1f} 分钟)")

    print("\n说话最多的人 top10:")
    for u, c in users.most_common(10):
        print(f"  {c:4d}  {u}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
