# -*- coding: utf-8 -*-
"""
用 sherpa-onnx + SenseVoice-Small(int8) + silero-VAD 把整场直播转写成带时间戳的文本。
纯 CPU，实测 8 核约 15~30 倍实时（2 小时视频 ≈ 5~10 分钟）。

用法:
  python asr_transcribe.py <视频/音频> --outdir <输出目录> [--start 0] [--duration 0]
      [--model-dir D:\\asr\\models] [--threads 8] [--mode window|vad] [--window 20]

默认用固定窗口切分（mode=window）。VAD 在连续说话时会把几分钟并成一块，
SenseVoice 超过 30 秒会明显退化，所以除非要精确句边界，别用 vad 模式。

输出（放 --outdir）:
  asr.jsonl      {"start": 秒, "end": 秒, "text": "..."} 每句一行
  asr.txt        hh:mm:ss  文本
  asr_1min.txt   每分钟聚合，给 AI/人快速扫读用（章节分析主要看这份）
"""
import argparse, json, os, subprocess, sys, time

SR = 16000


def parse_args():
    p = argparse.ArgumentParser()
    p.add_argument('media')
    p.add_argument('--outdir', required=True)
    p.add_argument('--start', type=float, default=0.0)
    p.add_argument('--duration', type=float, default=0.0, help='0=整段')
    p.add_argument('--model-dir', default=os.environ.get(
        'ASR_MODEL_DIR', os.path.join(os.environ.get('BILI_ASR_HOME', r'D:\asr'), 'models')))
    p.add_argument('--threads', type=int, default=8)
    p.add_argument('--max-seg', type=float, default=20.0, help='VAD 模式下单句最长秒数')
    p.add_argument('--mode', default='window', choices=['window', 'vad'])
    p.add_argument('--window', type=float, default=20.0, help='window 模式的切窗秒数')
    p.add_argument('--language', default='zh')
    return p.parse_args()


def hms(t):
    t = int(t)
    return f"{t // 3600:02d}:{t % 3600 // 60:02d}:{t % 60:02d}"


def main():
    a = parse_args()
    import numpy as np
    import sherpa_onnx

    os.makedirs(a.outdir, exist_ok=True)
    t_start = time.time()

    rec = sherpa_onnx.OfflineRecognizer.from_sense_voice(
        model=os.path.join(a.model_dir, 'model.int8.onnx'),
        tokens=os.path.join(a.model_dir, 'tokens.txt'),
        num_threads=a.threads, use_itn=True, language=a.language, debug=False)

    cfg = sherpa_onnx.VadModelConfig()
    cfg.silero_vad.model = os.path.join(a.model_dir, 'silero_vad.onnx')
    cfg.silero_vad.threshold = 0.5
    cfg.silero_vad.min_silence_duration = 0.5
    cfg.silero_vad.min_speech_duration = 0.25
    cfg.silero_vad.max_speech_duration = a.max_seg
    cfg.sample_rate = SR
    vad = sherpa_onnx.VoiceActivityDetector(cfg, buffer_size_in_seconds=600)

    cmd = ['ffmpeg', '-v', 'error']
    if a.start:
        cmd += ['-ss', str(a.start)]
    cmd += ['-i', a.media]
    if a.duration:
        cmd += ['-t', str(a.duration)]
    cmd += ['-vn', '-ac', '1', '-ar', str(SR), '-f', 'f32le', '-']
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, bufsize=10 ** 7)

    # 先探时长用于进度显示
    dur = a.duration
    try:
        probe = subprocess.run(['ffprobe', '-v', 'error', '-show_entries', 'format=duration',
                                '-of', 'default=nw=1:nk=1', a.media], capture_output=True, text=True)
        total = float(probe.stdout.strip() or 0) - a.start
        dur = a.duration or total
    except Exception:
        pass

    rows, n, fed = [], 0, 0.0
    CH = SR * 10  # 每次喂 10 秒，内存友好
    buf = b''
    # window 模式：攒够 N 秒解一次；低于阈值(近似静音)的窗直接跳过
    win_len = int(SR * a.window)
    pending = np.zeros(0, dtype='float32')
    win_start = a.start
    RMS_SKIP = 0.0015  # ≈ -56dBFS

    def decode_block(x, st):
        nonlocal n
        if x.size < SR * 0.5:
            return
        if float(np.sqrt((x ** 2).mean())) < RMS_SKIP:
            return
        s = rec.create_stream()
        s.accept_waveform(SR, x)
        rec.decode_stream(s)
        txt = s.result.text.strip()
        if txt:
            rows.append({'start': round(st, 2), 'end': round(st + len(x) / SR, 2), 'text': txt})
            n += 1

    def flush_vad():
        nonlocal n
        while not vad.empty():
            seg = vad.front
            st = seg.start / SR + a.start
            decode_block(np.array(seg.samples, dtype='float32'), st)
            vad.pop()

    while True:
        chunk = proc.stdout.read(CH * 4)
        if not chunk:
            break
        buf += chunk
        usable = len(buf) - len(buf) % 4
        x = np.frombuffer(buf[:usable], dtype=np.float32).copy()
        buf = buf[usable:]
        if x.size == 0:
            continue
        if a.mode == 'vad':
            vad.accept_waveform(x)
            flush_vad()
        else:
            pending = np.concatenate([pending, x])
            while pending.size >= win_len:
                decode_block(pending[:win_len].copy(), win_start)
                pending = pending[win_len:]
                win_start += a.window
        fed += x.size / SR
        if int(fed) % 600 < 10:
            print(f"[{hms(a.start + fed)} / {hms(a.start + dur)}] 已转写 {n} 句, "
                  f"{fed / max(time.time() - t_start, 1e-9):.1f}× 实时", file=sys.stderr, flush=True)
    proc.wait()

    if a.mode == 'vad':
        vad.flush()
        flush_vad()
    elif pending.size:
        decode_block(pending.copy(), win_start)

    with open(os.path.join(a.outdir, 'asr.jsonl'), 'w', encoding='utf-8') as f:
        for r in rows:
            f.write(json.dumps(r, ensure_ascii=False) + '\n')
    with open(os.path.join(a.outdir, 'asr.txt'), 'w', encoding='utf-8') as f:
        for r in rows:
            f.write(f"{hms(r['start'])}  {r['text']}\n")
    mins = {}
    for r in rows:
        mins.setdefault(int(r['start'] // 60), []).append(r['text'])
    with open(os.path.join(a.outdir, 'asr_1min.txt'), 'w', encoding='utf-8') as f:
        for m in sorted(mins):
            f.write(f"{m // 60:02d}:{m % 60:02d}  " + ' '.join(mins[m]) + '\n')

    el = time.time() - t_start
    print(f"\n完成：{n} 句 / 音频 {fed:.0f}s / 耗时 {el / 60:.1f} 分钟 = {fed / max(el, 1e-9):.1f}× 实时")
    print(f"输出：{a.outdir}")


if __name__ == '__main__':
    main()
