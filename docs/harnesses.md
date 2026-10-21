# 无头入口核实表

核实日期：2026-10-21。本机没有厂商登录态，也没有安装 ZCode 桌面，所以「源码核实」指读过 [zai-org/ZCode](https://github.com/zai-org/ZCode) 当前 `main` 的对应文件，**不是**在这台机器上跑通了真实订阅。

用户已经在自己的机器上测过两件事，这里按用户实测记录，不把它写成源码结论：

- 官方 ZCode 桌面 GUI 里，智谱订阅的 1.5 倍配额生效。
- 从源码自行编译的 `zcode` CLI（`pnpm build:zcode`）**不**享受这 1.5 倍配额。

适配器：

- `zcode-desktop`：拉起官方桌面包里的 agent，走桌面 Host 用的 stdio 协议。不点 GUI，不用 computer-use / browser-use。
- `zcode`：实验性自编译 CLI。配置里不写 `enabled: true` 时默认关闭，示例倍率是 1，不是 1.5。
- `dsh`：`dsh --profile headless`。
- `acpx`：交给 [openclaw/acpx](https://github.com/openclaw/acpx)。
- `command`：`{prompt}`、`{cwd}`、`{mode}` 各占一个参数，不经过 shell。

## ZCode 桌面：GUI 怎么跟本机后端说话

### 源码核实

桌面是 Electron。窗口里的界面不连 HTTP，也不连 WebSocket。

| 事实 | 出处 |
| --- | --- |
| 每个窗口一个 Host utility process。Renderer 和手机都挂到这个 Host，传输是 Electron `MessagePort`（Host 侧适配 `MessagePortMain`）。开源检出里没有给外部进程用的套接字 | `packages/desktop/src/host/index.ts` 文件头，`packages/desktop/src/host/electronPort.ts`，`packages/shared/src/channels.ts` |
| 没有给外部进程用的监听端口、发现文件或会话令牌。手机远控要挂到同一条 `AttachServicePort`，开源树里没有 relay 实现，也没有本机套接字 | `packages/shared/src/validation.ts` 对 `clientMode` 的约束；`packages/web` 里只剩环境变量声明 |
| Host 拉起的 agent 是 `ELECTRON_RUN_AS_NODE=1`，入口 `resources/glm/zcode.cjs`，参数 `app-server --stdio`。桌面装配再追加 `--surface desktop` | `packages/services/src/zcode-agent/zcodeAgentProcessManager.ts` 的 `resolveElectronRuntimeZCodeAgentCommand`、`applyPresentationSurfaceToCommand`；`packages/shared/src/zcode-agent-runtime.ts` 的 `spawnArgs` |
| 传输是 stdin/stdout 上的一行一个 JSON。请求是 `{id,method,params}`，通知没有 `id`。`--stdio` 会被登记，协议进程只有标准输入输出这一种传输 | `apps/zcode-cli/packages/cli/src/run.ts`，`packages/services/src/zcode-agent/zcodeStdioTransport.ts` |
| 建会话是 `v4/command`，信封 `type: "createSession"`，`sessionId: null`，`payload.workspaceId` 是工作区，`payload.config.mode` 是 `plan`/`build`/`edit`/`yolo`，首条任务放在 `payload.firstInput.text` | `packages/shared/src/zcode-protocol-v4/command.ts`，`packages/services/src/zcode-agent/zcodeTaskServiceAdapter.ts` |
| 订阅 `v4/conversation/subscribe`，主题 `conversation/<sessionId>`，`clientMode: "desktop-continuous"`。快照和增量走通知 `v4/conversation/frame` | `packages/shared/src/zcode-protocol-v4/transport.ts` |
| 终态是快照 `control.phase`：`completedSuccess`、`completedInterrupted`、`error`。助手正文是 `assistantText` 行。用量在 `usage.cumulative.inputTokens` / `outputTokens` | `packages/shared/src/zcode-protocol-v4/snapshot.ts`，`rows.ts` |
| 模型请求前，agent 向父进程发 `interaction/requestProviderRuntimeHeaders`。桌面 Host 用登录态解析出 `requestAuth.apiKey` 再回给 agent。成功体是 `{headersApplied:true, requestAuth:{apiKey}}` | `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/provider-runtime-headers.ts`，`packages/services/src/zcode-agent/zcodeAgentService.ts` 的 `respondProviderRuntimeHeaders` |
| `app-server` / `agent-server` 把请求头 `X-Title` 写成 `Z Code@electron`。普通 `zcode -p` 写成 `Z Code@cli` | `apps/zcode-cli/packages/bootstrap/src/model-config.ts` 的 `detectDefaultProviderSourceTitle` |
| CLI 和桌面共用 `~/.zcode/v2/credentials.json`（可用 `ZCODE_DATA_BASE_DIR` 改）。值是 `enc:v1:` 加 AES-256-GCM。口令优先 `ZCODE_CREDENTIAL_SECRET`，否则由平台、主目录、用户名拼出 | `apps/zcode-cli/packages/adapters/src/auth/credential-cipher.ts`，`shared-credentials.ts` |
| 个人 Coding Plan 的 Key 键名是 `account-provider:coding-plan:<providerId>:account:<identity>:api-key`。独立 CLI 只登记个人 Coding Plan；团队套餐、Start Plan、闲时计划由桌面 Host 解析 | `apps/zcode-cli/packages/bootstrap/src/app/standalone-account-provider-runtime.ts` |
| 权限反向请求是 `interaction/requestPermission`，应答 `{decision:"allow"|"deny"|"escalate"|"modify"}`。浏览器反向请求是 `interaction/browserList` 与 `interaction/browserExecute` | `packages/shared/src/zcode-protocol/index.ts`，`packages/shared/src/zcode-protocol-legacy-types.ts` |
| Web 模式 `zcode --web` 是另一条宿主：Hono 在本机提供 `/api/server-info` 和 `/ws`，默认开发端口 3030，令牌是 `ZCODE_SERVER_AUTH_TOKEN`。它不是桌面窗口，agent 默认也不带 `--surface desktop` | `packages/server/src/http.ts`，`scripts/zcode-distribution/runner.mjs` |

`packages/client` 是界面通过 MessagePort 或 WebSocket 访问 Host 服务的 RPC 代理，不是给外部脚本用的 Agent SDK。`packages/rpc` 是这套 VS Code 风格的 IPC，桌面走 MessagePort，Web 走 WebSocket。

### 适配器实际做的事

`zcode-desktop` 不能附着到已经打开的桌面窗口，因为那条 MessagePort 出不了进程。它做的是 Host 启动 agent 的同一步：找到官方安装包里的 Electron 可执行文件和 `resources/glm/zcode.cjs`，用 `ELECTRON_RUN_AS_NODE=1` 启动

`app-server --stdio --surface desktop --cwd <任务目录>`

然后自己当协议父进程：等 `startup/storageState` 的 `ready`，发 `createSession`，订阅会话帧，把助手正文和用量收回来。`plan` / `review` 用 `mode: plan`。执行默认 `edit`，只有配置写成 `yolo` 或 `build` 才换。`interaction/browserList`、`interaction/browserExecute`，以及工具名像 browser / computer use / cua 的权限请求，一律拒绝。

凭据：agent 问起 `interaction/requestProviderRuntimeHeaders` 时，适配器只解密共享凭据文件里的个人 Coding Plan Key 并回 `requestAuth.apiKey`。它不实现桌面 Host 的团队套餐、Start Plan 和权益查询。找不到唯一匹配的 Key 时，这次模型请求会失败，而不是猜一个令牌。

不设置 `ZCODE_APP_SERVER_AUTH_MODE`。当前主线源码里，协议进程总会向父进程要运行时头；已发布的 CLI 文档还描述过 `standalone` / `host` 两种模式。两边不一致，以你安装的那一版为准。

### 需要你本机验证

- 用桌面里已经登录的账号跑一条小任务，看用量页是否和在 GUI 里发同一句话走同一条 1.5 倍配额。源码能确定的是：同一凭据文件、同一 `app-server` 二进制、`X-Title: Z Code@electron`、`--surface desktop`。源码里没有 1.5 这个常数，服务端按什么区分 GUI 和 CLI，这里看不到。
- 桌面已经打开、并且占着同一个工作区的会话库时，第二个 `app-server` 可能停在 `waiting_for_lock`。编排器的任务在单独的 git worktree 里，一般是另一份库；若你把 cwd 指回桌面正在用的目录，需要看它会不会一直等锁。
- 安装路径因平台而异。Windows 默认试 `%LOCALAPPDATA%\Programs\ZCode\ZCode.exe` 以及它旁边的 `resources\glm\zcode.cjs`。对不上时，把 `command` 写成可执行文件的绝对路径。
- 权限档位是否和 GUI 里的 edit / plan 一致，以你这版 `createSession` 的行为为准。协议字段是按上面的 schema 发的。

## 自编译 ZCode CLI

### 源码核实

`apps/zcode-cli` 提供 `zcode -p "<task>" --output-format text|json|stream-json --mode build|plan|edit|yolo --cwd <dir>`。`-p` 未写 `--mode` 时源码补 `yolo`。本适配器执行默认仍传 `edit`，规划/审查传 `plan`。2026-07 的 [zai-org/feedback#29](https://github.com/zai-org/feedback/issues/29) 说当时的 3.2.5 没有面向用户的 `-p`；2026-10 的公开源码里这些开关已经在 `apps/zcode-cli/packages/cli/src/run.ts`。发行说明里的桌面包没有单独的 `zcode` 命令。本仓库没有编译、也没有实跑这条 CLI。

`X-Title` 在这条路径上是 `Z Code@cli`，见上一节的 `model-config.ts`。

### 用户实测

自编译二进制不享受桌面 GUI 的 1.5 倍配额。所以示例里 `adapter: zcode` 的 `enabled` 是 `false`，`subscription_multiplier` 是 `1`。只有你明确打开，并且接受按 1 倍计费时才用它。

非官方的 [kingsword09/zcode-cli](https://github.com/kingsword09/zcode-cli) 权限模式含 `guarded`，和官方 `plan|build|edit|yolo` 不是同一组名字。

## 其他套件

| 套件 | 本仓库适配器 | 无头入口 | 核实 |
| --- | --- | --- | --- |
| DeepSeek harness | `dsh` | `dsh --profile headless [--json] [--session-id <id>] "<task>"` | 官方文档核实（`packages/bundle/headless/README.md`、`docs` CLI 页）。成功退出码 0，否则 1。`--json` 是 NDJSON。没有 `--cwd`，本适配器把子进程的工作目录设成任务 worktree。另有 `dsh --profile acp`，本适配器不使用。 |
| acpx | `acpx` | `acpx <agent> exec --format json --cwd <dir> --approve-reads\|--approve-all "<task>"` | [acpx README](https://github.com/openclaw/acpx) 与 `docs/agents.md` 核实。`exec` 是一次性、不保留会话。规划/审查用 `--approve-reads`，执行用 `--approve-all`。 |
| Claude Code | `command`（示例）或 `acpx claude` | `claude -p` / `claude --print --output-format json`；ACP 为 `npx -y @agentclientprotocol/claude-agent-acp` | `-p`/`--print` 是 Claude Code 与 ccbridge、headless-cli 使用的无头形式。本机未实跑，旗标以你本地的 `claude --help` 为准。 |
| Codex | `command`（示例 `codex exec`）或 `acpx codex` | `codex exec`；ACP 为 `npx -y @agentclientprotocol/codex-acp` | `codex exec` 见于 Codex CLI 与 headless-cli、Amon Hen。本机未实跑。Windows 上 npm 全局命令是 `codex.cmd`，编排器会把 npm cmd-shim 展开成 `node.exe` 加脚本，避免多行提示词经过 `cmd.exe`。 |
| Gemini CLI | `acpx`，agent `gemini` | 原生打印：`gemini -p`。ACP：`gemini --acp` | `--acp` 由 acpx 内置注册表核实。`-p` 是 Gemini CLI 常见打印模式，本机未实跑。 |
| OpenCode | `acpx` 或 `command` | ACP 注册表命令是 `npx -y opencode-ai acp`。另有文档中的 `opencode run` | acpx `docs/agents.md` 核实的是 `npx -y opencode-ai acp`，不是单独的 `opencode acp`。`opencode run` 见于 OpenCode 文档，本机未实跑。 |
| Qwen | `acpx`，agent `qwen` | `qwen --acp` | acpx 注册表核实。 |
| Kimi | `acpx`，agent `kimi` | `kimi acp` | acpx 注册表核实。 |
| Cursor | `acpx`，agent `cursor` | `cursor-agent acp`。另有 Cursor headless 文档中的 `agent -p` | acpx 注册表核实 `cursor-agent acp`。`agent -p` 本机未实跑。 |

测试命令在 Unix 上用 `sh -c`，在 Windows 上用 `cmd.exe /d /s /c`。不要在 `test_command` 里假设有 `sh`。
