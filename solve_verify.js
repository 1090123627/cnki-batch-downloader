// 知网验证码自动通过（ddddocr 本地服务）：点选文字 + 拼图滑块
// 用法: node solve_verify.js <profile> [次数]
const { chromium } = require('playwright');
const fs = require('fs');

const EXEC = process.env.CHROME_PATH || '';
const SOLVER = process.env.SOLVER_URL || 'http://127.0.0.1:9898';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function callSolver(imageB64, words) {
  const r = await fetch(SOLVER + '/solve', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ image: imageB64, words }),
  });
  return r.json();
}
async function callSlide(target, background) {
  const r = await fetch(SOLVER + '/slide', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ target, background }),
  });
  return r.json();
}

// 点选文字
async function solveClickWord(page, info) {
  const m = info.msg.match(/【([^】]+)】/);
  if (!m) return { ok: false, reason: 'no words: ' + info.msg.slice(0, 30) };
  const words = m[1].split(/[,，、\s]+/).filter(Boolean);
  const res = await callSolver(info.src, words);
  if (!res.success) return { ok: false, reason: 'ocr: ' + (res.reason || res.error), words, detail: res.detail };
  const [rx, ry, rw, rh] = info.rect;
  const sx = info.nat ? rw / info.nat[0] : 1, sy = info.nat ? rh / info.nat[1] : 1;
  for (const [x, y] of res.points) {
    await page.mouse.click(rx + x * sx, ry + y * sy);
    await sleep(240 + Math.random() * 280);
  }
  return { ok: null, words, points: res.points, chars: res.chars, kind: 'clickWord' };
}

// 拖动一次：按给定水平距离把滑块从起点拖到终点（带人类化轨迹）
async function dragSlider(page, move, dist) {
  const [mx, my, mw, mh] = move;
  const startX = mx + mw / 2, startY = my + mh / 2;
  await page.mouse.move(startX, startY);
  await sleep(120);
  await page.mouse.down();
  const steps = 22 + Math.floor(Math.random() * 8);
  for (let i = 1; i <= steps; i++) {
    const p = i / steps;
    const ease = 1 - Math.pow(1 - p, 2.2);
    await page.mouse.move(startX + dist * ease + (Math.random() - 0.5) * 1.5, startY + (Math.random() - 0.5) * 2);
    await sleep(12 + Math.random() * 22);
  }
  await sleep(180);
  await page.mouse.up();
}

// 判断验证是否已通过（验证面板消失即通过）
async function verifyPassed(page, waitMs = 3200) {
  await sleep(waitMs);
  const st = await page.evaluate(() => ({
    url: location.href,
    hasPanel: !!document.querySelector('.verify-img-panel img'),
    msg: (document.querySelector('.verify-msg') || {}).innerText || '',
  })).catch(() => ({ url: page.url(), hasPanel: false, msg: '' }));
  return { ok: !st.hasPanel && !/verify\//.test(st.url), url: (st.url || ''), msg: (st.msg || '').replace(/\s+/g, ' ').slice(0, 70) };
}

// 拼图滑块：新版知网的缺口是「纯灰剪影」，靠形状匹配定位；同时保留亮度残差候选，逐个试
async function solveSlide(page, info) {
  if (!info.piece || !info.src) return { ok: false, reason: 'no piece/background', kind: 'slide' };
  const res = await callSlide(info.piece, info.src);
  if (!res || res.error || typeof res.x !== 'number') {
    return { ok: false, reason: 'slide solver: ' + (res && (res.error || 'bad')), kind: 'slide' };
  }
  if (!info.move) return { ok: false, reason: 'no move block', kind: 'slide' };
  const scale = info.rect && info.nat ? info.rect[2] / info.nat[0] : 1;
  const off = res.piece_box ? res.piece_box[0] : 0;
  const list = (res.candidates && res.candidates.length) ? res.candidates : [{ x: res.x, method: 'resid' }];
  const cands = list
    .map(c => ({ method: c.method || '?', score: c.score, dist: Math.max(0, Math.round((c.x - off) * scale)) }))
    .filter((c, i, a) => c.dist > 0 && a.findIndex(z => Math.abs(z.dist - c.dist) <= 4) === i)
    .slice(0, 4);
  const tried = [];
  for (const c of cands) {
    await dragSlider(page, info.move, c.dist);
    tried.push(c.dist);
    const st = await verifyPassed(page);
    if (st.ok) return { ok: true, kind: 'slide', dist: c.dist, method: c.method, tried, reason: st.msg };
    const info2 = await pageCaptchaInfo(page).catch(() => null);
    if (!info2 || !info2.src || info2.src !== info.src) {
      return { ok: false, kind: 'slide', dist: c.dist, tried, refreshed: true, reason: st.msg || 'captcha refreshed' };
    }
    await sleep(700);
  }
  // 没解出来：把这张验证码的原图和几何信息存下来，便于事后分析（哪种题型、缺口真在哪）
  try {
    const dir = process.env.CAPTCHA_DEBUG_DIR || 'captcha_samples/fail';
    require('fs').mkdirSync(dir, { recursive: true });
    const tag = Date.now();
    const dec = (s) => Buffer.from((s || '').split(',').pop(), 'base64');
    require('fs').writeFileSync(`${dir}/bg_${tag}.png`, dec(info.src));
    if (info.piece) require('fs').writeFileSync(`${dir}/piece_${tag}.png`, dec(info.piece));
    require('fs').writeFileSync(`${dir}/info_${tag}.json`, JSON.stringify({ ...info, src: undefined, piece: undefined, solver: res, tried }, null, 1));
  } catch (e) {}
  return { ok: false, kind: 'slide', tried, reason: 'all candidates failed', holes: (res.holes || []).map(h => h.x), solver: (res.candidates || []).map(c => c.x + ':' + c.method) };
}

async function pageCaptchaInfo(page) {
  return page.evaluate(() => {
    const img = document.querySelector('.verify-img-panel img');
    const panel = document.querySelector('.verify-img-panel') || (img && img.parentElement);
    const pr = panel ? panel.getBoundingClientRect() : null;
    const sub = document.querySelector('.verify-sub-block');
    let piece = null;
    if (sub) {
      const im = sub.querySelector('img');
      const bgimg = getComputedStyle(sub).backgroundImage || '';
      piece = im && im.src ? im.src
        : (bgimg.startsWith('url(') ? bgimg.slice(5, -2).replace(/^["']|["']$/g, '') : null);
    }
    const move = document.querySelector('.verify-move-block');
    const mr = move ? move.getBoundingClientRect() : null;
    const msg = ((document.querySelector('.verify-msg') || {}).innerText || document.body.innerText || '').trim();
    return {
      src: img ? img.src : null,
      nat: img ? [img.naturalWidth, img.naturalHeight] : null,
      rect: pr ? [pr.x, pr.y, pr.width, pr.height] : null,
      piece,
      move: mr ? [mr.x, mr.y, mr.width, mr.height] : null,
      msg,
    };
  });
}

// 在验证页上执行一次识别（自动判别题型）
async function solveOnPage(page) {
  // 先认「登录态失效」的拦截页：这种页里腾讯组件永远离屏（rect=[15,-999955,188,0]）、文案是
  // 「拖动下方拼图完成验证」但状态卡在「验证错误,请重试」，等多久都没用，所以放在最前面判。
  const wallEarly = await page.evaluate(() => {
    const t = document.documentElement.textContent || '';
    if (!/重新登录下载|请重新登录|获取短信验证码|扫码验证/.test(t)) return '';
    return document.querySelector('#downSubmit,#phonereloadfresh,.phone-reload-title') ? 'login' : 'login?';
  }).catch(() => '');
  if (wallEarly) return { ok: false, kind: 'login', reason: '需重新登录（登录态失效/该资源要会员）' };
  // 腾讯（Turing）拼图滑块：下载拦截页 bar.cnki.net/bar/verify 用的是它。
  // 注意：知网页面默认内嵌了隐藏的腾讯验证容器，必须判「可见」而不是存在；
  // 闸门页刚打开时腾讯组件可能还没渲染出来（rect 是 [15,-999955,188,0]），所以要先等它出现。
  const tcVisible = () => page.evaluate(() => {
    const vis = (el) => {
      if (!el) return false;
      const r = el.getBoundingClientRect();
      if (r.width < 40 || r.height < 40 || r.top < -10000) return false;
      const cs = getComputedStyle(el);
      return cs.visibility !== 'hidden' && cs.display !== 'none' && cs.opacity !== '0';
    };
    return vis(document.querySelector('.tencent-captcha-dy__fg-item')) || vis(document.querySelector('.tencent-captcha-dy__verify-bg-img'));
  }).catch(() => false);
  let isTc = await tcVisible();
  // 等腾讯组件渲染（最多 ~20s）；期间每次若知网的 AJ 验证图「可见地」先出来就直接走 AJ
  for (let w = 0; w < 20 && !isTc; w++) {
    await sleep(1000);
    // 腾讯滑块常要一次真实鼠标动作才会渲染出来 —— 轻轻晃一下指针
    if (w % 5 === 4) {
      const vp = page.viewportSize() || { width: 1024, height: 768 };
      await page.mouse.move(vp.width / 2, vp.height / 2, { steps: 6 }).catch(() => {});
      await page.mouse.move(vp.width / 2 + 30, vp.height / 2 + 12, { steps: 4 }).catch(() => {});
    }
    isTc = await tcVisible();
    if (isTc) break;
    const early = await page.evaluate(() => {
      const el = document.querySelector('.verify-img-panel img, .verify-img-panel canvas');
      if (!el) return false;
      const r = el.getBoundingClientRect();
      return r.width >= 60 && r.height >= 60;
    }).catch(() => false);
    if (early) break;
  }
  if (isTc) return await solveTencent(page);
  // 登录态失效的拦截页：腾讯组件会卡在「验证错误,请重试」且永远离屏，怎么等都没用。
  // 早点认出来，别再拿 4 次 × 20 秒去撞。
  const wall = await page.evaluate(() => {
    const t = (document.documentElement.textContent || '') + ' ' + ((document.querySelector('.phone-reload-title,.wayText') || {}).textContent || '');
    const hit = /重新登录下载|请重新登录|获取短信验证码|扫码验证|账号登录|密码登录/.test(t);
    if (!hit) return '';
    return document.querySelector('#downSubmit,#phonereloadfresh,.phone-reload-title') ? 'login' : 'login?';
  }).catch(() => '');
  if (wall) return { ok: false, kind: 'login', reason: '需重新登录（登录态失效/该资源要会员）' };
  const info = await pageCaptchaInfo(page);
  if (!info.src) return { ok: false, reason: 'no captcha img' };
  const isSlide = /滑动/.test(info.msg) || info.move || info.piece;
  if (isSlide) return await solveSlide(page, info);
  const attempt = await solveClickWord(page, info);
  if (attempt.ok === false) return attempt;
  const st = await verifyPassed(page, 3200);
  return { ...attempt, ok: st.ok, reason: st.msg, url: st.url.slice(0, 90) };
}

// ── 腾讯（Turing）拼图滑块：出现在 bar.cnki.net 下载拦截页 ────────────────
// 结构：.tencent-captcha-dy__verify-bg-img（背景，缺口被抹平）
//       .tencent-captcha-dy__fg-item（拼图块，起始位置不在最左）
//       .tencent-captcha-dy__slider-block（拖动手柄）
async function tcInfo(page) {
  return await page.evaluate(async () => {
    const g = (s) => document.querySelector(s);
    const rect = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)]; };
    const bgurl = (el) => { if (!el) return null; const m = (getComputedStyle(el).backgroundImage || '').match(/url\("?([^")]+)"?\)/); return m ? m[1] : null; };
    const b64 = async (u) => { if (!u) return null; try { const r = await fetch(u, { credentials: 'omit' }); const b = await r.blob(); return await new Promise(res => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.readAsDataURL(b); }); } catch (e) { return null; } };
    const bgEl = g('.tencent-captcha-dy__verify-bg-img');
    const fgEl = g('.tencent-captcha-dy__fg-item');
    if (!bgEl || !fgEl) return null;
    const r0 = bgEl.getBoundingClientRect();
    if (r0.width < 60 || r0.height < 60) return null;      // 隐藏容器，不是真验证
    const out = {
      bg_rect: rect(bgEl), fg_rect: rect(fgEl),
      slider_rect: rect(g('.tencent-captcha-dy__slider-block')),
      area_rect: rect(g('.tencent-captcha-dy__image-area')),
      msg: ((g('.tencent-captcha-dy__footer-area') || {}).innerText || '').replace(/\s+/g, ' ').slice(0, 40),
    };
    const cs = getComputedStyle(fgEl);
    const parse = (s) => (s || '').split(/\s+/).map(v => parseFloat(v) || 0);
    out.fg_css = {
      w: parseFloat(cs.width) || 0, h: parseFloat(cs.height) || 0,
      bpos: parse(cs.backgroundPosition), bsize: parse(cs.backgroundSize),
    };
    out.bg_cw = parseFloat(getComputedStyle(bgEl).width) || 0;
    out.bg_b64 = await b64(bgurl(bgEl));
    out.fg_b64 = await b64(bgurl(fgEl));
    return out;
  }).catch(() => null);
}

async function callTcSolver(bgB64, fgB64, css) {
  const r = await fetch(SOLVER + '/tcslide', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ background: bgB64, target: fgB64, fg_css: css || null }),
  }).then(x => x.json()).catch(e => ({ error: String(e) }));
  return r;
}

function tcDist(geo, sol) {
  // 服务端返回的是「缺口中心」在背景图原始像素里的 x；按 背景图 CSS 宽/原始宽 换算成页面像素，
  // 再减去拼图块当前中心相对图区左边的位置 —— 就是需要拖动的距离。
  const bgW = geo.bg_rect[2];
  const scale = bgW / (sol.nat_w || bgW);        // 原图 → 显示
  const gapCss = sol.x * scale;
  const pieceRel = (geo.fg_rect[0] + geo.fg_rect[2] / 2) - geo.bg_rect[0];
  let dist = gapCss - pieceRel;
  // 夹紧：负数或超过图区宽度的距离必是识别错误，宁可小幅试也不要空拖一次
  if (!isFinite(dist) || dist < 8) dist = Math.max(8, gapCss * 0.9);
  if (dist > bgW - 8) dist = bgW - 8;
  return { dist: Math.round(dist), gapCss: +gapCss.toFixed(2), pieceRel: +pieceRel.toFixed(2), scale };
}

async function dragTencent(page, dist) {
  const r = await page.evaluate(() => {
    const el = document.querySelector('.tencent-captcha-dy__slider-block');
    if (!el) return null;
    const b = el.getBoundingClientRect();
    return [b.x + b.width / 2, b.y + b.height / 2];
  });
  if (!r) return false;
  const [sx, sy] = r;
  await page.mouse.move(sx, sy);
  await sleep(150);
  await page.mouse.down();
  await sleep(120);
  const steps = 24 + Math.floor(Math.random() * 10);
  for (let i = 1; i <= steps; i++) {
    const p = i / steps;
    const ease = 1 - Math.pow(1 - p, 2.4);
    await page.mouse.move(sx + dist * ease + (Math.random() - 0.5) * 1.2, sy + (Math.random() - 0.5) * 1.6);
    await sleep(14 + Math.random() * 24);
  }
  await sleep(220);
  // 修正环节：拖完先量一下拼图块实际到了哪，不够再补，避免依赖「手柄行程 = 块行程」的假设
  const pieceX = () => page.evaluate(() => {
    const el = document.querySelector('.tencent-captcha-dy__fg-item');
    if (!el) return null;
    const b = el.getBoundingClientRect();
    return b.x + b.width / 2;
  }).catch(() => null);
  const x0 = await pieceX();
  if (x0 !== null) {
    const target = x0 + dist;
    for (let k = 0; k < 3; k++) {
      const cur = await pieceX();
      if (cur === null) break;
      const d = target - cur;
      if (Math.abs(d) < 1.5) break;
      const mx = sx + dist + (cur - x0);          // 当前鼠标位置估算
      const seg = 8;
      for (let i = 1; i <= seg; i++) {
        await page.mouse.move(mx + d * (i / seg), sy + (Math.random() - 0.5) * 1.2);
        await sleep(16 + Math.random() * 18);
      }
      await sleep(120);
    }
  }
  await page.mouse.up();
  return true;
}

async function tcPassed(page, waitMs = 3500) {
  await sleep(waitMs);
  const st = await page.evaluate(() => ({
    url: location.href,
    hasTc: !!document.querySelector('.tencent-captcha-dy__fg-item'),
    msg: ((document.querySelector('.tencent-captcha-dy__footer-area') || {}).innerText || '').replace(/\s+/g, ' ').slice(0, 40),
  })).catch(() => ({ url: page.url(), hasTc: true, msg: '' }));
  const failed = /失败|重试|错误/.test(st.msg);
  const gone = !st.hasTc;
  // 闸门页在通过后通常直接跳走（URL 不再是 verify/index.html）——这也是通过信号
  const leftGate = !/verify\/index\.html/.test(st.url || '');
  return { ok: !failed && (gone || leftGate || /成功|已通过/.test(st.msg)), url: st.url, msg: st.msg, gone, leftGate };
}

async function solveTencent(page) {
  const geo = await tcInfo(page);
  if (!geo || !geo.bg_b64 || !geo.fg_b64) return { ok: false, kind: 'tencent', reason: 'no tc images' };
  const sol = await callTcSolver(geo.bg_b64, geo.fg_b64, { ...(geo.fg_css || {}), bg_cw: geo.bg_cw });
  if (!sol || sol.success === false || typeof sol.x !== 'number') {
    return { ok: false, kind: 'tencent', reason: 'tc solver: ' + ((sol && (sol.error || 'bad')) || 'null') };
  }
  const { dist, gapCss, pieceRel } = tcDist(geo, sol);
  const info0 = `缺口中心${gapCss.toFixed(1)} 块中心${pieceRel.toFixed(1)} 拖${dist.toFixed(1)}(分值${(sol.score || 0).toFixed(1)})`;
  for (const off of [0, -3, 3, -6, 6]) {
    const d = dist + off;
    if (d < 5) continue;
    await dragTencent(page, d);
    const st = await tcPassed(page);
    if (st.ok) return { ok: true, kind: 'tencent', reason: `${info0} 试过${off}`, dist: d, gone: st.gone, url: st.url };
    // 腾讯失败通常会换一张新图 → 重新取图求解
    const g2 = await tcInfo(page);
    if (g2 && g2.bg_b64 && g2.fg_b64) {
      const s2 = await callTcSolver(g2.bg_b64, g2.fg_b64, { ...(g2.fg_css || {}), bg_cw: g2.bg_cw });
      if (s2 && s2.success !== false && typeof s2.x === 'number') {
        const d2 = tcDist(g2, s2);
        await dragTencent(page, d2.dist + off);
        const st2 = await tcPassed(page);
        if (st2.ok) return { ok: true, kind: 'tencent', reason: `${info0} 二次试过${off}`, dist: d2.dist + off, gone: st2.gone, url: st2.url };
      }
    }
  }
  return { ok: false, kind: 'tencent', reason: info0 + ' 未通过' };
}

module.exports = { solveOnPage, callSolver, callSlide, solveTencent, tcInfo };

if (require.main === module) {
  (async () => {
    const profile = process.argv[2] || process.env.CNKI_PROFILE || 'profile-solve';
    const rounds = Number(process.argv[3] || 3);
    const ctx = await chromium.launchPersistentContext(profile, {
      headless: false, executablePath: EXEC || undefined,
      args: ['--no-sandbox'], viewport: { width: 1400, height: 950 }, acceptDownloads: true,
    });
    const page = ctx.pages()[0] || await ctx.newPage();
    let detail = null;
    for (const line of fs.readFileSync(process.argv[4] || 'status_core.jsonl', 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try { const o = JSON.parse(line); if (o.status === 'fail' && o.detail) { detail = o.detail; break; } } catch (e) {}
    }
    for (let i = 0; i < rounds; i++) {
      await page.goto(detail, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.waitForTimeout(2500);
      const r1 = await solveOnPage(page);
      console.log(`第 ${i + 1} 轮 [${r1.kind}]:`, JSON.stringify(r1).slice(0, 260));
      if (r1.ok) { console.log('  已进入详情页:', page.url().slice(0, 80)); break; }
      await page.waitForTimeout(1500);
    }
    await ctx.close();
  })();
}
