# 知网（CNKI）批量下载器

> **English TL;DR** — A Playwright-based batch downloader for CNKI (China National Knowledge Infrastructure) with **local ddddocr captcha solving** (click-word + slider + Tencent puzzle), a **resumable JSONL queue**, a **self-healing watchdog** that rotates browser fingerprints when rate-limited, and a **CAJ→PDF batch converter with quality checks**. Runs headful (or under `xvfb-run`); needs your own CNKI account with download rights. MIT.

按篇名批量下载知网文献，自动过点选/滑块验证码，断点续跑，被风控时自动换指纹，最后把 CAJ 批量转 PDF 并质检。

## 能力

- **批量下载**：按题录（`tasks.jsonl`）逐条检索 → 匹配标题 → 进入详情 → 点 PDF/CAJ 下载；按文献类型自动归档（期刊 / 学位 / 会议 / 报纸 / 图书 / 标准 / 专利 / 年鉴 / 辑刊）
- **断点续跑**：每条结果追加进 `status.jsonl`；重跑时按规范化标题去重，`ok` / `nofull` 视为已完成
- **验证码本地求解**：点选文字、滑动拼图、腾讯拼图（腾讯验证码走 `tcslide` 几何反推）；图片只在本机处理，不上传
- **风控自愈**：连续 3 条卡在下载拦截页 → 进程以 `42` 退出 → `watchdog.sh` 换一个全新浏览器 profile 重启（登录态用 `--profile` 指定，可复用）
- **限流保护**：连续 5 次下载超时视为限流 → 暂停 15 分钟（可配），最多 4 次；条目之间随机等待 `--min`~`--max` 秒
- **失败分类**：`nofull`（页面没有全文）/ `fail`（其余）/ 付费墙（`fee_AI`）/ 登录墙；`prune_queue.py` 会把付费墙与撤回文章移出队列并永久留档
- **CAJ→PDF 质检**：`caj_batch.py` 批量转换，按「页数 + 每页内嵌图像字节」判断是不是正常扫描件
- **调试存证**：验证页的 DOM / 截图、失败验证码原图都落在本地 `debug/` 与 `captcha_samples/`

## 工作流

```
tasks.jsonl ──▶ downloader.js ──▶ status.jsonl ──▶ 文件落盘
                    │                                  └─ <root>/01_原始文件/<类型>/
                    ├─ 检索页 → 点进详情（或 detail 直开）
                    ├─ 等下载区 → 点 #pdfDown / #cajDown
                    ├─ 被拦截 → solve_verify.js → captcha_solver.py（ddddocr）
                    └─ 连续拦截 → exit 42 → watchdog 换 profile
```

## 安装

需要：Node ≥ 18、Python ≥ 3.9、Chromium（Playwright 自带）、Poppler（`pdfinfo`/`pdfimages`），无桌面环境再加 `xvfb`。

```bash
npm install
npx playwright install chromium
python3 -m venv .venv && . .venv/bin/activate
pip install -r requirements.txt
```

## 首次登录（保存登录态）

```bash
node login.js ./profile
```

浏览器会打开知网首页，手动登录（个人 / 机构 / 扫码均可），**关掉窗口**即保存。之后所有下载都复用 `./profile`。

## 运行

```bash
# 终端 1：验证码识别服务（本地 127.0.0.1:9898）
python3 captcha_solver.py 9898

# 终端 2：自愈式批量下载（无桌面时自动套 xvfb-run）
./watchdog.sh tasks.jsonl status.jsonl ./data
```

前台单次跑（不套自愈循环）：

```bash
node downloader.js tasks.jsonl status.jsonl --root ./data --profile ./profile --min 30 --max 55
```

## 参数

| 参数 | 默认 | 说明 |
|---|---|---|
| `--root` | `./data` | 输出根目录，文件落到 `01_原始文件/<类型>/` |
| `--profile` | `./profile-<时间戳>` | 浏览器 profile（登录态） |
| `--history` | `status_core.jsonl` | 额外参与去重的历史状态文件 |
| `--min` / `--max` | 12 / 22 | 条目之间的随机等待秒数（调速） |
| `--limit` | 0 | 本次最多处理 N 条 |
| `--pause` | 15 | 触发限流后暂停多少分钟 |
| `--max-pause` | 4 | 最多暂停几次后停止本轮 |

环境变量：`CHROME_PATH`（自定义浏览器）、`SOLVER_URL`（验证码服务地址）、`CAPTCHA_DEBUG_DIR`、`CNKI_PROFILE`、`PYTHON`、`PROFILE_BASE`、`MIN`、`MAX`。

## 任务与状态格式

`tasks.jsonl` 每行一条（见 `tasks.example.jsonl`）：

```json
{"title":"论文标题","dbtype":"期刊","authors":"第一作者","detail":"可选的详情页 URL"}
```

`dbtype` 支持：`期刊` `特色期刊` `学位论文` `硕士` `博士` `会议` `中国会议` `国际会议` `报纸` `图书` `标准` `专利` `年鉴` `辑刊`。

`status.jsonl` 由程序追加：`{"title","dbtype","status":"ok|nofull|fail","file","size","error","ts"}`。

## 退出码

| 码 | 含义 | 后续动作 |
|---|---|---|
| 0 | 队列处理完 | 结束 |
| 42 | 连续 3 条卡在滑块拦截（指纹被风控） | watchdog 换新 profile 重启 |
| 1 | 未捕获异常 | 看日志 |

## 队列清理

`prune_queue.py TASKS STATUS [PRUNED]`：按「标题的最新一条状态」判断，付费墙（`fee_AI`/`付费墙`）与已撤回文章会被移出 `tasks.jsonl`，留档到 `tasks_pruned.jsonl`（按标题去重）。

## CAJ → PDF

```bash
git clone https://github.com/JeziL/caj2pdf.git
python3 caj_batch.py --src ./data/01_原始文件 --out ./pdf --caj2pdf ./caj2pdf
```

判定：转换成功、页数 > 0、每页内嵌图像 > 20KB 记为 `good`；报告写到 `caj_convert_report.json`。

## 文件说明

| 文件 | 作用 |
|---|---|
| `downloader.js` | 主程序：检索 → 详情 → 下载 → 记录 |
| `solve_verify.js` | 验证码求解（被 downloader `require`） |
| `captcha_solver.py` | 本地 ddddocr HTTP 服务（`:9898`） |
| `login.js` | 手动登录并保存 profile |
| `watchdog.sh` | 自愈循环（exit 42 → 换 profile） |
| `prune_queue.py` | 把付费墙/撤回条目移出队列 |
| `caj_batch.py` | CAJ→PDF 批量转换 + 质检 |
| `tasks.example.jsonl` | 任务格式示例 |

## 合规与免责（请先读）

- **仅供个人学术研究**使用；必须在你自己拥有合法下载权限的账号 / 机构网络下运行。
- **不绕过付费墙**：遇到单篇付费、会员墙、文章撤回会记录原因并跳过，不会尝试破解。
- 下载到的文献受著作权保护，**请勿再分发、公开上传或用于商业用途**。
- 本工具会模拟浏览器自动化行为，可能违反目标站点的用户协议；是否使用、如何使用由你自行判断，**风险自负**。
- 仓库内**不含**任何账号、Cookie、密钥或文献文件。

## 许可

MIT
