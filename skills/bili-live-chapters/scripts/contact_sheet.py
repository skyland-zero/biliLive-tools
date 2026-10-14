#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""抽帧拼图（带时间标签），用来确认场景/画面变化。

用法:
    python contact_sheet.py <video> "0,120,240,600,1200" <out.jpg> [--cols 5] [--cell 384x216]
                           [--font C:/Windows/Fonts/arial.ttf]

注意：标签故意写成 `73m00` 而不是 `73:00`——ffmpeg drawtext 的 text='a:b' 会把冒号当参数分隔符，
标签会渲染错。脚本内部已处理，直接看结果即可。
"""
import argparse
import os
import subprocess
import sys

import numpy as np

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")

DEFAULT_FONTS = ["C:/Windows/Fonts/arial.ttf", "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"]


def pick_font(explicit):
    if explicit and os.path.exists(explicit):
        return explicit
    for p in DEFAULT_FONTS:
        if os.path.exists(p):
            return p
    return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("video")
    ap.add_argument("times", help="逗号分隔的秒数，例如 0,120,240")
    ap.add_argument("out")
    ap.add_argument("--cols", type=int, default=5)
    ap.add_argument("--cell", default="384x216", help="每格宽x高")
    ap.add_argument("--font")
    ap.add_argument("--quality", default="4")
    args = ap.parse_args()

    w, h = (int(x) for x in args.cell.lower().split("x"))
    times = [int(float(x)) for x in args.times.split(",") if x.strip() != ""]
    font = pick_font(args.font)

    def grab(t):
        label = f"{t//60}m{t%60:02d}"
        vf = f"scale={w}:{h}"
        if font:
            vf += (f",drawtext=fontfile='{font}':text='{label}':x=6:y=4:fontsize=20:"
                   f"fontcolor=yellow:box=1:boxcolor=black@0.75")
        r = subprocess.run(["ffmpeg", "-v", "error", "-ss", str(t), "-i", args.video, "-frames:v", "1",
                            "-vf", vf, "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], capture_output=True)
        a = np.frombuffer(r.stdout, dtype=np.uint8)
        if a.size < w * h * 3:
            print(f"  ! 无法取帧 {label}", file=sys.stderr)
            return np.zeros((h, w, 3), np.uint8)
        return a[:w * h * 3].reshape(h, w, 3)

    rows = (len(times) + args.cols - 1) // args.cols
    canvas = np.zeros((rows * h, args.cols * w, 3), np.uint8)
    for i, t in enumerate(times):
        r, c = divmod(i, args.cols)
        canvas[r * h:(r + 1) * h, c * w:(c + 1) * w] = grab(t)
    subprocess.run(["ffmpeg", "-v", "error", "-f", "rawvideo", "-pix_fmt", "rgb24",
                    "-s", f"{args.cols * w}x{rows * h}", "-i", "-", "-q:v", args.quality, "-y", args.out],
                   input=canvas.tobytes())
    print(f"写出 {args.out}  {canvas.shape[1]}x{canvas.shape[0]}  {len(times)} 帧: "
          f"{', '.join(f'{t//60}m{t%60:02d}' for t in times)}")


if __name__ == "__main__":
    main()
