// 知网批量下载器：检索页点进详情 + ddddocr 自动过验证 + 断点续跑 + 限流自愈
// 用法: node downloader.js tasks.jsonl status.jsonl [--root DIR] [--profile DIR] [--history FILE]
//       [--min 12] [--max 22] [--limit N] [--pause 15] [--max-pause 4]
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const { solveOnPage } = require('./solve_verify.js');

// 可选：指定 Chrome/Chromium 可执行文件；留空则用 Playwright 自带的 chromium
const EXEC = process.env.CHROME_PATH || '';
const AI = process.argv; const argVal = (k, d) => { const i = AI.indexOf(k); return i >= 0 ? AI[i + 1] : d; };
const ROOT = path.resolve(argVal('--root', path.join(process.cwd(), 'data')));
const DLROOT = path.join(ROOT, '01_原始文件');
const DEBUG_DIR = path.join(ROOT, 'debug');   // 验证页 DOM/截图存证
const DB_DIR = { '期刊': '01_期刊论文', '特色期刊': '01_期刊论文', '学位论文': '02_学位论文', '硕士': '02_学位论文', '博士': '02_学位论文', '会议': '03_会议论文', '中国会议': '03_会议论文', '国际会议': '03_会议论文', '报纸': '04_报纸', '图书': '05_图书', '标准': '06_标准', '专利': '07_专利', '年鉴': '08_年鉴', '辑刊': '09_辑刊' };

const args = process.argv.slice(2);
const tasksFile = args[0], statusFile = args[1];
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const MIN = Number(opt('--min', 12)), MAX = Number(opt('--max', 22));
const LIMIT = Number(opt('--limit', 0)) || 0;
const PROFILE = path.resolve(opt('--profile', path.join(process.cwd(), 'profile-' + Date.now())));

const safe = (s) => s.replace(/[\\/:*?"<>|\r\n\t]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 120);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const norm = (s) => (s || '').normalize('NFKC').replace(/[\s\p{P}\p{S}]/gu, '').toLowerCase();

function loadDone(...files) {
  const done = new Set();
  for (const f of files) {
    if (!fs.existsSync(f)) continue;
    for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try { const o = JSON.parse(line); if (o.status === 'ok' || o.status === 'nofull') done.add(norm(o.title)); } catch (e) {}
    }
  }
  return done;
}
const SEARCH = (kw, korder) => `https://kns.cnki.net/kns8s/defaultresult/index?kw=${encodeURIComponent(kw)}&korder=${korder}`;

(async () => {
  fs.mkdirSync(DLROOT, { recursive: true });
  const tasks = fs.readFileSync(tasksFile, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
  const done = loadDone(argVal('--history', 'status_core.jsonl'), statusFile);
  let todo = tasks.filter(t => !done.has(norm(t.title)));
  if (LIMIT) todo = todo.slice(0, LIMIT);
  console.log(`任务 ${tasks.length} 已完成 ${done.size} 本次待下 ${todo.length} profile=${PROFILE}`);
  if (!todo.length) return;

  const out = fs.createWriteStream(statusFile, { flags: 'a' });
  const log = (o) => out.write(JSON.stringify({ ...o, ts: new Date().toISOString() }) + '\n');

  let pendingResolve = null;
  let ctx = await chromium.launchPersistentContext(PROFILE, {
    executablePath: EXEC || undefined, headless: false, viewport: { width: 1500, height: 1000 }, locale: 'zh-CN',
    args: ['--no-first-run', '--no-default-browser-check', '--disable-blink-features=AutomationControlled'],
    acceptDownloads: true,
  });
  ctx.on('download', async (d) => {
    const name = d.suggestedFilename();
    try {
      const dest = path.join(DLROOT, '_tmp_' + Date.now() + '_' + safe(name));
      await d.saveAs(dest);
      const size = fs.statSync(dest).size;
      if (pendingResolve) { pendingResolve({ name, size, path: dest }); pendingResolve = null; }
    } catch (e) {
      if (pendingResolve) { pendingResolve({ error: e.message }); pendingResolve = null; }
    }
  });
  let page = ctx.pages()[0] || await ctx.newPage();
  // 检索页固定在 searchTab 里；每个条目点进去会 target=_blank 开新标签，
  // 跑完一条就关掉多余标签，否则几百条下来内存会被标签吃光（实测 33 条就涨到 15 GB）。
  const searchTab = page;
  async function closeExtras() {
    for (const p of ctx.pages()) {
      if (p !== searchTab) { try { if (!p.isClosed()) await p.close(); } catch (e) {} }
    }
    page = searchTab.isClosed() ? await ctx.newPage() : searchTab;
  }

  // 下载被拦：bar.cnki.net 会新开一个「拖动滑块完成拼图」的验证页（AI生成背景那套）。
  // 这里负责把它的结构和截图存证一次，并尝试用同一套定位逻辑自动通过。
  const gateSeen = new Set();
  async function handleVerifyTabs(tag) {
    for (const p of ctx.pages()) {
      if (p === searchTab) continue;
      let u = '';
      try { u = p.url(); } catch (e) { continue; }
      if (!/bar\.cnki\.net|verify/i.test(u)) continue;
      const key = u.split('?')[0];
      if (gateSeen.has(key)) continue;
      gateSeen.add(key);
      try {
        const dir = DEBUG_DIR;
        fs.mkdirSync(dir, { recursive: true });
        const stamp = Date.now();
        fs.writeFileSync(`${dir}/dom_${stamp}.html`, await p.content().catch(() => ''));
        await p.screenshot({ path: `${dir}/shot_${stamp}.png` }).catch(() => {});
        const els = await p.evaluate(() => [...document.querySelectorAll('img,canvas,div')].filter(e => { const r = e.getBoundingClientRect(); return r.width > 20 && r.height > 20; }).map(e => { const r = e.getBoundingClientRect(); return { tag: e.tagName, id: e.id, cls: (e.className || '').toString().slice(0, 40), nat: [e.naturalWidth || e.width, e.naturalHeight || e.height], rect: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)], bg: getComputedStyle(e).backgroundImage.slice(0, 60) }; }).slice(0, 40)).catch(() => []);
        fs.writeFileSync(`${dir}/els_${stamp}.json`, JSON.stringify({ url: u, els }, null, 1));
        console.log(`    [下载验证] 出现验证页 ${u.slice(0, 80)} 可见元素=${els.length} 已存证 gate_samples/`);
        // 腾讯验证码（Turing）：连同两张图 + 几何一起存证，供离线校准求解器
        const tc = await p.evaluate(async () => {
          const g = (s) => document.querySelector(s);
          const bgEl = g('.tencent-captcha-dy__verify-bg-img');
          const fgEl = g('.tencent-captcha-dy__fg-item');
          if (!bgEl && !fgEl) return null;
          const rect = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)]; };
          const url = (el) => { if (!el) return null; const m = (getComputedStyle(el).backgroundImage || '').match(/url\("?([^")]+)"?\)/); return m ? m[1] : null; };
          const b64 = async (u2) => { if (!u2) return null; try { const r = await fetch(u2, { credentials: 'omit' }); const b = await r.blob(); return await new Promise(res => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.readAsDataURL(b); }); } catch (e) { return null; } };
          const out = {
            fg_url: url(fgEl), bg_url: url(bgEl), fg_rect: rect(fgEl), bg_rect: rect(bgEl),
            slider_rect: rect(g('.tencent-captcha-dy__slider-block')),
            track_rect: rect(g('.tencent-captcha-dy__verify-slider-area')),
            area_rect: rect(g('.tencent-captcha-dy__image-area')),
            fg_style: fgEl ? fgEl.getAttribute('style') : null,
            msg: ((g('.tencent-captcha-dy__footer-area') || {}).innerText || '').slice(0, 40),
          };
          out.fg_b64 = await b64(out.fg_url); out.bg_b64 = await b64(out.bg_url);
          return out;
        }).catch(() => null);
        if (tc) {
          const st = Date.now();
          for (const [k, n] of [['bg_b64', 'tcbg'], ['fg_b64', 'tcfg']]) {
            if (tc[k] && String(tc[k]).startsWith('data:')) {
              try { fs.writeFileSync(`${dir}/${n}_${st}.png`, Buffer.from(tc[k].split(',')[1], 'base64')); } catch (e) {}
            }
            delete tc[k];
          }
          fs.writeFileSync(`${dir}/tcinfo_${st}.json`, JSON.stringify(tc, null, 1));
          console.log(`    [下载验证] 腾讯验证码已存证 tcbg_${st}.png tcfg_${st}.png fg=${JSON.stringify(tc.fg_rect)} 滑块=${JSON.stringify(tc.slider_rect)} 图区=${JSON.stringify(tc.area_rect)}`);
        }
      } catch (e) {}
      let anyOk = false;
      for (let k = 0; k < 4; k++) {
        const r = await solveOnPage(p).catch(() => null);
        if (!r) break;
        console.log(`    [下载验证] 第${k + 1}次 ${r.ok ? '通过' : '失败'} ${r.kind || ''} ${(r.reason || '').slice(0, 40)}`);
        if (r.ok) { anyOk = true; break; }
        if (r.kind === 'login') break;      // 登录态失效：再撞也没用，交给硬刷新重登一次
        await p.waitForTimeout(1200);
        await p.evaluate(() => { const b = document.querySelector('.verify-refresh, .refresh-icon, .refresh'); if (b) b.click(); }).catch(() => {});
        await p.waitForTimeout(1500);
      }
      // 全部尝试失败：把「稍后」的 DOM 也存一份，好判断组件是不是根本渲染不出来
      if (!anyOk) {
        const st2 = Date.now();
        fs.writeFileSync(`${DEBUG_DIR}/dom_late_${st2}.html`, await p.content().catch(() => ''));
        const snap = await p.evaluate(() => {
          const el = document.querySelector('.tencent-captcha-dy__fg-item') || document.querySelector('.tencent-captcha-dy__verify-bg-img');
          const r = el ? el.getBoundingClientRect() : null;
          return { tc: !!el, rect: r ? [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)] : null, txt: document.body.innerText.replace(/\s+/g, ' ').slice(0, 100) };
        }).catch(() => null);
        console.log(`    [下载验证] 4 次都没过；稍后快照 tc=${snap && snap.tc} rect=${JSON.stringify(snap && snap.rect)} 文案="${(snap && snap.txt || '').slice(0, 40)}"`);
      }
    }
  }
  const waitDownload = (ms) => new Promise((res) => {
    let settled = false;
    pendingResolve = (v) => { settled = true; res(v); };
    setTimeout(() => { if (!settled) { pendingResolve = null; res({ error: 'timeout ' + ms + 'ms' }); } }, ms);
  });

  const isVerify = () => /verify\/home|\/verify/i.test(page.url());

  // 通过检索页点进详情（拿新的 v= 令牌），返回 {ok, matched}
  async function openViaSearch(title, korder, clickLoose = false) {
    let loaded = false;
    for (let a = 0; a < 2 && !loaded; a++) {
      try {
        await page.goto(SEARCH(title, korder), { waitUntil: 'domcontentloaded', timeout: 30000 });
        loaded = true;
      } catch (e) {
        console.log(`    [检索] 打开超时，重试 ${a + 1}/2`);
        await page.waitForTimeout(2000 + a * 2500);
      }
    }
    if (!loaded) return { gotoFailed: true };
    // 结果表和验证码都是异步渲染的：轮询等待，别只等一次就判空
    let rows = [];
    for (let k = 0; k < 12; k++) {
      const st = await page.evaluate(() => ({
        panel: !!document.querySelector('.verify-img-panel img') || !!document.querySelector('.verify-msg'),
        rows: [...document.querySelectorAll('.result-table-list tbody tr')].map(r => {
          const a = r.querySelector('td.name a, a.fz14');
          return a ? { t: a.innerText.trim() } : null;
        }).filter(Boolean),
      })).catch(() => ({ panel: false, rows: [] }));
      if (st.panel) return { verify: true };          // 页内弹验证（滑块/点选）也要交给 passVerify
      if (st.rows.length) { rows = st.rows; break; }
      await page.waitForTimeout(700);
    }
    if (isVerify()) return { verify: true };
    if (!rows.length) return { empty: true };
    const want = norm(title);
    let idx = rows.findIndex(r => norm(r.t) === want);
    if (idx < 0) idx = rows.findIndex(r => norm(r.t).includes(want) || want.includes(norm(r.t)));
    const confident = idx >= 0;
    if (!confident) {
      // 不匹配就别急着点（会下错文章）；交给调用方换个检索式再试
      if (!clickLoose) return { nomatch: rows[0].t, rows: rows.length };
      idx = 0;
    }
    const [popup] = await Promise.all([
      ctx.waitForEvent('page', { timeout: 8000 }).catch(() => null),
      page.evaluate((i) => document.querySelectorAll('.result-table-list tbody tr')[i].querySelector('td.name a, a.fz14').click(), idx),
    ]);
    if (popup) page = popup;
    await page.waitForLoadState('domcontentloaded', { timeout: 60000 }).catch(() => {});
    await page.waitForTimeout(2600);
    return { matched: rows[idx].t, confident };
  }

  // 自动过点选验证（最多 6 次，失败则刷新验证码再试）
  async function passVerify(tag) {
    for (let i = 0; i < 6; i++) {
      const hasPanel = await page.evaluate(() => !!(document.querySelector('.verify-img-panel img') || document.querySelector('.verify-msg') || document.querySelector('.verify-move-block'))).catch(() => false);
      if (!hasPanel) {
        if (/verify/i.test(page.url())) await page.waitForTimeout(1500);
        else return true;
        continue;
      }
      const r = await solveOnPage(page);
      if (r.ok) {
        const how = r.kind === 'slide' ? `滑块 dist=${r.dist}(${r.method},试过[${(r.tried || []).join(',')}])` : `点选 ${(r.words || []).join('')}`;
        console.log(`    [验证码] ${tag} 第${i + 1}次通过 ${how}`);
        await page.waitForTimeout(2000); return true;
      }
      console.log(`    [验证码] ${tag} 第${i + 1}次失败: ${r.kind || ''} ${(r.reason || '').slice(0, 50)} ${r.tried ? '试过[' + r.tried.join(',') + ']' : ''}`);
      await page.waitForTimeout(1200);
      // 刷新验证码
      await page.evaluate(() => { const b = document.querySelector('.verify-refresh'); if (b) b.click(); }).catch(() => {});
      await page.waitForTimeout(1800);
    }
    return false;
  }

  const PAUSE_MIN = Number(opt('--pause', 15));   // 限流暂停时长（分钟）
  const MAX_PAUSE = Number(opt('--max-pause', 4)); // 最多暂停几次
  let ok = 0, fail = 0, consecTO = 0, consecGate = 0, pauses = 0;
  for (let n = 0; n < todo.length; n++) {
    const t = todo[n];
    const dir = path.join(DLROOT, DB_DIR[t.dbtype] || '09_其他');
    fs.mkdirSync(dir, { recursive: true });
    try {
      const T0 = Date.now();
      if (!page || page.isClosed()) page = await ctx.newPage();
      // 打开检索页并点进详情；检索页若被风控拦截，先自动过验证再重开
      // 篇名检索有时完全搜不到（带副标题、破折号、括号的标题），依次退化成更短的检索式
      const variants = [t.title];
      const head = t.title.split(/[—–\-:：~～(（【〔[]/)[0].trim();
      if (head && head.length >= 6 && head !== t.title) variants.push(head);
      const cut = t.title.replace(/[（(【〔\[][^）)】〕\]]*[）)】〕\]]/g, '').trim();
      if (cut && cut.length >= 6 && !variants.includes(cut)) variants.push(cut);
      if (t.title.length > 14) variants.push(t.title.slice(0, 12));
      let opened = false, loose = false, lastRows = 0;
      // 尝试顺序：整串篇名(TI) → 整串主题(SU) → 短标题(TI) → 去括号(TI)；最多 4 次，避免一条题目烧掉十几分钟
      // 优先：任务里已记下详情页 URL —— 直接打开，省掉检索+点选整段风险（老失败的几条都是走检索打不开）
      if (t.detail && /kns\.cnki\.net\/(kcms2|kcms\/detail|kns8s\/detail)/.test(t.detail)) {
        for (let k = 0; k < 2 && !opened; k++) {
          await page.goto(t.detail, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
          await page.waitForTimeout(2500);
          if (/verify/.test(page.url())) { if (!await passVerify(t.title.slice(0, 12))) break; continue; }
          const marks = await page.evaluate(() => {
            const x = document.body.innerText;
            return ['摘要', '关键词', 'DOI', '被引', '机构', '基金'].filter(v => x.includes(v)).length;
          }).catch(() => 0);
          if (marks >= 2) { opened = true; console.log('    [直开] 详情页直达成功（省掉检索）'); }
        }
      }
      const plan = opened ? [] : [[variants[0], 'TI'], [variants[0], 'SU'], [variants[1], 'TI'], [variants[2] || variants[1], 'TI']]
        .filter(([q]) => q);
      outer:
      for (const [q, korder] of plan) {
        let st = null;
        for (let k = 0; k < 3; k++) {
          st = await openViaSearch(q, korder, false);
          if (!st.verify) break;
          if (!await passVerify(t.title.slice(0, 12))) throw new Error('verify unsolved (search)');
        }
        if (st && st.matched) { opened = true; break outer; }
        if (st && st.nomatch) { loose = true; lastRows = st.rows || 0; }
        if (Date.now() - T0 > 240000) throw new Error('item timeout 240s');
      }
      if (!opened && loose) {
        // 所有检索式都找不到同名条目：退回「取第一条」的老办法（至少基于同一检索式的结果列表）
        for (let k = 0; k < 3; k++) {
          const st = await openViaSearch(t.title, 'TI', true);
          if (!st.verify) break;
          if (!await passVerify(t.title.slice(0, 12))) throw new Error('verify unsolved (search)');
        }
        opened = true;
      }
      if (!opened) throw new Error(`search unreachable or empty (试过 ${variants.slice(0, 4).length} 种检索式)`);
      // 详情页若再弹验证（点选题），继续自动过
      if (!await passVerify(t.title.slice(0, 12))) throw new Error('verify unsolved (detail)');
      if (!/kcms2|kns8s\/detail|kcms\/detail/.test(page.url()) && await page.evaluate(() => !document.querySelector('a,button')).catch(() => true)) {
        throw new Error('not on detail page: ' + page.url().slice(0, 60));
      }

      // 等下载区渲染。知网的下载入口是隐藏锚点 #pdfDown / #cajDown，用 JS 直接点才触发；
      // 文本匹配会点到"下载中心"导航或隐藏外壳，导致空等。下载区是异步注入的，轮询等一等。
      const scanEntries = () => page.evaluate(() => {
        const out = [];
        for (const id of ['pdfDown', 'cajDown']) {
          const el = document.getElementById(id);
          if (el) out.push({ sel: '#' + id, label: id === 'pdfDown' ? 'PDF下载' : 'CAJ下载' });
        }
        if (!out.length) {
          for (const t of ['整本下载', 'PDF下载', 'CAJ下载', '分章下载']) {
            const el = [...document.querySelectorAll('a,li')].find(e => (e.innerText || '').trim() === t);
            if (el) out.push({ sel: null, label: t });
          }
        }
        return out;
      });
      let entries = [];
      for (let k = 0; k < 10; k++) {
        await page.waitForTimeout(1100);
        entries = await scanEntries().catch(() => []);
        if (entries.length) break;
      }
      if (!entries.length) {
        // 先确认确实站在详情页上：否则这是「详情页没打开」的可重试错误，
        // 不能记成 nofull（nofull 会被永久跳过，等于把能下的文献扔了）
        // 判定要同时满足：URL 是详情页 + 页面里真有摘要/关键词/DOI 这些正文要素
        const info = await page.evaluate(() => {
          const t = document.body.innerText;
          const marks = ['摘要', '关键词', 'DOI', '被引', '机构', '基金'].filter(m => t.includes(m));
          return {
            urlOk: /kcms2|kcms\/detail|kns8s\/detail/.test(location.href),
            marks,
            txt: (document.querySelector('.download-btns') || t).replace(/\s+/g, ' ').slice(0, 60),
          };
        }).catch(() => ({ urlOk: false, marks: [], txt: '' }));
        if (!info.urlOk || info.marks.length < 2) throw new Error('detail not opened: ' + info.txt);
        throw new Error('no-fulltext: ' + info.txt);
      }

      let picked = null, dl = null, gate = '';
      for (const ent of entries) {
        const before = new Set(ctx.pages());
        const clicked = await page.evaluate((e) => {
          if (e.sel) { const el = document.querySelector(e.sel); if (!el) return false; el.click(); return true; }
          const el = [...document.querySelectorAll('a,li')].find(x => (x.innerText || '').trim() === e.label);
          if (el) el.click();
          return !!el;
        }, ent).catch(() => false);
        if (!clicked) continue;
        picked = ent.label;
        // 等下载的过程中，若弹出 bar.cnki.net 的滑块验证页，就地自动过掉
        const deadline = Date.now() + 45000;
        while (Date.now() < deadline) {
          const r = await waitDownload(Math.max(1000, Math.min(6000, deadline - Date.now())));
          if (!r.error) { dl = r; break; }
          await handleVerifyTabs(t.title.slice(0, 8));
        }
        if (!dl || dl.error) { dl = dl || { error: 'timeout 45000ms' }; }
        if (!dl.error) break;
        // 没下载成功时，看看点击是否弹出别的页面（限流提示/验证/登录），记下来好判断原因
        for (const p of ctx.pages()) {
          if (before.has(p)) continue;
          await p.waitForLoadState('domcontentloaded', { timeout: 8000 }).catch(() => {});
          const t = await p.evaluate(() => document.body.innerText.replace(/\s+/g, ' ').slice(0, 120)).catch(() => '');
          if (t) gate += ' [' + p.url().slice(0, 50) + '] ' + t;
        }
        await page.waitForTimeout(1200);
      }
      if (!picked) {
        const txt = await page.evaluate(() => document.body.innerText.replace(/\s+/g, ' ').slice(0, 160)).catch(() => '');
        throw new Error('no download button | ' + txt);
      }
      if (dl.error) throw new Error('download ' + dl.error + (gate ? ' | gate:' + gate.slice(0, 200) : ''));
      const ext = path.extname(dl.name) || '.bin';
      const fname = safe(t.title) + (t.authors ? '_' + safe(t.authors.split(';')[0]) : '') + ext;
      const finalPath = path.join(dir, fname);
      fs.renameSync(dl.path, finalPath);
      log({ title: t.title, dbtype: t.dbtype, status: 'ok', file: finalPath, size: dl.size, matched: dl.name, via: picked });
      ok++;
      console.log(`[${n + 1}/${todo.length}] OK ${t.dbtype} ${t.title.slice(0, 30)} ${(dl.size / 1024).toFixed(0)}KB (${picked})`);
      consecTO = 0; consecGate = 0;
    } catch (e) {
      const st = /^no-fulltext/.test(e.message) ? 'nofull' : 'fail';
      // 拦截页里若带 fee_AI（付费变体），记成付费墙而不是「闸门求解失败」——这类本来就要单篇付费
      const fee = /fee_AI|不在有效期|单篇下载|付费下载/.test(e.message);
      const needLogin = /重新登录|扫码验证|获取短信验证码|login\.cnki\.net/.test(e.message);
      const tag = fee ? '💰 付费墙 | ' : (needLogin ? '🔒 登录墙 | ' : '');
      log({ title: t.title, dbtype: t.dbtype, status: st, error: (fee ? '付费墙(fee_AI) | ' : needLogin ? '登录墙(需登录/会员) | ' : '') + e.message, detail: t.detail });
      fail++;
      console.log(`[${n + 1}/${todo.length}] FAIL ${t.title.slice(0, 30)} :: ${tag + e.message.slice(0, 130)}`);
      // 下载拦截页的腾讯滑块不是限流，别拿它触发暂停；单独计数、单独提示
      if (/bar\/verify|verify\/index\.html/.test(e.message)) {
        consecGate++;
        if (consecGate === 3) console.log(`    ⚠ 连续 ${consecGate} 条卡在下载拦截页（腾讯拼图）——看上面 [下载验证] 行的求解结果`);
      } else if (/download timeout/.test(e.message)) consecTO++;
      else if (/search unreachable|Timeout|net::|verify unsolved/.test(e.message)) consecTO++;
      else consecTO = 0;
    }
    if (consecGate >= 3) {
      console.log(`连续 ${consecGate} 条卡滑块拦截，本指纹已被风控——退出交外层换新指纹（进度已存）`);
      process.exit(42);
    }
    await closeExtras();
    // 连续超时＝被限流，硬跑下去只会白刷几百条。停下来等一等再继续。
    if (consecTO >= 5) {
      pauses++;
      if (pauses > MAX_PAUSE) {
        console.log(`已连续暂停 ${MAX_PAUSE} 次仍被限流，停止本轮（进度已存 ${statusFile}，稍后重跑续下）`);
        break;
      }
      console.log(`连续 ${consecTO} 次下载超时（疑似知网限流），暂停 ${PAUSE_MIN} 分钟后再试（第 ${pauses}/${MAX_PAUSE} 次）`);
      consecTO = 0;
      await sleep(PAUSE_MIN * 60 * 1000);
    }
    await sleep(MIN * 1000 + Math.random() * (MAX - MIN) * 1000);
  }
  out.end();
  console.log(`DONE ok=${ok} fail=${fail}`);
  try { await ctx.close(); } catch (e) {}
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
