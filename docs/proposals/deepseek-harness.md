# 方案：把 DeepSeek Harness 接成第二档 runtime

状态：待评审。依据的源码是 `deepseek-ai/deepseek-harness`，提交 `39163dd3`，版本 `0.2.2-rc.3`（2026-11-13）。下文每条事实都标了出处：**[源码]** 表示在这个提交里读过代码或包内 README；**[未验证]** 表示要靠冒烟测试确认。dsh 还是开发者预览版，README 写明会有不兼容的改动，协议也没有版本协商。

## 1. 结论

dsh 自带一个和 Codex app-server 很像的进程外接口：`dsh --profile sdk`，在 stdio 上跑换行分隔的 JSON-RPC **[源码 packages/sdk]**。它可以按 Codex 的路子接成第二档：权限归 harness，内核只转发 harness 自己发来的审批请求。

和 Codex 比，有三处不一样，方案要专门处理：

| | Codex app-server | dsh SDK |
|---|---|---|
| 审批请求带不带参数 | 带（命令、cwd、改动） | **不带**，只有 `toolName`、`callId?`、`reason?`；参数要从之前推送的会话事件里按 `callId` 找 **[源码 user-approval/src/index.ts:126「callId links to an already presented tool call, so arguments are not duplicated here」]** |
| aoa 自己的工具怎么给模型 | `dynamicTools` | 协议里**没有**动态工具；要通过 profile patch 挂一个 MCP server **[源码 sdk/protocol/src/types.ts 的方法表]** |
| 怎么中途停下 | `turn/interrupt` | **没有**取消方法，只能结束进程 **[源码 sdk/protocol README「No cancel or session-close methods」]**；会话锁是 `flock`，进程一死就释放，之后可以 `session/resume` **[源码 session-persistence-jsonl README]** |

## 2. 协议映射

| dsh | aoa |
|---|---|
| `initialize {cwd, provider, model, approvalRequests: true, capabilities: {userQuestions: true}}` | 每次 run 都起一个子进程并做一次握手。`provider`/`model` 来自 agent 配置 **[源码]** |
| `session/prompt {sessionId, contentBlocks}`：未知的 id 会建一个新会话 | 新会话：`sessionId` 由 aoa 生成，作为 `sessionRef` **[源码]** |
| `session/resume {sessionId}` | 恢复的会话先发 resume，再发 prompt；中断的最后一轮由 dsh 自己修复 **[源码]** |
| `session.status` 变成 `idle`，或 `session/wait` | run 结束（silent，或已经 `notify` 过）**[源码]** |
| `session.event` | 按 `callId` 缓存工具调用的参数，供审批请求使用 **[未验证：工具调用事件是否总在 `approval/request` 之前送达]** |
| `approval/request {sessionId, toolName, callId?, reason?}` | 拼成 `PermissionAsk`：`tool` = `dsh:<toolName>`，`args` = 缓存里的参数；找不到参数时放 `{callId}` 或 `{item: 序号}`，保证它不会碰上别的许可，做法和 Codex 一样。`allow` → `allowed-once`；`defer` → `rejected`，然后结束进程，run 以 deferred 结束 |
| `user-question/ask` | 和 Codex 一样：回答「这里没人能回答，需要用户决定就调 `ask_user`」；也可以改回 `{cancelled: true}` |
| 进程退出或 RPC 出错 | 抛错，由内核重试 |

许可和重问：照搬 Codex 的流程。用户批准后，内核记一条许可；下一次 run 恢复同一个会话，输入里说明「这个操作已获批准，照原样再做一次」。dsh 再次请求审批时，`tool` 和 `args` 都深度相等，内核直接回 `allow`。前提是能拿到参数，见第 5 节第 1 点。

## 3. aoa 自己的工具：MCP 桥

每次 run，aoa 在本进程里起一个只监听 `127.0.0.1` 的 streamable-http MCP server，端口随机，带一个每次 run 新生成的 token。aoa 的工具都挂在它上面：记忆、`notify`、`wake_me_at`、`cancel_wake`、`ask_user`、`send_to`。然后通过 `--patch` 给 dsh 加一行 `dsh-mcp-client`，指向这个地址 **[源码：SDK client 支持 `patches`；mcp-manager README 给了 patch 写法]**。

MCP 调用落回 aoa 进程后直接走 `Tool.invoke`，所以 aoa 的工具留在第一档，和 pi、Codex 的动态工具一样。aoa 的工具返回延后时，回一句「等用户决定」，然后结束进程。

**[未验证]** MCP 工具调用会不会经过 dsh 的 `tools/pre-execute` 和审批。如果会，aoa 的工具就要过两道审批；在 `never` 策略下还会直接被拒。需要在 patch 里把这个 server 的工具设成免审批，或者确认它们本来就不问。

## 4. 隔离、权限和凭据

- **`dshHome`**：SDK client 可以指定一个独立的 dsh home **[源码 sdk/client README]**。方案：用 aoa 自己的目录 `<dataDir>/dsh-home`，不带用户的 dsh 插件、MCP 和设置。这和 Codex 那边「默认关掉用户扩展」是同一个原则。代价是权限预设也由 aoa 写进 patch：默认 `workspace-write` + `ask`。用户在 aoa 配置里写 `dsh.preset` 可以改。
- **API key**：dsh 默认读 `DEEPSEEK_API_KEY` **[源码 llm-deepseek-api-key README]**。aoa 启动时会把配置里每个 `apiKeyEnv` 从自己的环境里删掉，所以子进程拿不到这个 key。方案：dsh agent 的配置里写 `apiKeyEnv`，aoa 用 `keyOf` 读出来，只放进子进程的 env。SDK client 的 `env` 选项会整个替换子进程环境 **[源码]**。aoa 本来就替 pi 持有模型 key，这样做不扩大 aoa 接触 key 的范围。
- **运行环境**：dsh 要求 Node ≥ 24.9 **[源码 package.json engines]**。启动命令是 `npx @deepseek-ai/dsh --profile sdk` 还是本机全局安装，由配置项 `dsh.command` 决定，默认 `dsh`。

## 5. 风险和待确认

1. **参数关联**：如果工具调用事件不一定在审批请求之前到达，或者请求里没有 `callId`（比如沙箱提权），许可就只能按工具名匹配。这时要选：(a) 这类请求一律延后，批准后放行同名的下一次调用；(b) 直接拒绝。我建议 (a)，并且把审批请求里的「问什么」写清楚，让用户知道批准的是一类操作。
2. **结束进程的代价**：每次延后都要杀进程、下次 run 冷启动。冷启动时间 **[未验证]**。
3. **不稳定的协议**：没有版本协商。适配器只依赖握手里返回的 `serverInfo.name`，第一次握手就校验，遇到不认识的就直接失败。
4. **Python 那边的实现**、ACP 模式、headless 模式都不用。ACP 已经因为「审批可选」被否了；headless 是一次性任务，没法恢复会话。

## 6. 范围和步骤

1. `packages/runtime-dsh`：协议子集、子进程、事件参数缓存、审批映射、MCP 桥。先针对 fake server 写测试。
2. 配置、接线、`status`/网页、文档：`runtime: "dsh"`。权限归 harness，只能用在本地模式。审查角色先不支持，原因和 Codex 一样：aoa 的只读规则管不到它。
3. 冒烟测试，只在 `AOA_DSH_SMOKE=1` 时跑：真实的 dsh 加真实的 DeepSeek key，验证第 2、3 节标 [未验证] 的几项。

不做：dsh 的 Web UI、它的子代理和 team、把用户 dsh home 里的东西带进来。
