# 无头入口核实表

核实日期：2026-10-21。本机没有厂商登录态，也没有安装这些 CLI，所以下表的「已核实」指的是读过上游文档或源码解读，**不是**在这台机器上跑通了真实订阅。

适配器分成三类：

- `zcode`：按智谱 ZCode 的 `-p` 参数自己组命令。
- `dsh`：按 DeepSeek harness 的 `dsh --profile headless` 自己组命令。
- `acpx`：交给 [openclaw/acpx](https://github.com/openclaw/acpx) 去拉起 ACP 代理。
- `command`：配置里写 argv 模板，`{prompt}`、`{cwd}`、`{mode}` 各占一个参数，不经过 shell。

| 套件 | 本仓库适配器 | 无头入口 | 核实 |
| --- | --- | --- | --- |
| ZCode | `zcode` | `zcode -p "<task>" --output-format json\|stream-json --mode build\|plan\|edit\|yolo --cwd <dir>` | 源码解读与 DeepWiki 对 `apps/zcode-cli/packages/cli/src/run.ts` 的引用一致：`--output-format` 只接受 `text`/`json`/`stream-json`，`--mode` 只接受 `build`/`plan`/`edit`/`yolo`，`-p` 缺省模式是 `yolo`，`--cwd` 必须是已有目录。2026-07 的 [zai-org/feedback#29](https://github.com/zai-org/feedback/issues/29) 仍认为当时的 3.2.5 没有面向用户的 `-p`。后续公开源码同步（截至 2026-10）已经出现这些开关。本仓库未实跑。 |
| ZCode app-server | 不走这条 | `zcode app-server --stdio`（别名 `agent-server`） | 同一份源码解读：`--stdio` 会被接受，但 `run.ts` 并不读取它；发行启动器以 `app-server --stdio` 拉起协议进程，stdout 只留给协议帧。适合长会话，不适合本原型的一次性流水线，所以适配器只用 `-p`。 |
| DeepSeek harness | `dsh` | `dsh --profile headless [--json] [--session-id <id>] "<task>"` | 官方文档核实（`packages/bundle/headless/README.md`、`docs` CLI 页）。成功退出码 0，否则 1。`--json` 是 NDJSON。没有 `--cwd`，本适配器把子进程的工作目录设成任务 worktree。另有 `dsh --profile acp`，本适配器不使用。 |
| acpx | `acpx` | `acpx <agent> exec --format json --cwd <dir> --approve-reads\|--approve-all "<task>"` | [acpx README](https://github.com/openclaw/acpx) 与 `docs/agents.md` 核实。`exec` 是一次性、不保留会话。规划/审查用 `--approve-reads`，执行用 `--approve-all`，避免无头运行停在权限弹窗。 |
| Claude Code | `command`（示例）或 `acpx claude` | `claude -p` / `claude --print --output-format json`；ACP 为 `npx -y @agentclientprotocol/claude-agent-acp` | `-p`/`--print` 是 Claude Code 与 ccbridge、headless-cli 使用的无头形式。本机未实跑，旗标以你本地的 `claude --help` 为准。 |
| Codex | `command`（示例 `codex exec`）或 `acpx codex` | `codex exec`；ACP 为 `npx -y @agentclientprotocol/codex-acp` | `codex exec` 见于 Codex CLI 与 headless-cli、Amon Hen。本机未实跑。 |
| Gemini CLI | `acpx`，agent `gemini` | 原生打印：`gemini -p`。ACP：`gemini --acp` | `--acp` 由 acpx 内置注册表核实。`-p` 是 Gemini CLI 常见打印模式，本机未实跑。 |
| OpenCode | `acpx` 或 `command` | ACP 注册表命令是 `npx -y opencode-ai acp`。另有文档中的 `opencode run` | acpx `docs/agents.md` 核实的是 `npx -y opencode-ai acp`，不是单独的 `opencode acp` 子命令字符串。`opencode run` 见于 OpenCode 文档，本机未实跑。 |
| Qwen | `acpx`，agent `qwen` | `qwen --acp` | acpx 注册表核实。独立的打印子命令未在本次摘录里确认。 |
| Kimi | `acpx`，agent `kimi` | `kimi acp` | acpx 注册表核实。 |
| Cursor | `acpx`，agent `cursor` | `cursor-agent acp`。另有 Cursor headless 文档中的 `agent -p` | acpx 注册表核实 `cursor-agent acp`。若本地二进制叫 `agent`，在 acpx 配置里改命令，不要改本仓库的假设。`agent -p` 本机未实跑。 |

非官方的 [kingsword09/zcode-cli](https://github.com/kingsword09/zcode-cli) 权限模式含 `guarded`，和官方 `plan` 不是同一组名字。本适配器对准 zai-org/ZCode 的 `build|plan|edit|yolo`。

执行默认用 ZCode `--mode edit`（自动改文件）。`--mode yolo` 和 `--browser-use=headless` 都不会自动加上。这个编排器不用 GUI computer-use。
