# -*- coding: utf-8 -*-
"""
Shazam 全片扫描：每 step 秒取 len 秒样本送 Shazam，得到"音乐地图"（哪一段在放什么歌）。
用来给直播回放定位歌名——比弹幕可靠：弹幕里的歌名往往只是"点歌请求"，不代表真的唱了。

用法:
  python shazam_scan.py <视频> --out D:\\asr\\logs\\scan.jsonl [--step 30] [--len 12] [--end 0]

输出 jsonl：{"t": 秒, "mmss": "hh:mm", "title": 歌名 或 null, "artist": 演唱者}
命中率经验值：室内/点歌多的一場约 70%；户外散步、环境噪音大的一场约 35%。
"""
import argparse, asyncio, json, os, subprocess, time

def parse_args():
    p = argparse.ArgumentParser()
    p.add_argument('media')
    p.add_argument('--out', required=True)
    p.add_argument('--step', type=int, default=30)
    p.add_argument('--len', type=int, default=12)
    p.add_argument('--end', type=float, default=0, help='0=整段')
    p.add_argument('--sleep', type=float, default=0.8)
    return p.parse_args()


def main():
    from shazamio import Shazam
    a = parse_args()
    dur = a.end
    if not dur:
        dur = float(subprocess.run(['ffprobe', '-v', 'error', '-show_entries', 'format=duration',
                                    '-of', 'default=nw=1:nk=1', a.media], capture_output=True, text=True).stdout.strip())
    tmp = os.path.join(os.environ.get('TEMP', '.'), 'shazam_probe.wav')

    async def run():
        sh = Shazam()
        n = hit = 0
        t0 = time.time()
        with open(a.out, 'w', encoding='utf-8') as f:
            for t in range(0, int(dur) - a.len, a.step):
                subprocess.run(['ffmpeg', '-v', 'error', '-ss', str(t), '-t', str(a.len), '-i', a.media,
                                '-vn', '-ac', '1', '-ar', '16000', '-y', tmp], check=True)
                title = artist = None
                for attempt in (1, 2):
                    try:
                        r = await sh.recognize(tmp)
                        tr = r.get('track')
                        if tr:
                            title, artist = tr.get('title'), tr.get('subtitle')
                        break
                    except Exception as e:
                        if attempt == 2:
                            artist = 'ERR:' + type(e).__name__
                        await asyncio.sleep(2)
                n += 1
                hit += 1 if title else 0
                rec = {'t': t, 'mmss': f"{t // 60:02d}:{t % 60:02d}", 'title': title, 'artist': artist}
                f.write(json.dumps(rec, ensure_ascii=False) + '\n')
                f.flush()
                print(f"  {rec['mmss']}  {title or '—'}  {artist or ''}", flush=True)
                await asyncio.sleep(a.sleep)
        print(f"\n完成：{hit}/{n} 命中，用时 {(time.time() - t0) / 60:.1f} 分钟 → {a.out}")

    asyncio.run(run())


if __name__ == '__main__':
    main()
