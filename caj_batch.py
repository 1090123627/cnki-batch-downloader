#!/usr/bin/env python3
"""批量把 CAJ 转 PDF 并质检（页数、内嵌图像字节）。

用法:
    python3 caj_batch.py --src DIR --out DIR [--caj2pdf DIR] [--python PY] [--report FILE]

依赖:
    - caj2pdf (https://github.com/JeziL/caj2pdf) —— 用于实际转换
    - poppler-utils（pdfinfo / pdfimages）
判定标准:
    每页内嵌图像平均 > 20KB 视为正常扫描件；否则标记 bad，便于人工复核。
"""
import argparse
import glob
import json
import re
import subprocess
from pathlib import Path


def image_bytes(pdf):
    try:
        out = subprocess.run(['pdfimages', '-list', str(pdf)], capture_output=True, text=True, timeout=60).stdout
    except Exception:
        return -1, -1
    total, n = 0, 0
    for line in out.splitlines()[2:]:
        parts = line.split()
        if len(parts) >= 14:
            m = re.match(r'([\d.]+)([KMB]?)', parts[-2])
            if m:
                total += float(m.group(1)) * {'': 1, 'K': 1024, 'M': 1024 ** 2, 'B': 1}[m.group(2)]
                n += 1
    return total, n


def main() -> int:
    ap = argparse.ArgumentParser(description="批量 CAJ→PDF 并质检")
    ap.add_argument('--src', required=True, help='含 .caj 的原始目录（递归扫描）')
    ap.add_argument('--out', required=True, help='PDF 输出目录')
    ap.add_argument('--caj2pdf', default='./caj2pdf', help='caj2pdf 仓库目录（默认 ./caj2pdf）')
    ap.add_argument('--python', default='python3', help='运行 caj2pdf 的 Python（需装依赖）')
    ap.add_argument('--report', default='caj_convert_report.json', help='质检报告输出路径')
    a = ap.parse_args()

    src, out = Path(a.src), Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    files = sorted(glob.glob(str(src / '**' / '*.caj'), recursive=True))
    print(f'CAJ 文件 {len(files)} 个')

    rows = []
    for f in files:
        name = Path(f).stem
        dest = out / (name + '.pdf')
        r = subprocess.run([a.python, 'caj2pdf', 'convert', f, '-o', str(dest)],
                           cwd=a.caj2pdf, capture_output=True, text=True, timeout=300)
        ok = dest.exists() and dest.stat().st_size > 2000
        ib, _ = image_bytes(dest) if ok else (0, 0)
        pages = 0
        if ok:
            try:
                pages = int(re.search(r'Pages:\s+(\d+)', subprocess.run(
                    ['pdfinfo', str(dest)], capture_output=True, text=True, timeout=30).stdout).group(1))
            except Exception:
                pages = 0
        good = ok and pages > 0 and (ib / max(pages, 1)) > 20000
        rows.append({'file': f, 'pdf': str(dest), 'ok': ok, 'pages': pages,
                     'img_bytes': round(ib), 'good': good,
                     'err': ((r.stderr or '').strip().splitlines() or [''])[-1][:150] if not ok else ''})
        print(('OK  ' if good else 'BAD ') + f'{name[:42]:44s} pages={pages} img={ib / 1024:.0f}KB')

    json.dump(rows, open(a.report, 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
    good = sum(1 for r in rows if r['good'])
    print(f'\n合计 {len(rows)}，可用 {good}，异常 {len(rows) - good}')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
