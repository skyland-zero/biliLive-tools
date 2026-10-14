# -*- coding: utf-8 -*-
"""
把一场直播的分析产物整理成可读文档（放视频目录下 <视频名>-分析/）：
  00-分析报告.txt   概览 + 歌曲清单 + 统计 + 复现方法
  01-歌曲清单.txt   时间 → 歌名 / 演唱者（可传 --title-map 把 Shazam 的英文/拼音名换成中文）
  02-内容摘要.txt   ASR 摘要（过滤礼物致谢后，带 ♪ 歌名标注）
  03-语音转写.txt   完整转写（hh:mm:ss 逐句）
  原始数据/         asr.jsonl + shazam.jsonl（机器可读，供后续复用）

用法:
  python build_analysis_docs.py --video <视频> --asr-dir D:\\asr\\out\\10-14w \
      --scan D:\\asr\\logs\\scan_10-14.jsonl --outdir "<视频目录>/<视频名>-分析" \
      [--title-map titles.json] [--notes notes.txt]
"""
import argparse, collections, json, os, re, shutil, subprocess, time


def hms(t):
    t = int(t)
    return f"{t // 3600:02d}:{t % 3600 // 60:02d}:{t % 60:02d}"


def clean_title(t, artist, tmap):
    key = f"{t}|{artist}"
    if key in tmap:
        return tmap[key]
    if t in tmap:
        return tmap[t]
    return f"{t} - {artist}" if artist else t


def load_songs(scan, tmap, min_span=30):
    rows = [json.loads(l) for l in open(scan, encoding='utf-8')]
    segs = []
    for r in rows:
        if not r.get('title'):
            continue
        name = r['title']
        if segs and segs[-1]['raw'] == name and r['t'] - segs[-1]['end'] <= 150:
            segs[-1]['end'] = r['t'] + 12
            segs[-1]['hits'] += 1
        else:
            segs.append({'raw': name, 'artist': r.get('artist'), 'start': r['t'], 'end': r['t'] + 12, 'hits': 1})
    out = []
    for s in segs:
        if s['end'] - s['start'] >= min_span or s['hits'] >= 2:
            s['name'] = clean_title(s['raw'], s['artist'], tmap)
            out.append(s)
    return out, len(rows), sum(1 for r in rows if r.get('title'))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--video', required=True)
    ap.add_argument('--asr-dir', required=True)
    ap.add_argument('--scan', required=True)
    ap.add_argument('--outdir', required=True)
    ap.add_argument('--title-map', default='')
    ap.add_argument('--notes', default='', help='人工写的"关键发现"补充文档，会拼进报告')
    a = ap.parse_args()

    tmap = json.load(open(a.title_map, encoding='utf-8')) if a.title_map and os.path.exists(a.title_map) else {}
    os.makedirs(os.path.join(a.outdir, '原始数据'), exist_ok=True)

    songs, n_probe, n_hit = load_songs(a.scan, tmap)
    asr = [json.loads(l) for l in open(os.path.join(a.asr_dir, 'asr.jsonl'), encoding='utf-8')]
    dur = 0.0
    try:
        dur = float(subprocess.run(['ffprobe', '-v', 'error', '-show_entries', 'format=duration',
                                    '-of', 'default=nw=1:nk=1', a.video], capture_output=True, text=True).stdout.strip())
    except Exception:
        pass
    cov = sum(r['end'] - r['start'] for r in asr)
    music = sum(s['end'] - s['start'] for s in songs)

    # 01 歌曲清单
    lines = [f"歌曲清单（Shazam 全片扫描；探针 {n_probe} 次，命中 {n_hit} 次）",
             f"视频：{os.path.basename(a.video)}", ""]
    for s in songs:
        lines.append(f"{hms(s['start'])} - {hms(s['end'])}  ({int(s['end'] - s['start'])}s, {s['hits']}次命中)  {s['name']}")
    lines += ["", "说明：秒数精确到扫描步长（10-14 为 30s、10-12 为 60s）；标注 ? 的表示标题/演唱者待人工确认。"]
    open(os.path.join(a.outdir, '01-歌曲清单.txt'), 'w', encoding='utf-8').write('\n'.join(lines) + '\n')

    shutil.copy(os.path.join(a.asr_dir, 'asr_1min.txt'), os.path.join(a.outdir, '02-内容摘要-每分钟.txt')) \
        if os.path.exists(os.path.join(a.asr_dir, 'asr_1min.txt')) else None
    dg = os.path.join(a.asr_dir, 'digest.txt')
    if os.path.exists(dg):
        shutil.copy(dg, os.path.join(a.outdir, '02-内容摘要.txt'))
    shutil.copy(os.path.join(a.asr_dir, 'asr.txt'), os.path.join(a.outdir, '03-语音转写.txt'))
    for f in ('asr.jsonl', 'asr.txt'):
        shutil.copy(os.path.join(a.asr_dir, f), os.path.join(a.outdir, '原始数据', f))
    shutil.copy(a.scan, os.path.join(a.outdir, '原始数据', 'shazam.jsonl'))

    # 00 分析报告
    rep = [f"直播分析报告",
           f"视频：{os.path.basename(a.video)}",
           f"时长：{hms(dur)}（{dur:.0f} 秒）",
           f"生成：{time.strftime('%Y-%m-%d %H:%M')}",
           "",
           "== 分析方法（可复现） ==",
           "语音转写：sherpa-onnx + SenseVoice-Small(int8) + silero-VAD，固定 20 秒窗口，CPU 8 线程，约 15 倍实时",
           "音乐识别：Shazam（shazamio）全片扫描，每 30~60 秒取 12 秒样本",
           "辅助信号：虎牙弹幕 XML、音频能量/节拍特征、抽帧画面",
           "",
           "== 统计 ==",
           f"转写句数：{len(asr)} 句，覆盖 {cov / 60:.1f} 分钟（视频的 {cov / max(dur, 1) * 100:.0f}%）",
           f"识别到音乐：{len(songs)} 段，合计约 {music / 60:.0f} 分钟（视频的 {music / max(dur, 1) * 100:.0f}%）",
           "",
           "== 歌曲清单 =="] + [f"  {hms(s['start'])}  {s['name']}" for s in songs] + [""]
    rep += ["== 文件说明 ==",
            "  00-分析报告.txt   本文件",
            "  01-歌曲清单.txt   时间 → 歌名/演唱者（含命中次数）",
            "  02-内容摘要.txt   过滤礼物致谢后的每分钟内容（♪ 标注当时在放的歌）",
            "  02-内容摘要-每分钟.txt  未过滤的每分钟聚合",
            "  03-语音转写.txt   完整逐句转写（hh:mm:ss）",
            "  原始数据/         asr.jsonl（句级时间戳）+ shazam.jsonl（扫描原始结果）"]
    if a.notes and os.path.exists(a.notes):
        rep += ["", "== 关键发现（人工整理） ==", open(a.notes, encoding='utf-8').read().rstrip()]
    open(os.path.join(a.outdir, '00-分析报告.txt'), 'w', encoding='utf-8').write('\n'.join(rep) + '\n')

    print(f"输出目录：{a.outdir}")
    for f in sorted(os.listdir(a.outdir)):
        p = os.path.join(a.outdir, f)
        print(f"  {'[dir]' if os.path.isdir(p) else '     '} {f:26s} "
              + ('' if os.path.isdir(p) else f"{os.path.getsize(p)/1024:.0f} KB"))


if __name__ == '__main__':
    main()
