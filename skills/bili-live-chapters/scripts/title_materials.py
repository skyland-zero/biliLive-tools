# -*- coding: utf-8 -*-
"""
从一场的 <视频名>-分析/ 目录里，抽出一份"投稿标题素材"：
  场次归属（按开播时间算 MM.DD + 午/晚）+ 钩子候选（≤9字）+ 本场歌单 + 环节名 + 固定字段模板。
喂给《B站投稿标题规范.md》写标题用。

用法:
  python title_materials.py "<视频文件或名称>" [--analysis <分析目录>] [--chapters <章节.txt>]
      [--pinned <置顶评论.txt>] [--out <输出文件>]

说明：视频文件名形如 `2026-10-14 00-07-29-912 我来啦-合并-弹幕版.mp4`，开头那串就是开播时间。
"""
import argparse, datetime as dt, io, os, re, sys

# 素材里明确不要出现的东西（历史返工结论）
FORBID = ('赢一把', '50块', '块钱', '抽奖', '出货', '公爵', '1314', '刷屏', '大合唱',
          '不灵不灵', '八嘎', '晚安', '感谢')
# 本主播的差异化标签（规范第八节）
TAGS = ['虚拟主播', 'VUP', '录播']          # 其余用 --tags / --name / --guild 传进来


def parse_start(name):
    m = re.search(r'(\d{4})-(\d{2})-(\d{2})[ _](\d{2})-(\d{2})', name)
    if not m:
        return None
    y, mo, d, h, mi = (int(x) for x in m.groups())
    return dt.datetime(y, mo, d, h, mi)


def session_label(start):
    """按《B站投稿标题规范》第五节：以开播时间定归属日期，跨 00:00 算前一天的晚场"""
    if start is None:
        return None, None, '文件名里没解析到开播时间'
    h = start.hour
    note = ''
    if 12 <= h < 18:
        label, sess = start, '午'
    elif 18 <= h <= 23:
        label, sess = start, '晚'
    elif h < 6:
        label, sess = start - dt.timedelta(days=1), '晚'
        note = '凌晨场归属前一日；若前一日已发过「晚」场，改用「深夜」'
    else:
        label, sess = start, '午'
        note = '06:00-11:59 归属规则规范里没写，先按当日上午处理，需要就补进规范'
    return label, sess, note


def read(path):
    return io.open(path, encoding='utf-8').read() if path and os.path.exists(path) else ''


def parse_songs(text):
    """歌曲清单行：00:00:30 - 00:03:12  (162s, 5次命中)  Dear D(亲爱的告诉你) - 项睿娴"""
    songs, seen = [], set()
    for line in text.splitlines():
        if not re.match(r'^\s*\d{2}:\d{2}:\d{2}\s+-', line):
            continue
        parts = [p for p in re.split(r'\s{2,}', line.strip()) if p]
        if len(parts) < 2:
            continue
        last = parts[-1]
        name = last.rsplit(' - ', 1)[0].split(' - ')[0].strip()
        if name and name not in seen:
            seen.add(name)
            songs.append(name)
    return songs


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('video')
    ap.add_argument('--analysis', default='')
    ap.add_argument('--chapters', default='')
    ap.add_argument('--pinned', default='')
    ap.add_argument('--out', default='')
    ap.add_argument('--name', default='', help='主播名（写进标题模板）')
    ap.add_argument('--guild', default='', help='公会/频道名（写进标题模板）')
    ap.add_argument('--tags', default='', help='额外固定标签，逗号分隔')
    a = ap.parse_args()

    start = parse_start(os.path.basename(a.video))
    label, sess, note = session_label(start)
    date_str = f'{label.month}.{label.day:02d}' if label else '??.??'

    songs = parse_songs(read(os.path.join(a.analysis, '01-歌曲清单.txt')))
    chapters = [l.split(' ', 1)[1] for l in read(a.chapters).splitlines() if l.strip()]
    pinned = read(a.pinned)
    hooks = []
    for l in pinned.splitlines():
        if '🔥' not in l:
            continue
        for q in re.findall(r'"([^"]{4,})"', l):
            q = q.strip(' ,，')
            if any(k in q for k in FORBID):
                continue
            hooks.append((len(q), q, l.split(' ', 1)[0]))
    hooks.sort()

    out = []
    out.append('投稿标题素材（配合《B站投稿标题规范.md》使用）')
    out.append(f'视频：{os.path.basename(a.video)}')
    if start:
        out.append(f'开播时间：{start:%Y-%m-%d %H:%M} → 建议标注：{date_str}{sess} 录播')
    if note:
        out.append(f'  ⚠ {note}')
    out.append('')
    ident = f'【{a.name} {a.guild}】' if a.name else '【主播名 公会名】'
    out.append(f'回归放模板：{{钩子}}{ident}' + date_str + sess + ' 录播')
    out.append(f'钩子规则：≤9 字（9 + {len(ident)} 字 = {9 + len(ident)} 字，名字块压在列表可见区之内）')
    out.append('')
    out.append('== 钩子候选（来自本场高能点原话，字数小的优先）==')
    seen = set()
    for n, q, t in hooks:
        if q in seen:
            continue
        seen.add(q)
        out.append(f'  [{n:2d}字] {"✅可直接用" if n <= 9 else "需精简"}  {q}   ({t})')
    out.append('')
    out.append('== 歌名钩子候选（唱歌向：歌名前置吃搜索）==')
    for s in songs:
        out.append(f'  《{s}》')
    out.append('')
    out.append('== 本场环节名（聊天向钩子的来源）==')
    for c in chapters:
        out.append(f'  {c}')
    out.append('')
    out.append('== 固定标签 ==')
    extra = [x.strip() for x in a.tags.split(',') if x.strip()]
    out.append('  ' + ' '.join(TAGS + extra + [x for x in (a.name, a.guild) if x]))
    out.append('')
    out.append('== 注意 ==')
    out.append('  · 素材库里的歌单以本目录 01-歌曲清单.txt 为准（规范第八节那份是旧的，缺很多首）')
    out.append('  · 标题里不要出现：' + '、'.join(FORBID[:8]) + ' 这类词')
    out.append('  · 软信号（啦/呀/嘛/～）一条最多 2 个；`｜` 全角、`～` 全角、歌名用《》')

    text = '\n'.join(out) + '\n'
    if a.out:
        io.open(a.out, 'w', encoding='utf-8', newline='\n').write(text)
        print(f'写出 {a.out}（{len([c for c in text if not c.isspace()])} 字）')
    else:
        print(text)


if __name__ == '__main__':
    main()
