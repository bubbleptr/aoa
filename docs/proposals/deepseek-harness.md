# 方案：把 DeepSeek Harness 接成第二档 runtime

状态：第二版，已吸收 reviewer 的评审意见（local:7f8f5467，7 条全部采纳）。依据的源码是 `deepseek-ai/deepseek-harness`，提交 `39163dd3`，版本 `0.2.2-rc.3`（2026-11-13）。**[源码]** 表示读过代码，**[冒烟]** 表示只能靠真机测试确认。dsh 还在开发者预览阶段，会有不兼容的改动。

## 1. 结论

用 `dsh --profile sdk`：stdio 上换行分隔的 JSON-RPC **[源码 packages/sdk]**。接法和 Codex 一样走第二档：dsh 自己的工具归 dsh 管，aoa 只转发 dsh 发来的审批请求；aoa 自己的工具仍是第一档。

为什么用 SDK，不用另外两种：
- ACP：当初定的原则是审批可选的协议不用。
- headless：它也能按 `--session-id` 恢复会话 **[源码 bundle/headless/src/startup.ts:71]**，但它是一次性命令，没有审批回调，拿不到 dsh 的审批请求。

和 Codex 的三处不同：

| | Codex app-server | dsh SDK |
|---|---|---|
| 审批请求里的参数 | 有 | 没有：只有 `toolName`、`callId?`、`reason?`。参数要从更早到达的会话事件里取（见 2.1）**[源码 user-approval/src/index.ts:126]** |
| aoa 工具的入口 | `dynamicTools` | 没有动态工具，改用 MCP 桥（见 3）**[源码 sdk/protocol/src/types.ts]** |
| 怎么中途停下 | `turn/interrupt` | 没有取消方法，只能 `shutdown` 或结束进程（见 4）**[源码 sdk/protocol/src/types.ts:218]** |

## 2. 协议映射

| dsh | aoa |
|---|---|
| `initialize {cwd, provider, model, approvalRequests: true, capabilities: {userQuestions: true}}` | 每次 run 起一个子进程，握手一次 **[源码]** |
| `session/prompt {sessionId, contentBlocks}`，未知 id 时新建会话 | 新会话的 `sessionId` 由 aoa 生成，作为 `sessionRef` **[源码]** |
| `session/resume {sessionId}` | 已有会话先 resume，再 prompt **[源码]** |
| `session.status` 进入 `idle` | run 结束 **[源码]** |
| `session.event` | 同步维护一份调用表（2.1） |
| `approval/request` | 见 2.2 |
| `user-question/ask` | 回 `{cancelled: true}`。dsh 自带的提问工具已在 patch 里关掉，正常不会走到这一步（见 5） |
| 进程退出、RPC 出错 | 抛错，由内核重试 |

### 2.1 调用表

- 普通调用：先在会话里提交一条 `tool/call` 事件，然后才进入 prepare 和审批 **[源码 core/tools/src/batch.ts:247, :160]**。
- PTC 子调用：先发 `tool/ptc-dispatch-start`，键是 `subCallId` **[源码 core/tool-executor-ptc/src/ptc.ts:539]**。
- SDK 服务端把这些事件和审批请求按顺序写到同一个 stdout **[源码 sdk/server/src/server.ts:164, sdk/protocol/src/transport.ts:266]**，所以正常情况下参数事件一定先到。
- 沙箱提权的请求同样带 `callId` **[源码 shell/tool-bash/src/index.ts:283]**。
- 调用表的键是 `(sessionId, callId 或 subCallId)`，值是 `{tool, args}`。收到事件时立即同步写入，不放进异步队列。

### 2.2 审批

- 查到调用：拼成 `PermissionAsk`，`tool` = `dsh:<toolName>`，`args` = 调用表里的参数，交给 `RunInput.ask`。
  - `allow` 回 `allowed-once`。
  - `defer` 回 `rejected`，然后按第 4 节停下，run 以 deferred 结束。
- 查不到调用（没带 `callId`，或表里没有）：直接回 `rejected`，不问用户。理由附一句话，说明 aoa 认不出这次调用，并记一条日志。**不按工具名放行**：内核只按工具名加参数深度相等来消费许可（`packages/kernel/src/permission.ts`），放宽这一条就可能把许可用到另一条命令上。
- 许可和重问照搬 Codex：批准后，下一次 run 恢复会话，告诉模型「已获批准，照原样再做一次」；dsh 再来请求时，`tool` 和 `args` 深度相等，内核直接放行。

## 3. aoa 工具：MCP 桥

- **入口**：每次 run，aoa 在本进程起一个 streamable-http MCP server，只监听 `127.0.0.1`，端口随机，路径里带一个每次 run 新生成的 token。用的是 aoa 现有的 `@modelcontextprotocol/sdk`。通过 patch 给 dsh 加一行 `dsh-mcp-client`，server 名 `aoa`，指向这个地址。
- **调用身份**：dsh 发给 MCP 的只有 `name` 和 `arguments`，不带它自己的 callId **[源码 mcp/mcp-client/src/tools.ts:180]**。但这次调用对应的 `tool/call` 事件已经在调用表里了。桥按「同一会话、工具名对应、参数深度相等、还没被认领过、最早的那条」认领一条记录，内核 call id 用 `<session>:<dsh callId>`。同名同参数的并发调用本来就是同一个操作，按先后顺序认领即可，结果是确定的。认领不到就返回 MCP 错误「无法识别这次调用」，不执行。
- **审批**：MCP 工具也走 dsh 的工具管线，但 `tools/pre-execute` 默认放行，只有某个 gate 返回 `ask` 才会请求审批 **[源码 core/tools/src/pipeline.ts:200, mcp/mcp-client/src/tools.ts:211]**。所以不需要专门开免审批的例外。实现时要确认所用 profile 里没有哪个 gate 对 `aoa` 的工具返回 `ask`。如果有，在 patch 里写明例外。
- **延后和答复**：
  - aoa 工具返回 deferred 时，桥回一句「等用户决定」，然后按第 4 节停下。
  - 用户批准后由内核执行，结果通过 `RunInput.answer` 写进下一次的输入，告诉模型「已经执行过，不要再调」，和 pi、Codex 的写法一致。
  - 重试同一批事件时，相同的 dsh callId 会得到相同的内核 call id，日志里已有结果的直接重放，不会再执行一次。

## 4. 停下和恢复

dsh 的 checkpoint 和事件推送是两回事 **[源码 session/session-checkpoint-policy/src/index.ts:53]**。恢复时，已经记录但没有持久化结果的调用会被标成 `TOOL_OUTCOME_UNKNOWN` **[源码 core/session/src/repair.ts:16, :34]**。所以停下要按固定顺序：

1. 延后时，先回复手上的请求：审批回 `rejected`，aoa 工具回「等用户决定」。之后再来的审批请求和 MCP 调用一律拒绝，不再问内核。
2. 发 `shutdown`，它会等 agent 停下、持久化完成再退出 **[源码 sdk/server README]**。最多等 10 秒，超时依次 SIGTERM、SIGKILL。会话锁是 flock，进程一死就释放 **[源码 session-persistence-jsonl README]**。
3. 下一次 run 用 `session/resume`。在途调用的结果是未知的，模型会从 dsh 修复后的历史里看到这一点，和 Codex 被中断时一样。

正常结束（`idle`）也走 `shutdown`。异常退出时直接抛错，由内核重试。

## 5. 隔离、范围、凭据和版本

- **独立 home**：`dshHome` 用 `<dataDir>/dsh-home`，不带用户的 dsh 插件、MCP 和设置，和 Codex「默认关掉用户扩展」是同一个原则。权限预设由 aoa 写进 patch：默认 `workspace-write` + `ask`，配置 `dsh.preset` 可以改。
- **关掉不用的能力**：sdk profile 叠在 base 之上，base 会注册子代理、team、goal、workflow、jobs 和插件管理 **[源码 bundle/base/cordis.patch.yml:363 起]**，sdk 自己还带一些工具 **[源码 bundle/sdk-app/cordis.patch.yml]**。独立 home 去不掉这些。aoa 的 patch 要逐行关掉：`subagent*`、`tool-subagent*`、`agent-team`、`tool-agent-team`、`goal`、`goal-round-driver`、`command-goal`、`tool-goal`、`workflow-ptc`、`tool-workflow`、`jobs`、`tool-jobs`、`plugin-manager`、`tool-plugin-manager`，以及 dsh 的提问和调度工具。这样提问只有 aoa 的 `ask_user`，定时只有 aoa 的 `wake_me_at`。实现时以 profile 的实际组成为准，逐项核对行 id，并用测试确认关掉的工具没有出现在模型可见的工具列表里。
- **API key**：dsh 默认读 `DEEPSEEK_API_KEY` **[源码 llm/llm-deepseek-api-key README]**。aoa 启动时会把配置里的 `apiKeyEnv` 从自己的环境里删掉。dsh agent 的配置写 `apiKeyEnv`，aoa 用 `keyOf` 读出 key，只放进子进程环境；SDK 的 `env` 选项会整个替换子进程环境。
- **版本**：握手里的 `version` 写死是 `0.0.1`，没法用来区分版本 **[源码 sdk/server/src/server.ts:254]**；官方 client 要求它和 dsh 的包版本完全一致 **[源码 sdk/client/src/launch.ts:60]**。aoa 也这样做：启动前读 dsh 的包版本，要求等于 aoa 测试过的版本（目前是 `0.2.2-rc.3`，代码里一个常量），不一致就报错并说明原因。命令由 `dsh.command` 配置，默认 `dsh`；dsh 需要 Node ≥ 24.9。

## 6. 范围和步骤

1. `packages/runtime-dsh`：协议子集（手写，不加依赖）、子进程、调用表、审批映射、MCP 桥、停下顺序、版本检查。全部针对 fake server 先写失败测试。
2. 配置、接线、`status` 和网页、文档：`runtime: "dsh"`，权限归 harness，只能用在本地模式，审查角色先不支持。
3. 冒烟测试，只在 `AOA_DSH_SMOKE=1` 时跑：真实 dsh 加真实 key，测冷启动时间、MCP 工具没有被 gate 拦、关掉的工具确实不可见、杀进程后能恢复。

不做：dsh 的 Web UI、子代理和 team、PTC 模式下 aoa 工具的特殊处理（PTC 子调用照样进调用表，不另做别的）。
