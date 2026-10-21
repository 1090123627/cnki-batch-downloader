#!/usr/bin/env python3
"""知网点选验证码本地识别服务（ddddocr）
接口: POST /solve  {"image": "<base64 png>", "words": ["成","第","百"]}
返回: {"success": true, "points": [[x,y],...], "detail": [...], "chars": "..."}
"""
import base64, io, json, sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import ddddocr
import numpy as np
import cv2
from PIL import Image

det = ddddocr.DdddOcr(det=True, ocr=False, show_ad=False)
ocr = ddddocr.DdddOcr(ocr=True, det=False, show_ad=False)


def solve(img_bytes, words):
    img = Image.open(io.BytesIO(img_bytes)).convert('RGB')
    W, H = img.size
    boxes = det.detection(img_bytes)
    cands = []
    for b in boxes:
        x1, y1, x2, y2 = [int(v) for v in b]
        pad = 2
        crop = img.crop((max(0, x1 - pad), max(0, y1 - pad), min(W, x2 + pad), min(H, y2 + pad)))
        buf = io.BytesIO()
        crop.save(buf, 'PNG')
        try:
            ch = ocr.classification(buf.getvalue()).strip()
        except Exception:
            ch = ''
        cands.append({'char': ch, 'cx': (x1 + x2) / 2.0, 'cy': (y1 + y2) / 2.0,
                      'box': [x1, y1, x2, y2], 'w': x2 - x1, 'h': y2 - y1})

    used, points = set(), []
    for w in words:
        idx = None
        # 1) 完全相等
        for i, c in enumerate(cands):
            if i not in used and c['char'] == w:
                idx = i
                break
        # 2) 包含关系
        if idx is None:
            for i, c in enumerate(cands):
                if i in used and c['char']:
                    continue
                if c['char'] and (w in c['char'] or c['char'] in w):
                    idx = i
                    break
        if idx is None:
            return {'success': False, 'reason': 'word not found: ' + w,
                    'points': points, 'detail': cands}
        used.add(idx)
        points.append([round(cands[idx]['cx'], 1), round(cands[idx]['cy'], 1)])
    return {'success': True, 'points': points, 'detail': cands,
            'chars': ''.join(c['char'] for c in cands), 'size': [W, H]}


def _piece_parts(target_bytes):
    """解码拼图块，返回 (内容, 不透明mask, 裁剪后的内容, 裁剪后的mask)"""
    import numpy as np
    import cv2
    tg = cv2.imdecode(np.frombuffer(target_bytes, np.uint8), cv2.IMREAD_UNCHANGED)
    if tg is None:
        return None
    if tg.ndim == 3 and tg.shape[2] == 4:
        p = tg[:, :, :3].astype(float)
        a = tg[:, :, 3] > 128
    else:
        p = tg[:, :, :3].astype(float) if tg.ndim == 3 else tg.astype(float)[..., None]
        a = np.ones(tg.shape[:2], bool)
    ys = np.where(a.any(axis=1))[0]
    xs = np.where(a.any(axis=0))[0]
    if len(ys) == 0 or len(xs) == 0:
        return None
    return p, a, p[ys.min():ys.max() + 1, xs.min():xs.max() + 1], a[ys.min():ys.max() + 1, xs.min():xs.max() + 1], int(xs.min()), int(ys.min())


def detect_gray_holes(bgi, piece_mask):
    """新版知网拼图：缺口在背景里是一块「纯灰色剪影」（三通道接近、内部平坦、比周围暗）。
    找出所有这样的候选块，再按与拼图块的形状 IoU 排序。"""
    import numpy as np
    import cv2
    gray = cv2.cvtColor(bgi, cv2.COLOR_BGR2GRAY)
    med = cv2.medianBlur(gray, 31)          # 局部背景亮度
    diff = cv2.subtract(med, gray)          # 比周围暗多少
    m = (diff > 35).astype(np.uint8)
    m = cv2.morphologyEx(m, cv2.MORPH_OPEN, np.ones((3, 3), np.uint8))    # 去噪点（不要用闭运算：会把剪影和暗背景粘成一片）
    lap = np.abs(cv2.Laplacian(gray, cv2.CV_32F))    # 纹理强度：剪影内部平坦、照片内容有纹理
    n, lab, stats, _ = cv2.connectedComponentsWithStats(m, 8)
    out = []
    for i in range(1, n):
        x, y, w, h, area = stats[i]
        if not (150 < area < 2500 and 20 < w < 70 and 20 < h < 70):
            continue
        sel = lab[y:y + h, x:x + w] == i
        inner = cv2.erode(sel.astype(np.uint8), np.ones((5, 5), np.uint8)) > 0   # 内缩 2 像素再判平坦
        if inner.sum() < 20:
            continue
        if lap[y:y + h, x:x + w][inner].mean() > 12:
            continue
        bgr = bgi[y:y + h, x:x + w].astype(float)
        ch = [bgr[..., k][sel].mean() for k in range(3)]
        if max(ch) - min(ch) > 16:      # 彩色暗块＝图像内容，不是剪影
            continue
        best = 0.0
        for s in (0.85, 0.9, 0.95, 1.0, 1.05, 1.1):
            pw = max(6, int(piece_mask.shape[1] * s))
            ph2 = max(6, int(piece_mask.shape[0] * s))
            pm = cv2.resize(piece_mask.astype(np.uint8) * 255, (pw, ph2), interpolation=cv2.INTER_AREA) > 127
            for dy in range(-5, 6):
                for dx in range(-5, 6):
                    if dx < 0 or dy < 0 or dy + ph2 > h or dx + pw > w:
                        continue
                    win = sel[dy:dy + ph2, dx:dx + pw]
                    u = (pm | win).sum()
                    if u:
                        best = max(best, (pm & win).sum() / u)
        out.append({'x': int(x), 'y': int(y), 'w': int(w), 'h': int(h), 'area': int(area), 'iou': round(best, 3)})
    out.sort(key=lambda c: -c['iou'])
    return out


def solve_slide(target_bytes, bg_bytes):
    """拼图滑块：用最小二乘亮度比例残差找缺口位置
    依据：背景图在缺口处是原图内容被压暗（约 0.78 倍），因此 bg ≈ k*piece 处即为缺口
    """
    import numpy as np
    import cv2
    tg = cv2.imdecode(np.frombuffer(target_bytes, np.uint8), cv2.IMREAD_UNCHANGED)
    bgi = cv2.imdecode(np.frombuffer(bg_bytes, np.uint8), cv2.IMREAD_COLOR)
    if tg is None or bgi is None:
        return {'error': 'decode failed'}
    if tg.shape[2] == 4:
        p = tg[:, :, :3].astype(float)
        a = tg[:, :, 3] > 128
    else:
        p = tg.astype(float)
        a = np.ones(tg.shape[:2], bool)
    # 裁掉透明边，只保留拼图块
    ys = np.where(a.any(axis=1))[0]
    xs = np.where(a.any(axis=0))[0]
    if len(ys) == 0 or len(xs) == 0:
        return {'error': 'empty piece'}
    p_c = p[ys.min():ys.max() + 1, xs.min():xs.max() + 1]
    a_c = a[ys.min():ys.max() + 1, xs.min():xs.max() + 1]
    ph, pw = p_c.shape[:2]
    bgf = bgi.astype(float)
    H, W = bgf.shape[:2]
    if ph > H or pw > W:
        return {'error': 'piece bigger than background'}
    scores = []
    for y in range(0, H - ph + 1):
        for x in range(0, W - pw + 1):
            b = bgf[y:y + ph, x:x + pw][a_c]
            q = p_c[a_c]
            denom = (q * q).sum()
            if denom <= 0:
                continue
            k = (b * q).sum() / denom
            if k <= 0.2 or k > 1.6:
                scores.append((1e9, x, y, k))
                continue
            resid = np.abs(b - k * q).mean()
            scores.append((resid, x, y, k))
    cands = []
    holes = detect_gray_holes(bgi, a_c)
    for hle in holes[:3]:
        cands.append({'x': hle['x'], 'y': hle['y'], 'score': hle['iou'], 'method': 'shape', 'iou': hle['iou']})
    resid_cand = None
    if scores:
        scores.sort(key=lambda s: s[0])
        best = scores[0]
        second = scores[len(scores) // 10][0]
        resid_cand = {'x': best[1], 'y': best[2], 'k': round(best[3], 3),
                      'resid': round(best[0], 2), 'margin': round(second - best[0], 2),
                      'method': 'resid', 'score': round(second - best[0], 2)}
    # 新版知网拼图的缺口是纯灰剪影：形状匹配对得上就优先用它；否则回退到亮度残差法
    shape_first = bool(holes) and holes[0]['iou'] >= 0.5
    if resid_cand:
        if shape_first:
            cands.append(resid_cand)
        else:
            cands.insert(0, resid_cand)
    if not cands:
        return {'error': 'no candidate'}
    first = cands[0]
    out = {'success': True, 'x': first['x'], 'y': first.get('y', 0),
           'piece_box': [int(xs.min()), int(ys.min()), pw, ph],
           'candidates': cands[:5], 'holes': holes[:5], 'shape_first': shape_first}
    if resid_cand:
        out.update({'k': resid_cand['k'], 'resid': resid_cand['resid'], 'margin': resid_cand['margin']})
    return out


def _tc_piece_crop(fg_bytes, fg_css=None):
    """按 CSS 的 background-position/size 从精灵图里裁出「真正显示」的那块拼图。
    腾讯的拼图块图是 sprite，直接取最大方块会裁错（这是之前找不到缺口的原因）。"""
    arr = np.frombuffer(fg_bytes, np.uint8)
    im = cv2.imdecode(arr, cv2.IMREAD_UNCHANGED)
    if im is None:
        raise ValueError('fg decode failed')
    H, W = im.shape[:2]
    if not fg_css:
        return None
    try:
        bsw, bsh = fg_css.get('bsize') or [0, 0]
        bpx, bpy = fg_css.get('bpos') or [0, 0]
        cw, ch = fg_css.get('w') or 0, fg_css.get('h') or 0
    except Exception:
        return None
    if not (bsw and cw):
        return None
    sx = W / float(bsw)                     # sprite 原始像素 / CSS 背景尺寸
    sy = H / float(bsh or bsw)
    x0 = int(round(-bpx * sx)); y0 = int(round(-bpy * sy))
    x1 = int(round(x0 + cw * sx)); y1 = int(round(y0 + ch * sy))
    x0c, y0c = max(0, x0), max(0, y0)
    x1c, y1c = min(W, x1), min(H, y1)
    if x1c - x0c < 20 or y1c - y0c < 20:
        return None
    return im[y0c:y1c, x0c:x1c]


def _tc_piece_mask(fg_bytes, fg_css=None):
    """拼图块剪影 mask：优先按 CSS 几何裁 sprite，裁不出再退回连通块启发式"""
    crop = _tc_piece_crop(fg_bytes, fg_css)
    arr = np.frombuffer(fg_bytes, np.uint8)
    im = cv2.imdecode(arr, cv2.IMREAD_UNCHANGED)
    if im is None:
        raise ValueError('fg decode failed')
    if crop is not None:
        piece = crop
        if piece.ndim == 3 and piece.shape[2] == 4:
            alpha = piece[:, :, 3]
        else:
            g2 = cv2.cvtColor(piece, cv2.COLOR_BGR2GRAY) if piece.ndim == 3 else piece
            alpha = (g2 > 20).astype(np.uint8) * 255
        m = (alpha > 128).astype(np.uint8)
        if m.sum() > 200:
            return piece, m, 'css'
    return _tc_piece_mask_heuristic(im)


def _tc_piece_mask_heuristic(im):
    if im.ndim == 3 and im.shape[2] == 4:
        alpha = im[:, :, 3]
    else:
        g = cv2.cvtColor(im, cv2.COLOR_BGR2GRAY) if im.ndim == 3 else im
        alpha = (g > 20).astype(np.uint8) * 255
    m = (alpha > 200).astype(np.uint8)
    n, lab, stats, _ = cv2.connectedComponentsWithStats(m, 8)
    best = None
    for i in range(1, n):
        x, y, w, h, area = stats[i]
        if area < 400 or w < 20 or h < 20:
            continue
        fill = area / float(w * h)
        ar = w / float(h)
        if not (0.6 <= ar <= 1.7):
            continue
        score = area * (1.0 - abs(1.0 - ar) * 0.4) * (1.0 if 0.55 <= fill <= 0.97 else 0.4)
        if best is None or score > best[0]:
            best = (score, x, y, w, h)
    if best is None:
        i = int(np.argmax(stats[1:, 4])) + 1
        x, y, w, h, _ = stats[i]
    else:
        _, x, y, w, h = best
    return im[y:y + h, x:x + w], m[y:y + h, x:x + w], 'heuristic'


def tc_slide(bg_bytes, fg_bytes, fg_css=None):
    """腾讯（Turing）滑块：拼图块剪影在背景图上滑动，取「剪影内模板最匹配」的位置。
    返回缺口中心（背景图原始像素坐标）。"""
    piece, mask, how = _tc_piece_mask(fg_bytes, fg_css)
    ph, pw = mask.shape[:2]
    arr = np.frombuffer(bg_bytes, np.uint8)
    bg = cv2.imdecode(arr, cv2.IMREAD_COLOR)
    if bg is None:
        raise ValueError('bg decode failed')
    H, W = bg.shape[:2]
    # 拼图块在图中的实际尺寸 = (块显示宽 / 背景显示宽) × 背景原始宽
    ratio = 0.0
    if fg_css and fg_css.get('w') and fg_css.get('bg_cw'):
        ratio = float(fg_css['w']) / float(fg_css['bg_cw'])
    if ratio <= 0:
        ratio = (pw / 80.0) * (1.0 / 5.6)          # 兜底：80px 块 ≈ 330/1680
    mw = int(round(ratio * W))
    mh = int(round(mw * ph / max(pw, 1)))
    if mw < 20 or mw >= W or mh >= H:
        mw, mh = min(W - 1, max(20, int(W * 0.18))), min(H - 1, max(20, int(H * 0.18)))
    return _tc_match(bg, piece, mask, mw, mh, how)


def _tc_match(bg, piece, mask, mw, mh, how):
    H, W = bg.shape[:2]
    m2 = cv2.resize(mask.astype(np.uint8) * 255, (mw, mh), interpolation=cv2.INTER_NEAREST) > 128
    m2 = cv2.erode(m2.astype(np.uint8), np.ones((5, 5), np.uint8)) > 0
    if m2.sum() < 60:
        return {'success': False, 'error': 'piece too small', 'how': how}
    P = cv2.cvtColor(cv2.resize(piece[:, :, :3] if piece.ndim == 3 else cv2.cvtColor(piece, cv2.COLOR_GRAY2BGR), (mw, mh)), cv2.COLOR_BGR2GRAY).astype(np.float32)
    B = cv2.cvtColor(bg, cv2.COLOR_BGR2GRAY).astype(np.float32)
    ker = m2.astype(np.float32)
    n = float(ker.sum())
    SB = cv2.filter2D(B, -1, ker, borderType=cv2.BORDER_REPLICATE) / n
    SB2 = cv2.filter2D(B * B, -1, ker, borderType=cv2.BORDER_REPLICATE) / n
    varB = np.maximum(SB2 - SB ** 2, 1e-6)
    Pm = P * ker
    mP = float(Pm.sum() / n)
    varP = max(float((P * P * ker).sum() / n - mP ** 2), 1e-6)
    SPB = cv2.filter2D(B, -1, Pm[::-1, ::-1].copy(), borderType=cv2.BORDER_REPLICATE) / n
    ncc = (SPB - SB * mP) / np.sqrt(varB * varP)
    padx, pady = mw, mh
    valid = np.zeros((H, W), bool)
    valid[pady:H - pady, padx:W - padx] = True
    if valid.sum() < 100:
        valid[:] = True
    ncc = np.where(valid, ncc, -9.0)
    y, x = np.unravel_index(np.argmax(ncc), ncc.shape)
    cx, cy = int(x + mw // 2), int(y + mh // 2)
    return {
        'success': True, 'x': cx, 'y': cy,
        'gap_center_x': cx, 'gap_center_y': cy,
        'top_left': [int(x), int(y)], 'mask_w': int(mw), 'mask_h': int(mh),
        'nat_w': int(W), 'nat_h': int(H), 'ncc': float(ncc[y, x]), 'score': float(ncc[y, x]),
        'how': how,
    }


class H(BaseHTTPRequestHandler):
    def _send(self, obj, code=200):
        body = json.dumps(obj, ensure_ascii=False,
                          default=lambda o: o.item() if hasattr(o, 'item') else str(o)).encode()
        self.send_response(code)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        self._send({'status': 'ok', 'engine': 'ddddocr'})

    def do_POST(self):
        if self.path == '/tcslide':
            try:
                n = int(self.headers.get('Content-Length', 0))
                req = json.loads(self.rfile.read(n) or b'{}')
                def dec2(s):
                    s = s or ''
                    if ',' in s:
                        s = s.split(',', 1)[1]
                    return base64.b64decode(s)
                self._send(tc_slide(dec2(req['background']), dec2(req['target']), req.get('fg_css')))
            except Exception as e:
                self._send({'error': str(e)}, 500)
            return
        if self.path == '/slide':
            try:
                n = int(self.headers.get('Content-Length', 0))
                req = json.loads(self.rfile.read(n) or b'{}')
                def dec(s):
                    s = s or ''
                    if ',' in s:
                        s = s.split(',', 1)[1]
                    return base64.b64decode(s)
                self._send(solve_slide(dec(req['target']), dec(req['background'])))
            except Exception as e:
                self._send({'error': str(e)}, 500)
            return
        if self.path != '/solve':
            return self._send({'error': 'not found'}, 404)
        try:
            n = int(self.headers.get('Content-Length', 0))
            req = json.loads(self.rfile.read(n) or b'{}')
            b64 = req['image']
            if ',' in b64:
                b64 = b64.split(',', 1)[1]
            img = base64.b64decode(b64)
            words = req.get('words') or []
            res = solve(img, words)
            res['words'] = words
            self._send(res)
        except Exception as e:
            self._send({'error': str(e)}, 500)

    def log_message(self, *a):
        pass


if __name__ == '__main__':
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 9898
    print(f'ddddocr solver listening on 127.0.0.1:{port}', flush=True)
    ThreadingHTTPServer(('127.0.0.1', port), H).serve_forever()
