# -*- coding: utf-8 -*-
"""
校验置顶评论时间轴：
  1. 时间格式——视频 ≥1 小时必须 hh:mm:ss（和本项目 renderTimelineText 的 withHours 逻辑一致）
  2. 时间递增、且不超过视频时长
  3. 字数 ≤ 1000——**算上第一行标题**（B站算的是整段文本；曾出现校验器只数正文、
     实际 1053 字被 B站 拒的情况）
  4. 常见的"注释体"残留（= 、→ 、(谁点的歌) 这类）

用法:
  python check_pinned.py <置顶评论.txt> --duration <秒>
退出码 1 = 有问题。
"""
import argparse, re, sys

ANNOT = ('=', '→', 'vs ', '(谁点的', '(弹幕点的', '注:', '备注')
SAFE = 860          # 建议线：留余量
LIMIT = 900         # 实测上限（838/843 字能发，974 字被 B站 拒；含第一行标题）


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('file')
    ap.add_argument('--duration', type=float, required=True)
    a = ap.parse_args()

    text = open(a.file, encoding='utf-8').read()
    lines = [l.rstrip() for l in text.splitlines() if l.strip()]
    with_hours = a.duration >= 3600
    need = 'hh:mm:ss' if with_hours else 'mm:ss'
    pat = re.compile(r'^(\d{2}):(\d{2}):(\d{2})\s' if with_hours else r'^(\d{2}):(\d{2})\s')

    bad_fmt, times, bad_annot, bad_order, over = [], [], [], [], []
    for l in lines:
        if l.startswith('📌'):     # 📌 标题行
            continue
        m = pat.match(l)
        if not m:
            bad_fmt.append(l)
            continue
        nums = [int(x) for x in m.groups()]
        t = nums[0] * 3600 + nums[1] * 60 + nums[2] if with_hours else nums[0] * 60 + nums[1]
        times.append(t)
        if t > a.duration:
            over.append(l)
        if any(k in l for k in ANNOT):
            bad_annot.append(l)
    for i in range(1, len(times)):
        if times[i] <= times[i - 1]:
            bad_order.append(times[i])

    n = len([c for c in text if not c.isspace()])   # 含第一行标题
    print(f"时间轴 {len(lines) - 1} 条，视频 {a.duration / 3600:.2f} 小时，"
          f"要求格式 {need}，字数 {n}/{LIMIT}（含第一行标题；实测 838 能发、974 被拒）")

    ok = True
    for label, items in (('格式不对', bad_fmt), ('超出视频时长', over),
                         ('时间没递增', bad_order), ('注释体残留', bad_annot)):
        if items:
            ok = False
            print(f"  ✗ {label} {len(items)} 条：")
            for x in items[:8]:
                print(f"      {x[:70] if isinstance(x, str) else x}")
    if n > LIMIT:
        ok = False
        print(f"  ✗ 字数超过实测上限 {LIMIT}（当前 {n}）——B站 粘贴会报超字数")
    elif n > SAFE:
        print(f"  ⚠ 字数 {n} 已过建议线 {SAFE}，B站 卡在 1000 附近，建议再删两条")
    print("全部通过，可以粘贴成置顶评论" if ok else "有问题，见上面")
    return 0 if ok else 1


if __name__ == '__main__':
    sys.exit(main())
