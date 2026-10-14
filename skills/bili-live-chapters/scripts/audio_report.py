#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""读 audio_feat.py 的 .npy，输出每分钟画像 + 30s 强度图 + 结构变化点。

用法:
    python audio_report.py <feat.npy> [--quiet-db -45] [--silence-db -48] [--silence-min 60]
"""
import argparse
import sys

import numpy as np

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")


def hhmmss(sec):
    m, s = divmod(int(sec), 60)
    h, m = divmod(m, 60)
    return f"{h}:{m:02d}:{s:02d}" if h else f"{m:02d}:{s:02d}"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("feat")
    ap.add_argument("--quiet-db", type=float, default=-45.0)
    ap.add_argument("--silence-db", type=float, default=-48.0)
    ap.add_argument("--silence-min", type=float, default=60.0)
    args = ap.parse_args()

    f = np.load(args.feat)
    db, cen, flat = f[:, 1], f[:, 2], f[:, 3]
    mins = (f[:, 0] // 60).astype(int)
    print(f"{'min':>5} {'hh:mm':>9} {'dB':>6} {'质心':>6} {'平坦':>6} {'<200':>5} {'200-1k':>6} "
          f"{'1-3k':>5} {'3-6k':>5} {'6-8k':>5} {'静音%':>6}")
    for m in range(mins.max() + 1):
        s = f[mins == m]
        if not len(s):
            continue
        q = (s[:, 1] < args.quiet_db).mean() * 100
        print(f"{m:5d} {hhmmss(m*60):>9} {s[:,1].mean():6.1f} {s[:,2].mean():6.0f} {s[:,3].mean():6.3f} "
              f"{s[:,4].mean():5.2f} {s[:,5].mean():6.2f} {s[:,6].mean():5.2f} {s[:,7].mean():5.2f} "
              f"{s[:,8].mean():5.2f} {q:6.0f}")

    step = 60  # 60 帧 * 0.5s = 30s 一格
    n = len(db) // step * step
    cells = db[:n].reshape(-1, step).mean(1)
    line = "".join(" " if v < args.silence_db else "." if v < -42 else ":" if v < -35 else
                   "*" if v < -28 else "#" for v in cells)
    print("\n30s 一格强度图（每行 30 分钟；' '静音 .<-42dB :<-35 *<-28 #说话/唱）")
    per_line = 60  # 60 格 = 30 分钟
    for i in range(0, len(line), per_line):
        print(f"{hhmmss(i*30):>9}|{line[i:i+per_line]}|")

    print(f"\n连续安静段（10s 均 < {args.silence_db}dB，长度 >= {args.silence_min:.0f}s）:")
    k = 20  # 10s
    n = len(db) // k * k
    dbs = db[:n].reshape(-1, k).mean(1)
    cur, found = None, []
    for i, v in enumerate(dbs):
        t = i * 10
        if v < args.silence_db:
            cur = [t, t] if cur is None else [cur[0], t]
        else:
            if cur and cur[1] - cur[0] >= args.silence_min:
                found.append(tuple(cur))
            cur = None
    if cur and cur[1] - cur[0] >= args.silence_min:
        found.append(tuple(cur))
    print("  （无）" if not found else "")
    for a, b in found:
        print(f"  {hhmmss(a)} - {hhmmss(b)}  ({int(b-a)}s)")

    # 结构变化点：前后各 2 分钟特征均值差
    X = np.column_stack([db, np.log10(cen + 1), np.log10(flat + 1e-3), f[:, 4:9],
                         (db < args.quiet_db).astype(float)])
    X = (X - X.mean(0)) / (X.std(0) + 1e-9)
    k = 10
    Xs = X[:len(X) // k * k].reshape(-1, k, X.shape[1]).mean(1)
    ts = np.arange(len(Xs)) * k * 0.5
    W, step_i = 24, 6
    res = []
    for i in range(W, len(Xs) - W, step_i):
        res.append((ts[i], float(np.linalg.norm(Xs[i - W:i].mean(0) - Xs[i:i + W].mean(0)))))
    res.sort(key=lambda x: -x[1])
    picked = []
    for t, d in res:
        if d < 0.45:
            break
        if all(abs(t - p[0]) >= 240 for p in picked):
            picked.append((t, d))
    picked.sort()
    print("\n候选结构变化点（音频特征突变，间隔 >=4 分钟；配合画面/弹幕确认）:")
    prev = 0
    for t, d in picked:
        print(f"  {hhmmss(t)}  强度 {d:4.2f}  (距上一个 {(t-prev)/60:5.1f} 分钟)")
        prev = t


if __name__ == "__main__":
    main()
