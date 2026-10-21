#!/usr/bin/env bash
# 自愈循环：downloader.js 退出码 42（连续滑块拦截 → 当前指纹被风控）时自动换新 profile 重启；
# 0 = 全部跑完；其它退出码 10 分钟后重试。
#
# 用法: ./watchdog.sh tasks.jsonl status.jsonl <数据根目录>
# 环境变量: PYTHON(默认 python3) / CHROME_PATH / PROFILE_BASE / MIN / MAX
set -u
cd "$(dirname "$0")"

TASKS="$1"; STATUS="$2"; ROOT="$3"
[ -z "$ROOT" ] && { echo "用法: $0 tasks.jsonl status.jsonl root"; exit 2; }

PY="${PYTHON:-python3}"
PROFILE_BASE="${PROFILE_BASE:-$(pwd)/profiles}"
mkdir -p "$PROFILE_BASE"

command -v node >/dev/null || { echo "错误: 需要 node ≥ 18"; exit 2; }

# 无显示器的机器用 xvfb 提供虚拟屏幕；有桌面就直连
RUNNER=()
command -v xvfb-run >/dev/null && RUNNER=(xvfb-run -a)

while true; do
  P="$PROFILE_BASE/cnki-$(date +%s)"

  # 每轮先剔除「付费墙 / 文章撤回」条目（碰到一次即踢出队列，永久留档）
  "$PY" prune_queue.py "$TASKS" "$STATUS" 2>&1 | sed 's/^/  /'

  echo "[$(date +%H:%M)] 启动 downloader.js profile=$P"
  "${RUNNER[@]}" node downloader.js "$TASKS" "$STATUS" --root "$ROOT" \
      --profile "$P" --min "${MIN:-30}" --max "${MAX:-55}"
  code=$?
  echo "[$(date +%H:%M)] downloader.js 退出码 $code"

  if [ "$code" -eq 42 ]; then
    sleep 45                       # 换指纹的小间隔，不硬撞
    continue
  elif [ "$code" -eq 0 ]; then
    echo "全部任务已处理完。"
    break
  else
    echo "非预期退出码 $code，10 分钟后重试一次。"
    sleep 600
    continue
  fi
done
