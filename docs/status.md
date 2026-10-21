# 远程进度

云端助手不需要看终端。它读磁盘上的追加日志，或调用 `orch status` / MCP。

## 文件

全部在 `artifacts_dir`（默认 `<workspace>/.orch`）。

| 文件 | 写法 | 内容 |
| --- | --- | --- |
| `events.jsonl` | 只追加 | 值得推送的事件 |
| `quota.jsonl` | 只追加 | `consume` 与 `cooldown` |
| `runs/<runId>/events.jsonl` | 只追加 | 这次运行的全部事件 |
| `runs/<runId>/state.jsonl` | 只追加 | 每次变更后的完整快照 |
| `runs/<runId>/state.json` | 原子覆盖 | 最后一条快照，给 `status` 和 MCP 快速读 |
| `runs/<runId>/usage.jsonl` | 只追加 | 每次模型调用的 token 和标价 |
| `runs/<runId>/escalations/<taskId>.json` | 一次写入 | 交给人的原因、反馈、轮次 |
| `runs/<runId>/tasks/<taskId>/` | 追加文件 | 每轮提示词、diff、测试输出、审查原文 |
| `runs/<runId>/worktrees/<taskId>/` | git worktree | 该任务的独立检出 |

`state.jsonl` 的每一行是 `{"ts","kind":"snapshot","state":{...}}`。查询以最后一条为准。`state.json` 只是它的投影，丢了可以从 jsonl 还原。

## 快照里和进度有关的字段

运行：

- `status`：`planning` | `running` | `passed` | `failed` | `escalated` | `error`
- `planner`：`{ vendor, harness, adapter }`
- `usage` / `listCostUsd`
- `quota.vendors[]`：每个厂商是否在冷却，以及各窗口的 `usedTokens`、`limitTokens`、`remainingTokens`
- `error`

任务：

- `status`：`pending` | `running` | `passed` | `escalated` | `failed`
- `executor` / `reviewer`
- `round` / `maxRounds`
- `verdict`：`pass` | `reject`
- `reasons` / `feedback`
- `usage` / `listCostUsd`
- `rounds[]`：每一轮的执行者、审查者、测试退出码、结论、故障转移

## 事件

值得推送（写入全局 `events.jsonl`，并在配置了 webhook 时 POST）的 `type`：

| type | 何时 |
| --- | --- |
| `task_rejected` | 测试失败、审查 reject、执行器/审查器非零退出 |
| `escalated_to_planner` | 轮次用尽，开始重写这一条 |
| `escalated_to_human` | 没有跨厂商审查者、重写失败，或重写后仍不通过 |
| `quota_failover` | 429，或偏好厂商没有余量 |
| `quota_exhausted` | 这个角色已经没有可调用的厂商 |
| `run_finished` | 运行进入终态。`data.status` 是最终状态 |

POST 正文就是事件 JSON。请求头 `content-type: application/json` 和 `x-orch-event: <type>`。webhook 失败只追加 `webhook_error`，不改变运行结果，也不会再次推送。

其他事件（`run_started`、`executor_assigned`、`task_passed` 等）只在该运行的 `events.jsonl` 里，方便复盘，默认不推送。

## 查询

```bash
orch status --config orch.yaml
orch status --config orch.yaml --json
orch status --config orch.yaml --run <id> --json
orch status --config orch.yaml --run <id> --task <taskId>
orch status --config orch.yaml --events
```

退出码：找到记录为 0；指定的 run/task 不存在为 1。

MCP（`orch mcp --config orch.yaml`，一行一个 JSON-RPC）：

- `run_plan`：`{ planPath }` 或 `{ planText }`。外层 harness 当大脑时用它启动流水线。
- `list_runs`
- `get_run`：`{ runId }`
- `get_task`：`{ runId, taskId }`
- `list_events`：`{ limit? }`，只返回值得推送的事件

工具结果在 `content[0].text` 里，是 JSON 字符串。找不到对象时 `isError: true`。
