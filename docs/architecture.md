# 架构

`agent-orch` 把已经登录在本机的厂商 CLI 串成一条流水线。强模型只规划，便宜模型在自己的 harness 里改代码，另一个厂商的模型决定过不过。所有调用都是无头子进程。

```text
plan.md
  │
  ▼
规划者（prefer 列表里的强模型，mode=plan）
  │  只输出 JSON 任务；git status 必须保持不变
  ▼
对每个任务：git worktree add
  │
  ├─ 执行者（有效单价最低且有余量的厂商）
  │     429 → 冷却该厂商，换下一个
  ├─ 在 worktree 里跑 test_command（编排器自己跑，不交给模型）
  │     失败 → 记一次 reject，不调用审查者
  └─ 审查者（vendor 必须不同于执行者）
        pass → 任务完成
        reject → 带反馈再执行，直到 max_review_rounds
                 用尽后：on_exhaust=planner 重写这一条，或升级人工
```

## 模块

| 路径 | 职责 |
| --- | --- |
| `src/adapters/zcode-desktop.ts` | 拉起官方桌面包里的 agent，走 `app-server --stdio` |
| `src/adapters/zcode.ts` | 实验性自编译 CLI：`zcode -p ... --output-format --mode --cwd`，默认关闭 |
| `src/adapters/dsh.ts` | `dsh --profile headless`。先看 `--help`，只有帮助里出现的旗标才追加。纯文本时 stdout 是最终回答 |
| `src/adapters/acpx.ts` | 组装 `acpx <agent> exec --format json` |
| `src/adapters/command.ts` | 通用 argv 模板 |
| `src/quota.ts` | 追加 `quota.jsonl`，按窗口汇总，记录冷却 |
| `src/router.ts` | 按有效单价和剩余比例排序 |
| `src/pipeline.ts` | 规划、worktree、测试、审查、升级 |
| `src/store.ts` | 追加运行快照和事件 |
| `src/webhook.ts` | 把值得推送的事件 POST 出去 |
| `src/query.ts` | `orch status` 和 MCP 共用的读取 |
| `src/mcp.ts` | stdio JSON-RPC：`run_plan`、`list_runs`、`get_run`、`get_task`、`list_events` |
| `src/cli.ts` | `run` / `status` / `mcp` / `doctor` |

适配器接口是 `run({ task, cwd, mode })`，返回 `{ result, diff, usage, exitCode, rateLimited }`。git diff 由编排器在执行之后用 `git add -A && git diff --cached && git reset` 采集，这样未跟踪文件也会出现在审查材料里，工作区本身保持未暂存。

## 路由得分

```text
有效单价 = list_cost_per_1k_tokens / subscription_multiplier
剩余比例 = 各窗口里 (limit - used) / limit 的最小值；没配窗口则视为 1
得分     = 有效单价 / max(剩余比例, 0.05)
```

得分低的优先。`subscription_multiplier` 是你为这条 harness 填的实测倍率，代码不会按厂商名字猜。官方 ZCode 桌面 GUI 上用户测到 1.5；自编译 CLI 不要填 1.5。`limit_tokens` 填该 harness 里实际看到的额度，倍率不再乘一次额度。`enabled: false` 的厂商不参与排序。

`roles.*.prefer` 非空时，仍有余量的偏好厂商排在前面，其他厂商留在后面做故障转移。429、`rate limit`、`quota exceeded` 会写入冷却（默认 900 秒）并换下一家。窗口用尽或正在冷却的厂商不会被选中。

## 跨厂商验收

审查候选人先去掉执行者的 `vendor` id。如果配置里没有另一个厂商能审查，任务直接 `escalated`，原因是 `no_cross_vendor_reviewer`。流水线里还有一道断言：审查者 id 和执行者 id 相同就中止运行。

审查者只能返回：

```json
{"verdict":"pass","reasons":["..."],"feedback":""}
```

或 `verdict: "reject"`。解析失败按 reject 处理。

## 参考项目里拿来的形状

这些仓库只作设计对照，源码没有拷进本仓库，也没有放进要提交的目录。本地如果要再读，可以克隆到 gitignore 的 `refs/`。

| 项目 | 许可（以上游为准） | 本仓库采用的部分 |
| --- | --- | --- |
| [openclaw/acpx](https://github.com/openclaw/acpx) | MIT | 一次性 `exec`、`--format json`、内置 ACP 代理名 |
| [RobertTLange/headless-cli](https://github.com/RobertTLange/headless-cli) | Apache-2.0 | 统一无头入口、orchestrator/worker/reviewer 角色。不用它的 tmux/TUI 路径 |
| [mskutlu/codeswarm](https://github.com/mskutlu/codeswarm) | MIT | 按 CLI 分配规划/执行/审查。codeswarm 的审查者只给意见；这里的审查者必须 pass/reject |
| [Dviros/Amon-Hen](https://github.com/Dviros/Amon-Hen) | MIT | 规划到执行再到审查、轮次上限、不过就停 |
| [BeehiveInnovations/pal-mcp-server](https://github.com/BeehiveInnovations/pal-mcp-server) | 以上游为准 | clink：一个 CLI 把另一个当子代理。这里反过来，外层 harness 通过 MCP `run_plan` 当大脑 |
| [marko3190/ccbridge](https://github.com/marko3190/ccbridge) | MIT | 计划、执行、审查、修复循环，以及落盘的运行产物 |

现有项目没有覆盖的三件事都在这条流水线里：ZCode 和 dsh 的原生适配器、按窗口和订阅倍率路由并在 429 时换厂商、审查者必须来自另一个厂商。
