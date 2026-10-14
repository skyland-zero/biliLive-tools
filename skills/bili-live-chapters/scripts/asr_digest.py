# -*- coding: utf-8 -*-
"""
把 asr.jsonl 变成"能读的内容摘要"：过滤掉满屏的礼物致谢，按分钟聚合，
可选把 Shazam 扫出来的歌名以 ♪ 标在对应分钟上。给 AI/人做章节分析用。

用法:
  python asr_digest.py --asr D:\\asr\\out\\10-14w --songs D:\\asr\\logs\\scan_10-14.jsonl \
      --out D:\\asr\\out\\10-14w\\digest.txt [--per-min 1]
"""
import argparse, json, os, re, sys

# 礼物/致谢噪音：整句里这些词占比高就丢掉
NOISE = ('谢谢', '谢谢谢', '感谢', '欢迎', '虎粮', '虎亮', '虎狼', '情书', '留声机', '魔法书',
         '上上签', '灯牌', '大电视', '小资本', '魔法指环', '丘比特', '丘不下', '催不下', '超冲',
         '哥们', '哥的', '哥哥们', '宠粉', '礼物', '上头条', '秒榜', '守护', '比心', '小心心')
KEEP_HINT = ('歌', '唱', '点', '五子棋', '做饭', '菜', '连麦', 'PK', '下播', '团播', '观众',
             '弹幕', '怎么', '为什么', '你们', '我们', '觉得', '好吃', '土豆', '豆汁', '出差',
             '回国', '学校', '留学', '妈妈', '妹妹', '输', '赢')


KEEP_EXTRA = ()


def clean(text):
    """删掉句内的致谢小句，保留其它内容"""
    parts = re.split(r'[，,。！!？?]', text)
    keep = []
    for p in parts:
        p = p.strip()
        if not p:
            continue
        n = sum(p.count(k) for k in NOISE)
        if any(k in p for k in KEEP_EXTRA):
            if len(p) >= 4:
                keep.append(p)
            continue
        if n >= 1 and len(p) <= 14:          # 短的致谢句直接丢
            continue
        if n >= 2 and not any(k in p for k in KEEP_HINT):
            continue
        p = re.sub(r'(谢谢|感谢|欢迎)[^，。]{0,12}?(哥|姐|宝|宝宝|叔|总|爷|妹)(的)?', '', p)
        p = re.sub(r'^(谢谢|感谢|欢迎)[^，。]{0,20}', '', p)
        if len(p) >= 4:
            keep.append(p)
    return '，'.join(keep)


def load_songs(path):
    if not path or not os.path.exists(path):
        return []
    rows = [json.loads(l) for l in open(path, encoding='utf-8')]
    segs = []
    for r in rows:
        if not r.get('title'):
            continue
        name = re.sub(r'\s*[（(].*?[)）]', '', r['title']).strip()
        if segs and segs[-1]['name'] == name and r['t'] - segs[-1]['end'] <= 120:
            segs[-1]['end'] = r['t']
        else:
            segs.append({'name': name, 'raw': r['title'], 'start': r['t'], 'end': r['t'], 'artist': r.get('artist')})
    return [s for s in segs if s['end'] - s['start'] >= 30]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--asr', required=True, help='asr.jsonl 所在目录')
    ap.add_argument('--songs', default='', help='Shazam 扫描 jsonl（可选）')
    ap.add_argument('--out', required=True)
    ap.add_argument('--per-min', type=int, default=1, help='每几分钟聚合一行')
    ap.add_argument('--title-map', default='', help='歌名中文/社区叫法映射（json，格式见 build_analysis_docs.py）')
    ap.add_argument('--keep-words', default='', help='额外"别当致谢删掉"的词，逗号分隔（如主播所在地、常用梗）')
    a = ap.parse_args()

    global KEEP_EXTRA
    KEEP_EXTRA = tuple(x.strip() for x in a.keep_words.split(',') if x.strip())
    tmap = json.load(open(a.title_map, encoding='utf-8')) if a.title_map and os.path.exists(a.title_map) else {}
    rows = [json.loads(l) for l in open(os.path.join(a.asr, 'asr.jsonl'), encoding='utf-8')]
    songs = load_songs(a.songs)
    for s in songs:
        key = f"{s['raw']}|{s['artist']}"
        if key in tmap:
            s['name'] = tmap[key]
    step = 60 * a.per_min
    buckets = {}
    for r in rows:
        txt = clean(r['text'])
        if not txt:
            continue
        b = int(r['start'] // step) * a.per_min
        buckets.setdefault(b, []).append(txt)

    lines = []
    total_chars = 0
    for b in range(0, int(rows[-1]['end'] // 60) + 2, a.per_min):
        chunks = buckets.get(b, [])
        body = ' / '.join(chunks)
        mark = ''
        for s in songs:
            if s['start'] // 60 <= b <= s['end'] // 60:
                mark = f"  ♪♪ {s['name']}" + (f" - {s['artist']}" if s['artist'] else '')
                break
        if body or mark:
            total_chars += len(body)
            lines.append(f"{b // 60:02d}:{b % 60:02d}  {body}{mark}")

    with open(a.out, 'w', encoding='utf-8') as f:
        f.write('\n'.join(lines) + '\n')
    print(f"摘要 {len(lines)} 行 / 内容 {total_chars} 字 → {a.out}")
    print(f"歌名标注 {len(songs)} 段")


if __name__ == '__main__':
    main()
