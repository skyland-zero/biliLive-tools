#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""弹幕 XML -> 文本 + 概览。

用法:
    python dump_danmaku.py <合并.xml> <out.txt> [--bucket 300]

输出文件每行: [MMM:SS.d] 用户: 内容
stdout 打印: 总数 / 首尾时间 / 每分钟条数 top / 复读刷屏 top / 礼物事件数
"""
import argparse
import collections
import io
import re
import sys
import xml.etree.ElementTree as ET

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")


def parse(xml_path):
    text = io.open(xml_path, encoding="utf-8", errors="replace").read()
    items = []
    for line in text.splitlines():
        line = line.strip()
        if not line.startswith("<d "):
            continue
        m = re.search(r'p="([^"]*)"', line)
        if not m:
            continue
        t = float(m.group(1).split(",")[0])
        u = re.search(r'user="([^"]*)"', line)
        body = re.search(r">(.*)</d>$", line)
        items.append((t, u.group(1) if u else "", body.group(1) if body else ""))
    items.sort()
    return text, items


def ts(sec, tenths=False):
    sec = max(0.0, float(sec))
    m, s = divmod(int(sec), 60)
    if tenths:
        return f"{m:03d}:{s:02d}.{int((sec - int(sec)) * 10)}"
    h, m = divmod(int(sec) // 60, 60)
    return f"{h:d}:{m:02d}:{s:02d}" if h else f"{m:02d}:{s:02d}"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("xml")
    ap.add_argument("out")
    ap.add_argument("--bucket", type=int, default=300, help="刷屏统计的时间窗（秒），默认 300")
    args = ap.parse_args()

    text, items = parse(args.xml)
    if not items:
        print("没有解析到 <d> 弹幕，检查 XML 是否是录播弹幕文件")
        return 1
    with io.open(args.out, "w", encoding="utf-8", newline="\n") as f:
        for t, u, x in items:
            f.write(f"[{ts(t, True)}] {u}: {x}\n")

    total_sec = items[-1][0]
    print(f"弹幕 {len(items)} 条 -> {args.out}")
    print(f"时间范围 {ts(items[0][0])} ~ {ts(total_sec)}（约 {total_sec/60:.1f} 分钟）")

    for tag in ("gift", "guard", "sc"):
        n = len(re.findall(r"<%s\b" % tag, text))
        if n:
            print(f"{tag} 事件: {n}")

    per_min = collections.Counter(int(t // 60) for t, _, _ in items)
    print("\n每分钟条数（只列 >=3 的分钟）:")
    for m in sorted(per_min):
        if per_min[m] >= 3:
            print(f"  {m:4d} {m//60:02d}:{m%60:02d} {'#'*min(per_min[m], 60)} {per_min[m]}")

    buck = collections.defaultdict(collections.Counter)
    for t, _, x in items:
        if len(x) >= 2 and not x.startswith("["):
            buck[int(t // args.bucket)][x] += 1
    rows = []
    for b in sorted(buck):
        for x, c in buck[b].most_common(1):
            if c >= 3:
                rows.append((c, b * args.bucket, x))
    rows.sort(reverse=True)
    print("\n复读刷屏 top15:")
    for c, t, x in rows[:15]:
        print(f"  {ts(t)}  x{c:<3} {x[:40]}")

    gaps = []
    for i in range(1, len(items)):
        dt = items[i][0] - items[i - 1][0]
        if dt >= 300:
            gaps.append((dt, items[i - 1][0], items[i][0]))
    if gaps:
        print("\n弹幕空档 >=5 分钟（可能主播离场/没人说话）:")
        for dt, a, b in sorted(gaps, reverse=True)[:8]:
            print(f"  {ts(a)} -> {ts(b)}  ({dt/60:.1f} 分钟)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
