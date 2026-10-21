// 手动登录一次，把知网登录态保存在 profile 目录里（下载器后续复用同一个 profile）。
// 用法: node login.js [profile目录，默认 ./profile]
const { chromium } = require('playwright');

const EXEC = process.env.CHROME_PATH || '';

(async () => {
  const profile = process.argv[2] || 'profile';
  const ctx = await chromium.launchPersistentContext(profile, {
    headless: false,
    executablePath: EXEC || undefined,
    viewport: { width: 1400, height: 950 },
    locale: 'zh-CN',
    args: ['--no-first-run', '--no-default-browser-check'],
  });
  const page = ctx.pages()[0] || await ctx.newPage();
  await page.goto('https://kns.cnki.net/', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
  console.log(`请在浏览器中手动登录知网（个人 / 机构 / 扫码均可）。`);
  console.log(`登录完成后直接关掉浏览器窗口即可，登录态保存在: ${profile}`);
  // 等浏览器被关闭
  await new Promise((resolve) => ctx.on('close', resolve));
  process.exit(0);
})();
