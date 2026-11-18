# 权限归 harness 的 agent（§12）

runtime 分两档。第一档（内置的 pi，`@aoa-dev/sdk/pi`）自己没有工具，每次调用都走内核的 `Tool.invoke`，由内核裁决、记日志、执行，这一节不改它。第二档是自带工具的 harness（第一个是 Codex app-server，见下一节）：它能做什么由用户在 harness 里配置，内核既不裁决也不执行它的调用，只做两件事：转达 harness 自己提出的询问，以及在用户放行之前扣住不可信的输入。这一节讲内核这边；一致性测试用一个扮演 harness 的脚本 runtime。

- 模式：runtime 的类型说了算（§15「两档 runtime」）。`kind: "kernel"` 是第一档；`kind: "harness"` 是第二档，它同时改两处：`select()` 怎么挑事件，以及 run 拿到什么（`HarnessRunInput` 多一个 `ask`）。原先是 `WorkerOptions.permissions`，第 3 步换成了类型。
- 转达询问：harness 要为一次调用征求同意时，runtime 调 `ask({ callId, tool, args, reason? })`，只会得到 `allow` 或 `defer`。内核对 harness 的调用没有规则，所以不会当场拒绝；用户的拒绝和以前一样，在之后的 run 里通过 `RunInput.answer` 到达。`defer` 时内核建一个新种类 `harness` 的延后调用：审批请求进 outbox、24 小时到期、session 停下、run 以 `deferred` 结束。session 已经在等别的调用时只返回 `defer`，什么都不建也不记，和 `invoke` 的规则一样。新建的询问记一行 `defer`，用掉许可记一行 `allow`（依据写明是哪次批准的许可）；重试时按调用 id 重放的 `allow` 不再记。
- 批准之后不执行，而是发许可。§6「批准之后谁执行」定的是内核自己执行被批准的调用；对 harness 做不到：它的工具在 harness 进程里，内核没有通用的办法替它运行一条命令。所以批准只在 `grants` 表里记一条许可（工具名加参数，属于这个 session，只能用一次），日志里这次调用的结果是一段话，告诉模型调用已批准但还没运行，要用同样的参数再调一次。适配器随后让 harness 重试；harness 再问同一个调用（工具名相同、参数深度相等）时，内核找到没用过的许可，立即答 `allow` 并把许可标为已用。参数不同就不算，照常再问。拒绝和到期和以前一样，`answer` 里带着拒绝，不留许可。
- 许可按调用 id 记下用掉它的那次询问。失败的 run 重试时会用同样的 id 再问，这时直接答 `allow`，不会再问用户一遍。用一个已经被回答过的调用 id 重新询问会抛错：请求、到期定时器和答复都按调用 id 去重，重用的 id 发不出新的请求，session 会永远停着。
- 扣住不可信输入：harness 模式下，一组待处理事件里只要有一条 `trusted = false` 的事件，在用户放行前整组都不会交给 runtime。拦在 `select()` 里，紧挨着「暂停的 session 只能被它的答复唤醒」那条检查：事件保持 `pending`，不认领也不完成，否则等于没人看就把它们用掉了。内核建一个新种类 `admit` 的延后调用并让 session 停在上面；请求写明输入来自哪里（来源、thread、对方 agent 的名字），并引用第一条的前 200 个字符。新 thread 上的事件这时还没有 session，`select()` 当场开一个，把整组事件钉到这个 session 上（`pinEvents`，只设 `resume`，不认领），这样回答它的那条 `approval_answer` 才会落进同一组；没有 thread 的事件也靠这一步找回来。
- 放行的粒度是一批：一次请求覆盖请求发出时那组里的不可信事件，记在延后调用的参数里。用户自己的消息（可信）从不需要放行。批准后，下一次 run 的 `events` 里是这些事件加上那条答复，session 照旧标为 tainted；`answer` 不设，因为模型从没发起过调用。拒绝或到期时，这些事件和那条答复一起变成 `dropped`，runtime 根本不被调用；它们的去重键另记进 `consumed_keys`，重复投递不会再问一遍。
- 请求等待期间新来的不可信事件不算被那次批准放行：带着答复的那组先去掉它们再认领，它们留在 `pending`，下一轮 `select()` 再为它们单独发请求。在等 harness 询问时进来的不可信事件也一样：答复照常送到，不可信的事件之后单独问。所以一个 session 同时只有一个待答的调用，两种新的延后调用也遵守这一条。
- 被某次 run 认领过的不可信事件（`attempts > 0`）不再问：run 失败重试时，延后调用已经删掉，模型也已经见过它们，再问也收不回来。
- 等待放行时，用户在同一 thread 上发的不是 `/approve` 或 `/deny` 的消息不算答复，而是用户自己的消息，和被扣住的那组一起等，放行或拒绝之后照常交给 runtime。对审批来说其他文字算拒绝（§6），对放行不这样，是为了不把用户的话当成拒绝理由吞掉。
- 存储：`deferred.kind` 的 CHECK 多了 `harness` 和 `admit`。SQLite 改不了 CHECK，所以这次迁移按原样重建这张表（列不变，数据照抄），并新建 `grants` 表。许可没有复用 `decisions`：「还没用过」只能靠解析 `basis` 字符串表达，而这次迁移本来就省不掉。`Tx` 多了 `insertGrant`、`listGrants`、`useGrant`、`pinEvents`、`dropEvents`。

哪些一致性测试和权限有关：规范 §9 的 C13（凭据不进上下文）、C14（未授权的调用不执行）、C15（延后时 worker 不闲着）、C16（答复只生效一次）、C20（审批请求只发一次）。在第二档 runtime 上，这几项要么由 harness 自己的配置负责，要么只覆盖它主动询问的那部分调用，需要单独写。另外 C3（重跑不重复副作用）和 C12（恢复会话不重放旧调用）靠的是内核执行工具时记的日志，第二档的工具不经过内核，这两项也不能原样搬过去。其余各项（C1、C2、C4–C11、C17–C19）不涉及谁执行工具，可以直接拿第二档 runtime 跑。

和规范不一致的地方（规范不改）：

- I-PRM-2「没有授权就不执行」只覆盖 harness 主动询问的调用。harness 不问就执行的调用，内核既看不到也拦不住；给这类调用补记录（`record()`）是下一步的事，在那之前 I-PRM-7（每次裁决都有记录）对它们也不成立。I-PRM-6（高风险操作必须由人审）同样取决于用户怎么配置 harness。
- §6.2 的 `Policy`（未知调用默认延后）不用于 harness 的调用。
- §6.4 F-DEFER 第 7 步：批准后内核不执行被批准的调用，而是发一次性许可，由 harness 自己再发起一次。
- `admit` 不对应任何工具调用，但用的是 `PendingCall` 这个结构；规范里的 `PendingCall` 只包着一个 `ToolCall`。它的 session 也不是在 run 里停下的，而是在 `select()` 里，没有 run 以 `deferred` 结束。
- §3.3 的 `dropped` 原本只表示重复投递。这里多了一条 `pending → dropped`：被拒绝或过期的不可信输入，以及回答这次放行请求的那条 `approval_answer`。答复依然只生效一次（I-PRM-5），只是它的行是 `dropped`，不是 `done`。

## Codex runtime（`examples/codex`）

第二档的第一个 runtime。配置里 `runtime: "codex"`（顶层或具名 agent，默认 `pi`），这个 agent 的 runtime 是第二档（`kind: "harness"`）；pi 永远是第一档。`autoReview` 是为 `apps/aoa` 的审查角色加的选项：Codex 的询问交给它自己的自动审查，不找用户。

- 进程和线程：每次 run 起一个 `codex app-server` 子进程，工作目录是 session 的 worktree，stdio 上走 JSON-RPC（每行一条，不带 `jsonrpc` 字段），run 结束就杀掉。一个 aoa session 对应一个 Codex 线程，`sessionRef` 就是线程 id：新 session 用 `thread/start`，之后用 `thread/resume`。aoa 的系统提示作为 `developerInstructions` 传入（resume 时再传一遍），本次 run 的事件按 pi 的格式写成 `turn/start` 的输入（渲染代码和 pi 共用）。一次 run 就是一个 turn：turn 完成时 run 以 `silent` 结束（调过 notify 时由内核改成 `sent`），turn 失败或进程退出就抛错，内核照常重试。
- 不覆盖 Codex 的设置：`thread/start` 不传 `approvalPolicy` 和 `sandbox`，模型只在配置写了 `model`（Codex 的模型名）时才传。Codex 用自己的登录或环境变量认证，aoa 不读也不传它的密钥。`initialize` 声明 `experimentalApi`，因为 `dynamicTools` 是实验字段。
- `serve` 启动时为每个这样的 agent 记一行：Codex 自己的审批和沙箱设置决定它不问就做什么，aoa 的推送规则和 `~/.aoa` 规则管不到 Codex 自己的工具。`aoa status`（文字和 JSON 的 `agents`）和页面（`View` 上新增的 `runtime`、`permissionOwner`，在切换按钮旁显示）都标出每个 agent 的 runtime 和权限归谁。字段是增量的：旧页面照常显示，新页面遇到旧 `serve` 就不显示这一项。

Codex 的请求怎么对应到 aoa：

| Codex 发来的 | aoa 怎么处理 |
|---|---|
| `item/commandExecution/requestApproval` | `ask`，工具名 `codex_command`，参数 `{command, cwd}`，另有 `kind: "writeStdin"`、`additionalPermissions`、`networkApprovalContext` 时一并放进去；既没有命令也没有网络上下文时放 item id，理由同下。`allow` 回 `accept`，`defer` 回 `decline` |
| `item/fileChange/requestApproval` | `ask`，工具名 `codex_file_change`，参数是这个 item 的改动（`changes`，来自 `item/started`、`item/completed` 和 `item/fileChange/patchUpdated` 通知，请求本身不带 diff），有 `grantRoot` 时带上；没收到改动时参数里放 item id，这样它不会和别的许可相等。回复同上 |
| `item/permissions/requestApproval` | `ask`，工具名 `codex_permissions`，参数 `{permissions, cwd}`。这个请求的回复不是 accept/decline：`allow` 回所请求的权限、`scope: "turn"`，`defer` 回空权限 |
| `item/tool/call`（动态工具） | 对应的内核 `Tool.invoke`，结果作为 `contentItems` 返回；`error` 是 `success: false` |
| `item/tool/requestUserInput` | 每个问题都答一句「这里没人能回答，需要用户决定就调 `ask_user`」 |
| `mcpServer/elicitation/request` | `decline` |
| 其他请求 | JSON-RPC 错误，不让 Codex 干等 |

- 从不回 `acceptForSession`：每次批准只放行一次。`defer`、延后的 aoa 工具、或者 `ask`/`invoke` 本身出错时，先回复手上这个请求，再发 `turn/interrupt`，等 Codex 回 `turn/completed`（最多 10 秒）再杀进程，免得线程没存好就断掉。等待期间再来的请求直接拒绝，不再问内核。
- call id 是 `<session>:<turn>:<item>`，命令审批带 `approvalId` 时再接上它；同一个 turn 里同一个键再出现时加 `#序号`。Codex 的 item id 在线程里唯一，turn id 每次 run 都是新的，所以内核不会拿到已经回答过的 id。
- 为什么动态工具让 aoa 的工具留在第一档：记忆、`notify`、`wake_me_at`、`cancel_wake`、`ask_user`、`send_to` 在 `thread/start` 时作为动态工具交给 Codex，Codex 调用时请求回到 aoa，由内核的 `invoke` 按策略裁决、写日志、执行，延后时同样停下等你，和 pi 完全一样。Codex 只是替模型转发这一次调用，执行和记录都在 aoa 这边。codex agent 不拿 aoa 的 read、write、edit、bash 等编码工具，这些用 Codex 自己的。分类器仍然配置给它，管的是 aoa 自己的工具；这些工具都是 `low`，所以 `serve` 只要求跑 pi 的 agent 配分类器。
- 许可和重问：Codex 问一条命令，内核建 `harness` 延后调用、发审批请求，aoa 回 `decline` 并中断 turn。你批准后，内核记下许可（工具名加参数）；下一次 run 恢复同一个线程，输入里的 `<answer>` 写明「用户批准了你之前请求的这个操作（附完整参数），它还没做，现在照原样再做一次，这次不用问」。Codex 再做时照自己的设置又问一次，参数和许可深度相等，内核直接答 `allow`，aoa 回 `accept`，不再发请求。拒绝也同样写进下一次的输入，告诉它不要再试。对 aoa 自己工具的答复仍按 pi 的写法（「已经执行，不要再调」）。
- 隔离用户的 Codex 扩展：aoa 启动的 `codex app-server` 带上 `--disable plugins --disable apps --disable hooks`，并对 `codex mcp list` 列出的每个 MCP server 加 `-c mcp_servers.<名字>.enabled=false`。不这样做的话，每次 run 光启动这些扩展就要等一分钟左右；而且它们的 hooks（记忆、统计）会作用到 aoa 的工作上，实测会加载近 200 个 MCP 工具。单写 `-c mcp_servers={}` 没用，它和配置合并，原有的 server 照样启动。Codex 的 `-c` 路径按点切分、也不去引号，所以名字里有点或引号的 server 关不掉，这时 run 直接报错，不会留着它开着。审批策略、沙箱、模型和登录仍用你的 Codex 配置。以后要给某个 codex agent 单独开放扩展，需要另外加配置。
- Codex 不问就运行的东西：Codex 的审批策略和沙箱允许的一切（比如沙箱内的命令、工作区内的改动），aoa 既看不到也不记录，aoa 的规则（`git push` 延后、`~/.aoa` 路径、worktree 边界）对它们不起作用。所以 codex agent 只能用在本地模式（GitHub 模式的推送要经过 aoa 自己的工具）。
- 跑在 Codex 上的审查 agent：审查的只读规则是 aoa 的策略，管不到 Codex 的工具，所以边界交给 Codex 自己，内核不加限制。aoa 只把它的线程（新开和恢复都一样）设成 Codex 的 auto review 模式：`sandbox: "workspace-write"`、`approvalPolicy: "on-request"`、`approvalsReviewer: "auto_review"`，Codex 要批准的操作由它自己的自动审查子代理来决定，不转给你。这是 aoa 唯一覆盖用户 Codex 审批和沙箱设置的地方。原因是用户的 Codex 如果是 `danger-full-access` 加 `never`，光设 `approvalsReviewer` 不会触发任何审查，审查 agent 就等于完全放开。审查的系统提示里，「不能改文件、改引用的 git 命令会被拦」在 pi 上是事实陈述，到了 Codex 上改成要求。考虑过但没用的两种做法，都用 `codex sandbox` 实测过：只读沙箱会挡住临时目录、`git restore` 和 `git merge-tree`，审查只能看 diff、跑类型检查；workspace-write 能跑测试，但在 worktree 里 `git commit` 和 `update-ref` 也能成功（Codex 把 worktree 的 git 目录也放成可写）。所以 auto review 模式下 Codex 审查 agent 实际上能提交，靠的是提示和 Codex 的自动审查，不是硬性限制。

和设计不完全一样、或者没做到的：

- 失败重试的 run 是新的 turn，Codex 给的 id 也是新的；如果失败那次已经用掉了许可，重试时会再问你一次（安全，但和 pi 按 transcript 重放 id 不同）。
- run 抛错时内核不记 `sessionRef`，所以重试会开一个新线程，前一次 turn 的上下文丢了；事件的 `attempts` 不为 0（之前有一次 run 失败过）时，输入里照 pi 的样子加上重试提示。
- 动态工具只在 `thread/start` 时提供，`thread/resume` 的参数里没有这一项。Codex 把它们存在线程里，恢复时沿用；冒烟测试已经对 Codex 0.154 验证过：另起一个进程恢复线程后，模型仍然能调用 aoa 的工具。
- Codex 会把每个新的 cwd 写进 `~/.codex/config.toml`，成为一条 `[projects."…"]` 记录。aoa 的每个 worktree 都是新目录，所以你的配置会跟着变长，目前没有拦。
- 如果配置里某个 `apiKeyEnv` 和 Codex 用的是同一个环境变量，aoa 启动时会把它从环境里删掉，Codex 子进程也就拿不到。

## DeepSeek Harness runtime（`examples/dsh`）

第二档的第二个 runtime，接的是 dsh 的 SDK 档：`dsh --profile sdk`，stdio 上换行分隔的 JSON-RPC 2.0（[方案](../proposals/deepseek-harness.md)，依据 dsh `0.2.2-rc.3`）。

- 配置：`runtime: "dsh"`（顶层或具名 agent），要写 `model`（dsh 的模型名）和 `apiKeyEnv`（密钥所在的环境变量），可选 `dsh: { command, preset }`：`command` 默认 `dsh`；`preset` 是权限预设（`read-only`、`workspace-write`（默认）、`danger-full-access`），aoa 把它写进 patch，profile 固定是 `sdk`。这个 agent 的 runtime 是第二档。只能用在本地模式；审查角色不支持（dsh 的工具不经过 aoa 的只读规则，拦不住）。provider 固定是 `deepseek-official`，aoa 不提供别的路由。`serve` 不要求 dsh agent 配分类器：它自己的工具不经过 aoa，aoa 给它的工具都是 `low`。
- 进程和会话：每次 run 起一个 dsh 子进程，工作目录是 session 的 worktree，run 结束就停掉。`initialize` 带 `cwd`、`provider`、`model`、`approvalRequests: true` 和 `capabilities: { userQuestions: true }`。新会话的 `sessionId` 由 aoa 生成，直接 `session/prompt`，它就是这个 session 的 `sessionRef`；已有的会话先 `session/resume`，再用 dsh 自己的 `/permission <预设>` 命令把权限预设重新设一遍（dsh 把 sandbox 和 approval 策略存在会话里，恢复时它们优先于 patch 的默认值，所以从 `danger-full-access` 改成 `workspace-write` 之后继续同一个任务，下一次 run 就是 workspace-write；dsh 没有这个命令、或者命令报错时 run 直接失败，不会带着旧权限往下跑），最后才 prompt。`session.status` 进入 `idle` 就是 run 结束。但 idle 不等于成功：`turn/end` 事件的 `reason.kind` 是 `error` 时这次 run 直接抛错交给内核重试（鉴权失败、模型报错都会走到这里）；日志里没有结论时再问一次 `session/wait`，让 dsh 手里的 live failure 也冒出来。本次 run 的事件按 pi 的格式写成一个 text block。
- 版本：dsh 握手里的 `version` 固定写死是 `0.0.1`，分不出发布版本，所以启动前先跑 `<command> --version`，要求等于代码里的常量 `0.2.2-rc.3`，不一致就让这次 run 失败并说明原因。dsh 还在开发者预览阶段，换版本时 patch 里的行 id 也要重新核对一遍。
- 独立的 home 和 patch：`$DSH_HOME` 是 `<dataDir>/dsh-home`，不带用户的 dsh 插件、MCP 和设置。每次 run 在 `<dataDir>/dsh-home/patches/` 下写一个 patch：把权限预设写成 `sandbox-policy` 的 `mode` 和 `approval` 的 `policy`（用户 dsh 里的设置放宽不了它）；关掉 dsh 自己的子代理、team、goal、workflow、jobs、插件管理器，以及它自己的提问和调度工具（这样提问只有 aoa 的 `ask_user`、定时只有 `wake_me_at`）；插入一行 `dsh-mcp-client`，server 名 `aoa`，指向这次 run 的桥；再用 `system-prompt` 行的 `personaSuffix` 把 aoa 的系统提示交给 dsh，因为 SDK 协议没有 instructions 字段。行 id 逐项对照过 dsh 的 base 和 sdk-app profile。
- 子进程环境只有 `DSH_HOME`、`DEEPSEEK_API_KEY`（从 `apiKeyEnv` 读出，放进 dsh 默认读的那个变量）、`AOA_DSH_SYSTEM_PROMPT`，以及 `PATH`、`HOME`、`TMPDIR`。aoa 启动时从自己环境里删掉的 key 不会出现在里面，别的 agent 的 key 也不会。
- 调用表和审批：dsh 的审批请求只有 `toolName`、`callId?`、`reason?`，参数在更早的会话事件里——普通调用是 `tool/call`（键 `callId`），`run_code` 里的子调用是 `tool/ptc-dispatch-start`（键 `subCallId`）。事件一到就同步记进调用表，键是 `(dsh 会话, callId)`。查得到时 `ask` 的工具名是 `dsh:<toolName>`、参数取表里的；`allow` 回 `allowed-once`，`defer` 回 `rejected` 再停下。查不到（没带 callId，或表里没有）直接 `rejected`，不问用户，也不按工具名放行——内核只按工具名加参数深度相等消费许可，放宽就可能把许可用到另一条命令上。内核 call id 用 `<aoa session>:<dsh callId>`。`user-question/ask` 回 `{cancelled: true}`，其他请求回 JSON-RPC 错误。
- 许可和重问：和 Codex 一样。批准后的下一次 run，输入里写明「用户批准了、还没做、照原样再做一次」；dsh 再做时照自己的设置又问一遍，`tool` 和 `args` 深度相等，内核直接放行，不再发请求。拒绝也写进下一次的输入。
- aoa 的工具走 MCP 桥：每次 run 在本进程起一个 streamable-http MCP server，只监听 `127.0.0.1`、端口随机，路径里带这次 run 才有的 token（每次询问都是新的），dsh 看到的工具名是 `mcp__aoa__<名字>`。dsh 发给 MCP 的只有名字和参数，不带它自己的 callId，所以桥按「同一会话、工具名对应、参数深度相等、还没被认领、最早的一条」从调用表里认领，内核 call id 用 `<session>:<dsh callId>`；认领不到就回 MCP 错误、不执行。延后的 aoa 工具回一句「等用户决定」然后停下；重试时同一个 dsh callId 得到同一个内核 call id，日志里已有结果的直接重放，不会再执行一次。
- 停下和恢复：dsh 没有取消方法。要停时先回复手上的请求（审批回 `rejected`，aoa 工具回「等用户决定」），之后来的审批请求和 MCP 调用一律拒绝、不再问内核；**正在执行的 aoa 工具调用要等它做完并回完话**——桥记着在途的调用数，run 不会带着一个还在跑的旧调用结束，也不会在它的回复送出之前停 dsh。然后发 `shutdown`：dsh 是先回话、再 flush 会话、再退出，所以等的是**进程退出**而不是回话，最多 10 秒，超时 SIGTERM，再等 10 秒，还不走就 SIGKILL。`shutdown` 回的错只记日志、不改这次 run 的结局：那时 run 已经做完了，抛错只会让内核把同一件事再做一遍。正常 `idle` 也走这一套。会话用 JSONL 持久化、锁是 flock，进程一死就释放，所以下一次 run 能 resume；在途调用的结果 dsh 自己会标成未知，模型从修好的历史里看到。
- 和 Codex 一样：dsh 不问就执行的、它的沙箱允许的操作，aoa 既看不到也拦不住，aoa 的推送规则、`~/.aoa` 规则和 worktree 边界对 dsh 自己的工具不起作用。`serve` 启动时为每个 dsh agent 提醒一次，`aoa status` 和观察页标出 runtime 和权限归谁。
- 冒烟测试只在 `AOA_DSH_SMOKE=1` 时跑（真的要 dsh 和真的 key，`bun test examples/dsh/test/smoke.test.ts`）：冷启动时间、aoa 的 MCP 工具没有被 gate 拦、patch 关掉的工具确实不在模型能看到的工具列表里（从会话的 `request/header` 事件里读，dsh 自己的读写、bash 工具照常留着）、杀掉进程后能恢复。

和方案不完全一样、或者没做到的：

- 系统提示走 patch 的 `personaSuffix` 而不是握手字段：SDK 协议没有这个字段，而覆盖 `system-prompt` 这一行会连带丢掉 sdk-app 自带的 `personaPrefix`（「You are a coding agent powered by …」）。现在 dsh 的系统提示是它自己的身份和指引，后面接 aoa 的提示。
- 版本检查是跑 `--version` 读输出，而不是像 dsh 官方 client 那样读包清单；`dsh.command` 指向的如果不是那个包的 bin（比如包了一层脚本），检查的依据就是脚本打印的版本。
- `session/query` 只用来在恢复会话时跑 `/permission`，别的斜杠命令不用；`subagent.*` 通知忽略；dsh 的 PTC 子调用照样进调用表，没有别的特殊处理。
- 认领 MCP 调用靠参数深度相等。dsh 如果在事件和实际调用之间改写了参数（比如把相对路径换成绝对路径），桥就认领不到，这次调用会被拒、不会执行；这是有意的失败方向。
- `dsh.preset` 按方案 §5 是**权限预设**，不是 dsh 的 profile：aoa 把它翻译成 `sandbox-policy.mode` 和 `approval.policy` 写进 patch，profile 固定 `sdk`（方案里 `dsh --profile sdk` 是另一种「profile」，容易混）。
