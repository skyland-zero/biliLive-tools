#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""校验章节文本是否满足 B站「分段章节」硬性规则。

用法:
    python check_chapters.py <章节.txt> --duration 8189 [--max 10] [--max-title 16] [--min-gap 5]

只读取形如 `00:00:00 标题` / `12:30 标题` 的行，其余行忽略。
退出码 0 = 全部通过，1 = 有问题。
"""
import argparse
import io
import re
import sys

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

LINE = re.compile(r"^\s*(\d{1,2}):(\d{2})(?::(\d{2}))?\s+(\S.*?)\s*$")
EMOJI = re.compile("[\U0001F000-\U0001FAFF\u2600-\u27BF\uFE0F\u2B00-\u2BFF]")


def parse_time(m):
    a, b, c = m.group(1), m.group(2), m.group(3)
    if c is None:
        return int(a) * 60 + int(b)
    return int(a) * 3600 + int(b) * 60 + int(c)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("chapters")
    ap.add_argument("--duration", type=float, required=True, help="视频总时长（秒）")
    ap.add_argument("--max", type=int, default=10)
    ap.add_argument("--min-gap", type=int, default=5)
    ap.add_argument("--max-title", type=int, default=16)
    args = ap.parse_args()

    rows, problems = [], []
    for line in io.open(args.chapters, encoding="utf-8", errors="replace"):
        m = LINE.match(line)
        if m:
            rows.append((parse_time(m), m.group(4), line.strip()))

    if not rows:
        print("没解析到任何章节行")
        return 1

    print(f"章节 {len(rows)} 条，视频 {args.duration/3600:.2f} 小时，规则：≤{args.max} 条 / "
          f"首章 00:00 / 间隔 ≥{args.min_gap}s / 标题 ≤{args.max_title} 字")

    if rows[0][0] != 0:
        problems.append(f"第一章不是 00:00（是 {rows[0][2]}）")
    if not (2 <= len(rows) <= args.max):
        problems.append(f"章节数 {len(rows)} 不在 2-{args.max} 之间")
    for i, (t, title, raw) in enumerate(rows):
        if EMOJI.search(title):
            problems.append(f"标题含 emoji/符号：{raw}")
        if len(title) > args.max_title:
            problems.append(f"标题 {len(title)} 字超限：{raw}")
        if i and t - rows[i - 1][0] < args.min_gap:
            problems.append(f"间隔不足 {args.min_gap}s：{rows[i-1][2]} -> {raw}")
        if t >= args.duration:
            problems.append(f"时间超出视频长度：{raw}")
    if any(rows[i][0] <= rows[i - 1][0] for i in range(1, len(rows))):
        problems.append("时间戳没有严格递增")

    for i, (t, title, raw) in enumerate(rows):
        end = rows[i + 1][0] if i + 1 < len(rows) else args.duration
        mark = "OK  "
        if len(title) > args.max_title or EMOJI.search(title):
            mark = "WARN"
        print(f"  {mark} {raw}   段落时长 {(end-t)/60:.1f} 分钟, 标题 {len(title)} 字")

    if problems:
        print("\n发现问题:")
        for p in problems:
            print("  -", p)
        return 1
    print("\n全部通过，可以粘贴到投稿页「分段章节」")
    return 0


if __name__ == "__main__":
    sys.exit(main())
