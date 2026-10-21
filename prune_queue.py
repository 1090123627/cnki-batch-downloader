#!/usr/bin/env python3
"""看门狗预清理：把最新状态为「付费墙 / 文章撤回」的任务踢出队列。

用法: prune_queue.py TASKS.jsonl STATUS.jsonl [PRUNED.jsonl]
- 只按标题的“最新一条”状态判断
- 原子重写 TASKS（同目录 tmp + replace）
- 被剔除的条目追加到 PRUNED（按标题去重，永久留档）
"""
import json, os, sys, tempfile

def main() -> int:
    if len(sys.argv) < 3:
        print("用法: prune_queue.py TASKS STATUS [PRUNED]", file=sys.stderr)
        return 2
    tasks_p, status_p = sys.argv[1], sys.argv[2]
    pruned_p = sys.argv[3] if len(sys.argv) > 3 else os.path.join(os.path.dirname(status_p), "tasks_pruned.jsonl")

    latest = {}
    if os.path.exists(status_p):
        with open(status_p, encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    r = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if r.get("title"):
                    latest[r["title"]] = r

    def reason(r):
        if not r or r.get("status") != "fail":
            return None
        e = r.get("error", "") or ""
        if "撤回" in e:
            return "文章已撤回"
        if "fee_AI" in e or "付费墙" in e:
            return "付费墙"
        return None

    keep, drop = [], []
    with open(tasks_p, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                t = json.loads(line)
            except json.JSONDecodeError:
                continue
            why = reason(latest.get(t.get("title")))
            (drop if why else keep).append((t, why))

    if not drop:
        print(f"[prune] 无需剔除，队列 {len(keep)} 条")
        return 0

    # 留档（按标题去重）
    seen = set()
    if os.path.exists(pruned_p):
        with open(pruned_p, encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if line:
                    try:
                        seen.add(json.loads(line).get("title"))
                    except json.JSONDecodeError:
                        pass
    with open(pruned_p, "a", encoding="utf-8") as f:
        for t, why in drop:
            if t.get("title") in seen:
                continue
            t["_pruned_reason"] = why
            f.write(json.dumps(t, ensure_ascii=False) + "\n")
            seen.add(t.get("title"))

    # 原子重写队列
    d = os.path.dirname(os.path.abspath(tasks_p))
    fd, tmp = tempfile.mkstemp(dir=d, prefix=".tasks_prune_", suffix=".jsonl")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            for t, _ in keep:
                f.write(json.dumps(t, ensure_ascii=False) + "\n")
        os.replace(tmp, tasks_p)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)

    print(f"[prune] 剔除 {len(drop)} 条（付费墙/撤回），队列 {len(keep)} 条；留档 -> {pruned_p}")
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
