#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""按固定帧长提取音频特征，供 audio_report.py 分析。

用法:
    python audio_feat.py <video> <out.npy> [--sr 16000] [--frame 0.5]

输出矩阵列: [t, dB, 谱质心Hz, 谱平坦度, <200, 200-1k, 1-3k, 3-6k, 6-8k]（频带为能量占比）
依赖 ffmpeg 在 PATH 中。2 小时的片子约 2-3 分钟。
"""
import argparse
import subprocess
import sys

import numpy as np

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("video")
    ap.add_argument("out")
    ap.add_argument("--sr", type=int, default=16000)
    ap.add_argument("--frame", type=float, default=0.5)
    args = ap.parse_args()

    sr, frame = args.sr, args.frame
    n = int(sr * frame)
    cmd = ["ffmpeg", "-v", "error", "-i", args.video, "-vn", "-ac", "1", "-ar", str(sr), "-f", "s16le", "-"]
    p = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, bufsize=10**7)
    win = np.hanning(n).astype(np.float32)
    freqs = np.fft.rfftfreq(n, 1 / sr)
    bands = [(0, 200), (200, 1000), (1000, 3000), (3000, 6000), (6000, 8000)]
    masks = [(freqs >= lo) & (freqs < hi) for lo, hi in bands]

    out, offset, buf = [], 0.0, b""
    while True:
        chunk = p.stdout.read(n * 2 * 64)
        if not chunk:
            break
        buf += chunk
        usable = len(buf) - (len(buf) % (n * 2))
        if not usable:
            continue
        data = np.frombuffer(buf[:usable], dtype=np.int16).reshape(-1, n).astype(np.float32) / 32768.0
        buf = buf[usable:]
        spec = np.abs(np.fft.rfft(data * win, axis=1))
        power = spec**2
        rms = np.sqrt((data**2).mean(axis=1))
        cen = (power * freqs).sum(axis=1) / (power.sum(axis=1) + 1e-12)
        flat = np.exp(np.log(power + 1e-12).mean(axis=1)) / (power.mean(axis=1) + 1e-12)
        band = np.array([power[:, m].sum(axis=1) for m in masks])
        band = band / (band.sum(axis=0) + 1e-12)
        for i in range(data.shape[0]):
            row = [offset + i * frame, float(20 * np.log10(rms[i] + 1e-9)), float(cen[i]), float(flat[i])]
            row += [float(band[k, i]) for k in range(len(masks))]
            out.append(row)
        offset += data.shape[0] * frame
        if len(out) % 18000 < len(data):
            print(f"  已处理 {offset/3600:.2f}h", file=sys.stderr, flush=True)
    p.wait()
    np.save(args.out, np.array(out))
    print(f"写出 {args.out}：{len(out)} 帧，{offset:.1f} 秒（{offset/60:.1f} 分钟）")


if __name__ == "__main__":
    main()
