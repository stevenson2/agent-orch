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
| 建会话是 `v4/command`，信封 `type: "createSession"`，`sessionId: null`，`payload.workspaceId` 是工作区，`payload.config.mode` 是 `plan`/`build`/`edit`/`yolo`，首条任务放在 `payload.firstInput.text`。`config` 和 `firstInput.planEnabled` 都是可选字段 | `packages/shared/src/zcode-protocol-v4/command.ts`，`create-session-config.ts` |
| `session/requestRuntimePreferences` 的结果 schema 是 `.strict()`。当前主线有 `toolSearchMode`（默认 `"off"`）和 `modelContextBudgetStrategy`（默认 `"preflight-v1"`）；`nativeSearchEnhancementsEnabled` 没有默认值。不认识的键是 zod `unrecognized_keys`。兼容回退只在 JSON-RPC `-32601` / `-32020` 时发生，schema 校验失败会让 `createSession` 失败 | `packages/shared/src/zcode-protocol/index.ts` 的 `zcodeSessionRuntimePreferencesResultSchema`，`apps/zcode-cli/packages/bootstrap/src/zcode-protocol/server-operations.ts` 的 `requestSessionRuntimePreferences` |
| 订阅 `v4/conversation/subscribe`，主题 `conversation/<sessionId>`，`clientMode: "desktop-continuous"`。快照和增量走通知 `v4/conversation/frame` | `packages/shared/src/zcode-protocol-v4/transport.ts` |
| 终态是快照 `control.phase`：`completedSuccess`、`completedInterrupted`、`error`。助手正文是 `assistantText` 行。用量在 `usage.cumulative.inputTokens` / `outputTokens` | `packages/shared/src/zcode-protocol-v4/snapshot.ts`，`rows.ts` |
| 模型请求前，agent 向父进程发 `interaction/requestProviderRuntimeHeaders`。桌面 Host 用登录态解析出 `requestAuth.apiKey` 再回给 agent。成功体是 `{headersApplied:true, requestAuth:{apiKey}}` | `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/provider-runtime-headers.ts`，`packages/services/src/zcode-agent/zcodeAgentService.ts` 的 `respondProviderRuntimeHeaders` |
| `app-server` / `agent-server` 把请求头 `X-Title` 写成 `Z Code@electron`。普通 `zcode -p` 写成 `Z Code@cli` | `apps/zcode-cli/packages/bootstrap/src/model-config.ts` 的 `detectDefaultProviderSourceTitle` |
| 打包后的内置供应商配置在 `resources/config/provider/zcode-builtin.json`，和 `resources/glm/` 同级。桌面 Main 用 `process.resourcesPath` 拼这条路径 | `packages/desktop/electron-builder.config.js` 的 extraResources，`packages/desktop/src/main/desktopProviderConfig.ts` |
| Host 拉起 agent 前同时写入 `ZCODE_BUILTIN_PROVIDER_CONFIG_FILE` 和 `ZCODE_PERSONAL_PROVIDER_CONFIG_FILE`（`{数据目录}/.zcode/v2/provider_config.json`）。两个都有时，CLI 不再按入口脚本猜路径 | `packages/provider-node/src/runtime-paths.ts` 的 `createNodeProviderRuntimePathEnv`，`packages/services/src/node.ts` 的 spawn env，`apps/zcode-cli/packages/cli/src/provider-runtime-env.ts` |
| 不设这两个变量时，CLI 只试两个候选：入口目录下的 `provider/zcode-builtin.json`，以及从入口向上五级的 `config/provider/zcode-builtin.json`（给仓库里的 `apps/zcode-cli/.../dist` 用）。入口是 `resources/glm/zcode.cjs` 时，前者变成 `resources/glm/provider/...`，后者落到 `AppData/config/provider/...` | `apps/zcode-cli/packages/cli/src/provider-runtime-env.ts` 的 `resolveBundledZCodeBuiltinProviderConfig` |
| CLI 和桌面共用 `~/.zcode/v2/credentials.json`（可用 `ZCODE_DATA_BASE_DIR` 改）。值是 `enc:v1:` 加 AES-256-GCM。口令优先 `ZCODE_CREDENTIAL_SECRET`，否则由平台、主目录、用户名拼出 | `apps/zcode-cli/packages/adapters/src/auth/credential-cipher.ts`，`shared-credentials.ts` |
| 个人 Coding Plan 的 Key 键名是 `account-provider:coding-plan:<providerId>:account:<identity>:api-key`。独立 CLI 只登记个人 Coding Plan；团队套餐、Start Plan、闲时计划由桌面 Host 解析 | `apps/zcode-cli/packages/bootstrap/src/app/standalone-account-provider-runtime.ts` |
| 权限反向请求是 `interaction/requestPermission`，应答 `{decision:"allow"|"deny"|"escalate"|"modify"}`。浏览器反向请求是 `interaction/browserList` 与 `interaction/browserExecute` | `packages/shared/src/zcode-protocol/index.ts`，`packages/shared/src/zcode-protocol-legacy-types.ts` |
| Web 模式 `zcode --web` 是另一条宿主：Hono 在本机提供 `/api/server-info` 和 `/ws`，默认开发端口 3030，令牌是 `ZCODE_SERVER_AUTH_TOKEN`。它不是桌面窗口，agent 默认也不带 `--surface desktop` | `packages/server/src/http.ts`，`scripts/zcode-distribution/runner.mjs` |

`packages/client` 是界面通过 MessagePort 或 WebSocket 访问 Host 服务的 RPC 代理，不是给外部脚本用的 Agent SDK。`packages/rpc` 是这套 VS Code 风格的 IPC，桌面走 MessagePort，Web 走 WebSocket。

### 适配器实际做的事

`zcode-desktop` 不能附着到已经打开的桌面窗口，因为那条 MessagePort 出不了进程。它做的是 Host 启动 agent 的同一步：找到官方安装包里的 Electron 可执行文件和 `resources/glm/zcode.cjs`，用 `ELECTRON_RUN_AS_NODE=1` 启动

`app-server --stdio --surface desktop --cwd <任务目录>`

然后自己当协议父进程：等 `startup/storageState` 的 `ready`，发 `createSession`，订阅会话帧，把助手正文和用量收回来。`plan` / `review` 用 `mode: plan`。执行默认 `edit`，只有配置写成 `yolo` 或 `build` 才换。`interaction/browserList`、`interaction/browserExecute`，以及工具名像 browser / computer use / cua 的权限请求，一律拒绝。

`createSession` 只带当时就要用的字段：`workspaceId`、`config.mode`、`firstInput.text`。`planEnabled` 只在规划/审查时带上，执行不带 `false`。建会话过程中 agent 会反向调用 `session/requestRuntimePreferences`。当前主线的结果 schema 是 `.strict()`，不认识的键会报 zod `unrecognized_keys`，而这条错误**不会**走「方法不存在」的兼容回退（回退只认 JSON-RPC `-32601` 和 `-32020`），于是整次 `createSession` 变成 `status: failed`、`reasonCode: fault.command.executionFailed`。适配器默认只回三个老字段：`nativeSearchEnhancementsEnabled`、`memoryEnabled`、`askUserQuestionAutoResolutionEnabled`。`toolSearchMode` 和 `modelContextBudgetStrategy` 只有在 `zcode.cjs` 正文里真有这两个名字时才加（当前主线给它们设了默认值，缺了也能过）。如果应答仍然被拒，并且失败消息里是 `unrecognized_keys`，就去掉列出的键，用新的 `commandId` 再发一次 `createSession`，只重试这一次。

启动时如果安装根下有 `resources/config/provider/zcode-builtin.json`（`glm` 的同级，不是 `glm/provider`），适配器把它写进 `ZCODE_BUILTIN_PROVIDER_CONFIG_FILE`，并把 `ZCODE_PERSONAL_PROVIDER_CONFIG_FILE` 指到 `~/.zcode/v2/provider_config.json`（或 `ZCODE_DATA_BASE_DIR` 下的同一相对路径）。这是桌面 Host 交给 agent 的那两个变量。不写的话，`app-server` 会按 `zcode.cjs` 的位置自己找，在这套安装布局里会报「无法定位 CLI ZCode Built-in Provider Config」，第二条路径是向上五级之后的 `AppData\config\provider\zcode-builtin.json`。

凭据：agent 问起 `interaction/requestProviderRuntimeHeaders` 时，适配器只解密共享凭据文件里的个人 Coding Plan Key 并回 `requestAuth.apiKey`。它不实现桌面 Host 的团队套餐、Start Plan 和权益查询。找不到唯一匹配的 Key 时，这次模型请求会失败，而不是猜一个令牌。

不设置 `ZCODE_APP_SERVER_AUTH_MODE`。当前主线源码里，协议进程总会向父进程要运行时头；已发布的 CLI 文档还描述过 `standalone` / `host` 两种模式。两边不一致，以你安装的那一版为准。

### 需要你本机验证

- 用桌面里已经登录的账号跑一条小任务，看用量页是否和在 GUI 里发同一句话走同一条 1.5 倍配额。源码能确定的是：同一凭据文件、同一 `app-server` 二进制、`X-Title: Z Code@electron`、`--surface desktop`。源码里没有 1.5 这个常数，服务端按什么区分 GUI 和 CLI，这里看不到。
- 桌面已经打开、并且占着同一个工作区的会话库时，第二个 `app-server` 可能停在 `waiting_for_lock`。编排器的任务在单独的 git worktree 里，一般是另一份库；若你把 cwd 指回桌面正在用的目录，需要看它会不会一直等锁。
- 安装路径因平台而异。Windows 默认试 `%LOCALAPPDATA%\Programs\ZCode\ZCode.exe` 以及它旁边的 `resources\glm\zcode.cjs`。对不上时，把 `command` 写成可执行文件的绝对路径。用户这台机器上，内置供应商配置在 `resources\config\provider\zcode-builtin.json`，`resources\glm\provider\` 不存在。适配器已按这个布局传环境变量；若你的包把文件放在别处，需要再对一下启动日志里还有没有「无法定位 CLI ZCode Built-in Provider Config」。
- 权限档位是否和 GUI 里的 edit / plan 一致，以你这版 `createSession` 的行为为准。
- 用户已测通：Windows 上官方安装包跑完一整轮（dsh 规划 → zcode-desktop 执行 → dsh 审查，一轮通过）。同一台机器的内置供应商配置在 `resources\config\provider\zcode-builtin.json`。
- 用户已测到失败、本仓库据此改了协议：Ubuntu 上 `/opt/ZCode` 是更老的包，`/opt/ZCode/resources/glm/zcode.cjs` 里没有 `toolSearchMode` 这几个字，供应商配置在 `/opt/ZCode/resources/config/provider/zcode-builtin.json`。`createSession` 被拒，消息是 `unrecognized_keys`，键只有 `toolSearchMode`。改完之后需要再在这台机器上跑一条小任务，确认会话能建起来。规划模式若被旧 schema 丢掉 `planEnabled`，会退回只带 `mode: plan`，这一步也要看实际行为。

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
| DeepSeek harness | `dsh` | 默认 `dsh --profile headless "<任务>"`。`command` / `command_args` 可换成别的启动方式；`args` 非空时替换自动加上的 `--profile headless`，任务文本仍是最后一个参数。`--json`、`--session-id` 只有同一组参数的 `--help` 里出现时才加 | 用户实测 dsh 0.1.5-rc.2：帮助里只有 `[task...]` 和 `-h`，没有 `--json` / `--session-id`。推理写在 stderr，最终回答写在 stdout，然后退出。带上 `--json` 会报 `unknown option '--json'`。没有 `--cwd`，本适配器把子进程工作目录设成任务 worktree。规划/审查从最终回答里取围栏代码块或第一个配平的 JSON 对象。官方文档里的 `--json` NDJSON 只在那一版帮助里真有这个旗标时使用。另有 `dsh --profile acp`，本适配器不使用。Linux 从源码安装时，用户的 `deepseek-harness` 命令打开的是桌面应用；无头要自己用 `node --import tsx/esm apps/cli/src/bin.ts`，并设置 `TSX_TSCONFIG_PATH` 和 `DEEPSEEK_API_KEY`，见下面一节。 |
| acpx | `acpx` | `acpx <agent> exec --format json --cwd <dir> --approve-reads\|--approve-all "<task>"` | [acpx README](https://github.com/openclaw/acpx) 与 `docs/agents.md` 核实。`exec` 是一次性、不保留会话。规划/审查用 `--approve-reads`，执行用 `--approve-all`。 |
| Claude Code | `command`（示例）或 `acpx claude` | `claude -p` / `claude --print --output-format json`；ACP 为 `npx -y @agentclientprotocol/claude-agent-acp` | `-p`/`--print` 是 Claude Code 与 ccbridge、headless-cli 使用的无头形式。本机未实跑，旗标以你本地的 `claude --help` 为准。 |
| Codex | `command`（示例 `codex exec`）或 `acpx codex` | `codex exec`；ACP 为 `npx -y @agentclientprotocol/codex-acp` | 用户实测：`codex exec` 在 stdin 还开着时会打印 `Reading additional input from stdin...` 并一直等。编排器把 stdin 立刻关掉。连不上 `chatgpt.com` 这类网络错误会单独写进失败说明。Windows 上 npm 全局命令是 `codex.cmd`，编排器会把 npm cmd-shim 展开成 `node.exe` 加脚本，避免多行提示词经过 `cmd.exe`。 |
| Gemini CLI | `acpx`，agent `gemini` | 原生打印：`gemini -p`。ACP：`gemini --acp` | `--acp` 由 acpx 内置注册表核实。`-p` 是 Gemini CLI 常见打印模式，本机未实跑。 |
| OpenCode | `acpx` 或 `command` | ACP 注册表命令是 `npx -y opencode-ai acp`。另有文档中的 `opencode run` | acpx `docs/agents.md` 核实的是 `npx -y opencode-ai acp`，不是单独的 `opencode acp`。`opencode run` 见于 OpenCode 文档，本机未实跑。 |
| Qwen | `acpx`，agent `qwen` | `qwen --acp` | acpx 注册表核实。 |
| Kimi | `acpx`，agent `kimi` | `kimi acp` | acpx 注册表核实。 |
| Cursor | `acpx`，agent `cursor` | `cursor-agent acp`。另有 Cursor headless 文档中的 `agent -p` | acpx 注册表核实 `cursor-agent acp`。`agent -p` 本机未实跑。 |

### dsh：Linux 从源码安装

用户实测：发行包里的 `dsh` 命令可以直接 `dsh --profile headless`。从源码装在 Linux 上时，`deepseek-harness` 这个名字启动的是桌面应用，不是无头 CLI。无头入口是仓库里的 CLI，要用 tsx 加载 TypeScript：

```bash
TSX_TSCONFIG_PATH=/path/to/deepseek-harness/apps/cli/tsconfig.json \
DEEPSEEK_API_KEY=... \
node --import tsx/esm apps/cli/src/bin.ts --profile headless --help
```

编排器不内置这条包装。在 `orch.yaml` 里把 `command`、`command_args` 和 `env` 指过去即可。`args` 留空时仍会自动加上 `--profile headless`，帮助探测也用同一组前缀：

```yaml
deepseek:
  harness: dsh
  adapter: dsh
  command: node
  command_args: ["--import", "tsx/esm", "/path/to/deepseek-harness/apps/cli/src/bin.ts"]
  env:
    TSX_TSCONFIG_PATH: /path/to/deepseek-harness/apps/cli/tsconfig.json
    DEEPSEEK_API_KEY: "填你自己的 key"
```

如果这版 CLI 不要 `--profile headless`，把要保留的参数写进 `args`。`args` 非空就不再自动插入那两个参数，任务文本还是最后一个参数。工作目录仍然是任务的 git worktree。

测试命令在 Unix 上用 `sh -c`，在 Windows 上用 `cmd.exe /d /s /c`。不要在 `test_command` 里假设有 `sh`。
