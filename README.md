# agent-orch

多厂商、多 harness 的编码代理编排器。订阅分散在各家自己的客户端里：DeepSeek 在 `dsh` 里最好用，智谱的 1.5 倍配额是在官方 ZCode 桌面里测到的。这个工具把它们接成一条自动流水线，不操作图形界面。

- 强模型只做规划，输出带验收标准的 JSON 任务，不改代码。
- 便宜模型在**该厂商自己的无头 CLI** 里执行。每个任务一个 git worktree。
- 审查者必须来自**另一个厂商**，返回 `pass` 或 `reject`。拒绝后带着理由重做，超过轮次就打回规划者或交给人。
- 按窗口额度和订阅倍率挑人，遇到 429 就换厂商。
- 进度写成只追加的 JSON/JSONL。本机用 `orch status`，别的助手用同一套 MCP 工具，也可以收 webhook。

不用 GUI，也不用 computer-use。强模型的配额不花在点鼠标上。

## 安装

需要 Node.js 22 或更新版本，以及本机已经登录的厂商 CLI。

```bash
npm install
npm test
npm run build
cp orch.example.yaml orch.yaml
```

开发时可以直接：

```bash
npx tsx src/cli.ts --help
npx tsx src/cli.ts run examples/plan.md --config orch.yaml
```

`npm run build` 之后用 `node dist/cli.js`。不编译的话用 `npm run orch -- run examples/plan.md --config orch.yaml`。

## 命令

| 命令 | 作用 | 退出码 |
| --- | --- | --- |
| `orch run <plan.md> [--config orch.yaml] [--cwd <dir>]` | 跑完整条流水线 | 0 通过，2 已升级人工，1 失败 |
| `orch status [--run <id>] [--task <id>] [--events] [--json]` | 读运行快照 | 0；指定的记录不存在则为 1 |
| `orch mcp --config orch.yaml` | stdio MCP | 进程一直开着 |
| `orch doctor --config orch.yaml` | 检查配置，并用 `which` 看命令在不在 | 配置非法则为 1 |

`--cwd` 覆盖配置里的 `workspace`。

## 架构

```text
orch run plan.md
        │
        ▼
   规划者（强模型，只读模式）
        │  JSON 任务列表；工作区 git status 不能变
        ▼
   每个任务一个 git worktree
        │
        ├─ 执行者：得分最低、额度还够的厂商 CLI
        ├─ 编排器自己跑 test_command
        └─ 审查者：另一个厂商，pass / reject
              reject → 下一轮把 feedback 交回执行者
              轮次用尽 → 规划者重写这一条，或升级人工
```

更细的模块划分、得分公式，以及和 acpx、headless-cli、codeswarm、Amon Hen、pal-mcp-server、ccbridge 的关系，写在 [docs/architecture.md](docs/architecture.md)。那些仓库只用来对照设计，源码没有 vendoring 进本仓库。

## 配置

完整示例是 [orch.example.yaml](orch.example.yaml)。核心字段：

```yaml
version: 1
workspace: .
artifacts_dir: .orch
max_review_rounds: 2
on_exhaust: human          # planner 或 human

webhook:
  url: ""                  # 留空则不推送
  timeout_ms: 5000

roles:
  planner:  { prefer: [anthropic] }
  executor: { prefer: [] } # 空列表 = 按得分挑最便宜的
  reviewer: { prefer: [] }

vendors:
  zhipu:
    harness: zcode-desktop
    adapter: zcode-desktop # zcode-desktop | zcode | dsh | acpx | command
    command: ZCode         # 官方桌面安装；自编译 CLI 用 adapter: zcode 且 enabled: false
    subscription_multiplier: 1.5 # 桌面 GUI 上测到的倍率，程序化路径还要本机对账单
    list_cost_per_1k_tokens: 1
    roles: [executor]
    quotas:
      - { name: five_hour, window_seconds: 18000, limit_tokens: 2000000 }
      - { name: weekly, window_seconds: 604800, limit_tokens: 10000000 }
```

`limit_tokens` 填这个 harness 里实际看到的额度。`subscription_multiplier` 只影响排序：有效单价 = 标价 / 倍率。倍率填你在该 harness 里测到的数。用户在官方 ZCode 桌面 GUI 里测到 1.5 倍；自编译的 `zcode -p` 不是这条配额，示例里它是关闭的，倍率 1。得分还要除以剩余比例，快用完的窗口会被让开。公式和故障转移见 [docs/architecture.md](docs/architecture.md)。

示例里的 token 单价和额度都是占位数字。

适配器：

| adapter | 命令形状 |
| --- | --- |
| `zcode-desktop` | 拉起官方桌面包里的 `zcode.cjs app-server --stdio --surface desktop`，用桌面 Host 同一条 stdio 协议建会话、发任务、等终态。不点 GUI，也不开 browser/computer use |
| `zcode` | 实验性。自行编译的 `zcode -p "<任务>" --output-format json\|stream-json --mode plan\|edit\|yolo --cwd <dir>`。默认 `enabled: false`，倍率按 1 配。执行默认 `edit`，审查和规划用 `plan` |
| `dsh` | 默认 `dsh --profile headless "<任务>"`。先看 `--help`，帮助里没有的旗标不加。0.1.5-rc.2 没有 `--json`。没有 `--cwd`，工作目录就是任务的 worktree。`command` / `command_args` / `args` 可换成从源码启动的 `node --import tsx/esm`，见 [docs/harnesses.md](docs/harnesses.md) |
| `acpx` | `acpx <acpx_agent> exec --format json --cwd <dir>`。执行加 `--approve-all`，规划/审查加 `--approve-reads` |
| `command` | `args` 里的 `{prompt}`、`{cwd}`、`{mode}` 换成单个参数，再附上 `mode_args`。不经过 shell |

`command` 用来接 `claude -p`、`codex exec`、`gemini -p`、`opencode run` 这类已经有打印模式的 CLI。提示词放在参数里，不从 stdin 读；子进程的 stdin 会马上关掉，避免 `codex exec` 停在 `Reading additional input from stdin...`。连不上 `chatgpt.com` 这类网络错误会写进失败说明。提示词可能很长，受操作系统参数长度限制。

## 流水线

1. 规划者收到 `ORCH_ROLE: planner` 的提示，只能返回 `{"tasks":[...]}`。每条要有 `id`、`title`、`instructions`、`acceptance`，可选 `test_command`。`id` 只能是 `[A-Za-z0-9._-]+`。
2. 调用前后对比 `git status --porcelain`。规划者改了文件，整次运行记为 `error`，不会进入执行。
3. `git worktree add -b orch/<run>/<task>`。目录在 `.orch/runs/<run>/worktrees/<task>`。原型不自动合并，worktree 留着给人对 diff。
4. 执行者在该目录里改代码。编排器采集 diff。
5. 有 `test_command` 时，编排器在 worktree 里跑它：Unix 用 `sh -c`，Windows 用 `cmd.exe /d /s /c`。失败记一轮 reject，**不调用审查者**，把测试输出交给下一轮执行者。
6. 测试通过后才请另一个厂商审查。`pass` 结束该任务。`reject` 把 `reasons` 和 `feedback` 带进下一轮。
7. 达到 `max_review_rounds`：
   - `on_exhaust: planner`：规划者只重写这一条，再给同样的轮次预算。仍失败则交给人。
   - `on_exhaust: human`：任务状态 `escalated`，写入 `escalations/<task>.json`。

`examples/plan.md` 里已经带了一份 JSON 任务。遵守提示词的模型会原样返回它；删掉 JSON 就变成让强模型自己拆。

审查者只接受这种 JSON：

```json
{"verdict":"pass","reasons":["acceptance met"],"feedback":""}
```

`reject` 同样要有 `reasons`。解析不了就当作 reject。

## 跨厂商验收

审查者的 vendor id 不能等于执行者。配置里没有第二家可以审查时，任务立即升级，原因 `no_cross_vendor_reviewer`，不会退回同一家自己审自己。

示例配置里，执行优先选智谱桌面（标价 1、按 GUI 实测填写的倍率 1.5，有效单价约 0.67），审查则落到 DeepSeek 或 Gemini。若智谱返回 429，执行改走 DeepSeek，审查就改走 Gemini。这个 1.5 是配置里的排序参数；程序化调用是否真的记入桌面配额，见 [docs/harnesses.md](docs/harnesses.md)。

## 远程进度

云端助手从别的机器看进度时，读这些只追加的文件，或调用查询入口。字段、事件和 webhook 正文见 [docs/status.md](docs/status.md)。

```bash
orch status --config orch.yaml --json
orch status --config orch.yaml --run <id> --task hello
orch status --config orch.yaml --events
```

MCP 工具：`run_plan`、`list_runs`、`get_run`、`get_task`、`list_events`。`run_plan` 让任意已接上 MCP 的 harness 当大脑，由 orch 去叫其他 CLI。

```bash
orch mcp --config orch.yaml
```

值得推送的事件会进 `.orch/events.jsonl`：`task_rejected`、`escalated_to_planner`、`escalated_to_human`、`quota_exhausted`、`quota_failover`、`run_finished`。`webhook.url` 非空时，对它们发 POST。请求头 `x-orch-event` 是事件类型。推送失败只记 `webhook_error`，不让流水线失败。

每次状态变化还会往 `runs/<id>/state.jsonl` 追加一整份快照，包含规划者、执行者、审查者、轮次、结论、理由、用量和各厂商剩余额度。`state.json` 是最后一份快照，方便直接看。

请把 `.orch/` 放进项目的 `.gitignore`。流水线也会把它写进 `.git/info/exclude`，避免规划者的干净检查被产物目录干扰。

## 哪些无头入口核实过

详细出处和没核实的旗标见 [docs/harnesses.md](docs/harnesses.md)。摘要：

| 套件 | 入口 | 状态 |
| --- | --- | --- |
| ZCode 桌面 | 官方安装包里的 `zcode.cjs app-server --stdio --surface desktop` | 源码核实传输和会话协议。1.5 倍配额在 GUI 上由用户测到；这条程序化路径是否同一账单，需要你本机确认 |
| ZCode CLI | 自编译 `zcode -p` | 实验性，默认关闭，倍率 1。用户测过：不享受桌面 GUI 的 1.5 倍配额 |
| dsh | `dsh --profile headless "<任务>"`，或自定 `command` / `command_args` / `args` | 用户实测 0.1.5-rc.2：只有任务文本和 `-h`。`--json` 仅在 `--help` 列出时才加。Linux 从源码安装时 `deepseek-harness` 打开的是桌面，无头要用 `node --import tsx/esm` |
| acpx | `acpx <agent> exec --format json --cwd <dir>` | 官方 README 核实 |
| Gemini / Qwen / Kimi / Cursor / OpenCode 的 ACP | `gemini --acp`、`qwen --acp`、`kimi acp`、`cursor-agent acp`、`npx -y opencode-ai acp` | acpx 注册表核实 |
| Claude / Codex / Gemini 打印模式 | `claude -p`、`codex exec`、`gemini -p`、`opencode run` | `codex exec` 已在 Windows 上实跑：stdin 必须关掉。连不上 chatgpt.com 是本机网络，失败说明里会标出来。其余旗标以你本地的 `--help` 为准 |

## 测试

```bash
npm test
npm run typecheck
```

单测用注入的假进程核对 argv、Windows 的 `.cmd` 展开，以及 ZCode 桌面 stdio 协议。端到端用 `tests/fixtures/fake-agent.mjs` 和 `zcode-desktop-fake.mjs` 扮演各家 CLI，跑通：

- 规划 → 执行 → 审查拒绝 → 再执行 → 审查通过
- 执行者 429 后换厂商，审查者仍是另一家
- 执行者全部 429 时 `quota_exhausted`
- 一直拒绝则升级人工，并打 webhook
- 轮次用尽后打回规划者，修订后再通过
- 只有同一厂商能审查时拒绝同厂商验收
- 规划者改了文件则整次失败
- `orch status` 和 MCP `run_plan` / `list_runs` / `get_run` / `get_task`

## 你需要在本机用真实订阅验证的事

1. `orch doctor --config orch.yaml`。Windows 上全局 npm 命令是 `.cmd`，doctor 按 PATH 查找，不依赖 `which`。确认官方 ZCode 桌面已安装并登录；自编译 `zcode` 那条应显示为关闭。
2. 用一个已登录的小任务跑 `zcode-desktop`，对照桌面用量页，确认这次调用是否计入 GUI 那条 1.5 倍配额。细节和源码依据在 [docs/harnesses.md](docs/harnesses.md)。
3. 把 `orch.example.yaml` 里的额度、标价、冷却时间改成账单上的窗口。1.5 只应写在你确认走桌面配额的那条 vendor 上。自编译 CLI 保持倍率 1。
4. 用一个小仓库跑 `orch run examples/plan.md`。看 `.orch/runs/<id>/state.json` 里的执行者和审查者是不是两家，diff 和测试是否符合预期。worktree 不会自动合并。
5. 把 `webhook.url` 指到你的云端助手，确认能收到 `task_rejected` 和 `run_finished`。也可以让那个助手连 `orch mcp`，轮询 `get_run`。
6. 真实模型不一定遵守 JSON。若规划或审查解析失败，运行会按错误或 reject 处理；这时看 `tasks/<id>/round-*-review.txt` 和 `events.jsonl`。

## 许可

MIT，见 [LICENSE](LICENSE)。
