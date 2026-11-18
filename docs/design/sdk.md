# 内核层 SDK（§15，进行中）

2026-11-18 定下：把 aoa 做成内核层的 Bun SDK。使用者拿到的是 inbox、thread、session、事件、延后调用、定时器、outbox、记忆这些原语，以及把它们组装起来的接口。「任务 = session + worktree + 分支」不在 SDK 里，现在的编码 agent（`apps/aoa`）是建在 SDK 上的一个应用。

接口只从 aoa 自己的原语推出。CLI、`aoa mcp`、观察页和以后可能有的 GUI 只用来检查有没有漏掉什么，不决定接口的形状。GUI、本地协议、主会话都留到 SDK 定了之后，当作应用另行设计。

2026-11-18 按一次外部评审补了一轮：默认安全的策略、定时器去重和撤销、无 channel 时的投递、session 的收尾、thread 读写、取消信号、活动流的边界，以及把内核里残留的编码假设搬出去。

## 组装和操作

组装用对象，不用配置：`createHost` 拿一个 store，`host.agent` 给每个 inbox 登记一个 agent。配置文件里的 `runtime: "codex"` 怎么变成对象，是应用的事，SDK 没有按名字查的注册表。

```ts
function createHost(o: { store: Store; clock?: Clock; log?: (line: string) => void }): Host;

interface Host {
  agent(spec: AgentSpec): Agent;          // start() 之前登记
  readonly agents: Agent[];
  start(): void;                          // 拿 store.lock()；每个 agent 的 worker、scheduler、dispatcher、poller；只能调一次
  stop(): Promise<void>;                  // 发 abort，等在途的 run 结束
  readonly stopped: Promise<void>;        // stop() 之后，或某个循环死了、宿主停下其余的之后
  serving(): { pid: number; since: number } | null;   // 别的宿主是否在跑循环
  watch(fn: () => void): () => void;      // 库里有提交（包括别的进程），调用方自己再读
  messages(o?: { since?: MsgId; limit?: number }): QueuedOutMsg[];   // 所有 agent 按入队顺序合并
  close(): void;
}

type AgentSpec = {
  name: string;                           // send_to 的目标名，模型看得懂
  description?: string;                   // 写进 send_to 的说明
  inbox: InboxId;
  runtime: KernelRuntime | HarnessRuntime;
  tools?: ToolDef[] | ((builtins: ToolDef[]) => ToolDef[]);   // 列表接在内置工具（timers、notify、memory、ask_user）后面；函数自己排
  memory?: Memory;
  policy?: { rules?: Rule[]; classify?: Classify; risk?: Record<string, Risk> };
  channel?: Channel;
  session?: {
    prepare?(s: Session): Promise<{ workdir: string }>;   // 工作目录，默认没有
    cleanup?(s: Session, workdir: string): Promise<void>;   // 关 session 后，没有 run 在用时调
  };
  debounceMs?: number;                    // 默认 2000（D-EVT-3）
  rate?: RatePolicy;                      // 发件节奏
  pollMs?: number;                        // channel 有 poll 时的间隔，默认 60 秒
};

interface Agent {
  readonly name: string;
  readonly inbox: InboxId;
  append(e: NewEvent, o?: { refuseWhileAwaitingApproval?: boolean }): AppendResult;
  answer(callId: CallId, a: { verdict: "approve" | "deny"; text?: string; via?: string }): AppendResult;
  closeSession(id: SessionId, o?: { afterClose?(): void }): Promise<"closed" | "busy">;
  step: { worker(); scheduler(); dispatcher(); poller() };   // 每个循环走一遍：测试用，也给不跑循环的宿主
  followUp(t: FollowUpInput): TimerId;
  schedule(t: ScheduleInput & { id: string }): TimerId;   // 同一个 id 再调是更新，不是新增
  cancelTimer(id: TimerId): boolean;
  read: {
    sessions(): Session[];
    threads(s: SessionId): string[];      // 第一个是主线程
    sessionFor(thread: string): SessionId | null;
    events(o?: { status?: EventStatus; since?: number; limit?: number }): Event[];
    pending(): PendingCall[];
    timers(): Timer[];
    runs(o?: { since?: number; limit?: number }): RunRecord[];
    decisions(s: SessionId): DecisionRecord[];
    journal(s: SessionId): JournalRecord[];
  };
}

type QueuedOutMsg = OutMsg & { agent: string; seq: number; sentAt: number | null };
```

- 宿主内的追加和答复（包括 `send_to`）当场唤醒对应的 worker；别的进程的写入经 `watch` 唤醒，取代 `serve` 原来每 5 秒的轮询。
- `watch` 只说「库里有提交」，不说哪个 inbox、哪种表变了：WAL 文件的触发分不出这些，要分就得给每张表维护水位。调用方收到后自己重读，观察页现在就是这么做的（§12「观察页」：盯 WAL 文件，`data_version` 每秒兜底，从 `web.ts` 提到 SDK）。
- 锁是 store 的能力：`Store` 多一个 `lock(): Lock | null`。SQLite 文件库用文件锁，`:memory:` 返回 null（同一个进程里本来就只有一个宿主）。拿到锁的宿主每 5 秒记一次心跳，`serving()` 读的就是它，取代 `apps/aoa` 里的 `serve:started`/`serve:seen`。不跑循环的宿主照样能追加、答复、读和 `watch`，就是现在 `aoa send`、`aoa answer`、`aoa web` 的用法。
- `append` 的 `refuseWhileAwaitingApproval`：目标 session 停在审批（不是 `ask_user` 的提问）上时，在同一个事务里拒绝并抛错。`aoa mcp` 的 `send(to)` 靠它，免得聊天里的文字被改写成审批的结论（§12「主会话接入」）。
- `answer` 返回 `AppendResult`：同一个调用的第二次答复是 `dropped`，观察页据此回 409。
- `closeSession` 关 session、取消它的定时器、丢掉它在等的调用、清掉工作目录，然后不经任何等待调 `afterClose`，再调 `cleanup`。有 run 正在用这个 session 时什么都不做，返回 `"busy"`，由调用方以后再试：关掉会把目录从 run 脚下抽走，而等 run 结束会让 run 里的调用方（比如某个工具）死锁。同一个 session 被新事件重开时，`prepare` 等上一次 `cleanup` 做完。`afterClose` 给的是「和关闭同步发生」的位置：`apps/aoa` 在这里把 `aoa close` 的声明标为已生效，这样就算之后清理时崩了，被新事件重开的 session 也不会被同一条声明再关一次。
- `follow` 不是内置工具：本地模式刻意没有它（§8），GitHub 模式由应用加上。
- `step` 取代原来设想的 `drain()`：一致性测试和应用的测试要的是单个循环走一遍并看它的返回值（比如这次送出了几条），一个整体的 `drain()` 给不了。
- `schedule` 必须带调用方给的 `id`：启动脚本每次都调 `schedule`，没有 id 的话每重启一次库里就多一条周期定时器。同 id 再调时更新间隔、锚点和 payload，下次触发时间按新的间隔重算。`cancelTimer` 能撤任何定时器；agent 自己的 `cancel_wake` 仍然只能撤自己 session 的。
- 「谁的话算数」由追加事件的一方标 `trusted`，SDK 不判断调用者是谁。审批只经 `answer` 或可信的 `user_message` 生效（§6、I-PRM-2）。
- 密钥不经 SDK：runtime 和分类器拿到的是已经读出来的 key，从环境变量里删掉是应用的事（现在 `assemble` 做的那一步留在 `apps/aoa`）。
- 记忆不另开读口：`Memory` 是调用方传进来的，调用方手里本来就有。

### 没有 channel 时

outbox 照常写。没有 channel 时 dispatcher 写入即把消息标为 `sent`（`sentAt` 是写入时刻），调用方从 `host.messages()` 读。否则消息永远停在 `pending`，常驻上下文里的「已经告诉过用户的」永远是空的，D-MEM-3 和 C19 就悄悄失效了。`Channel.poll` 改成可选，没有 `poll` 的 channel 不起 poller，取代 `apps/aoa` 里的 `polls: false`。

### store 收口

store 只有 SQLite 一个实现，但 SDK 的公开类型里不出现 `SqliteStore`。现在挂在它上面的东西各自归位：outbox 的入队顺序和送达时间进 `Tx`（`host.messages()` 要用）；PR 状态、`aoa close` 声明的结局归应用；影子判断的 `Judgment`、`recordJudgment`、`listJudgments` 和 `judgments` 表从内核的 `Tx` 搬到应用，和影子判断本身一起留在 `apps/aoa`。

## 策略

- 默认安全：不传 `policy` 时不再全部放行，而是按每个工具的风险等级走，未知工具延后。现在内核 `!policy` 就放行，使用者容易以为有默认保护。
- 风险等级跟着工具走：`ToolDef` 多一个 `risk?: Risk`。内核自带的工具（timers、notify、memory、`send_to`、`follow`）自己标 `low`，`ask_user` 不经风险；编码工具包里的工具自己标等级。`policy.risk` 只用来覆盖。现在 `low` 的名单写死在 `apps/aoa/src/policy.ts`，SDK 用户一开 `policy`，连 `notify` 都会停下来等审批。
- 规则只有一张有序的表，SDK 不往里拼任何东西。`apps/aoa` 现在分 `ahead` 和 `rules` 两段，是因为审查的只读拦截要排在凭据路径的延后之前，本地 `git push` 的延后要排在禁止强推之后；这种顺序由调用方自己拼表决定。
- 编码相关的规则跟着编码工具走：原来内核的 `defaultRules`（sudo、强推、git 配置、`curl | sh`、凭据路径、tainted 时联网、只读命令）改名 `codingRules`，和 `apps/aoa` 的 `outsideWorktree` 一起搬进 `@aoa/sdk/tools/coding`，分开导出，由调用方放进自己的规则表。规则名不变，库里记的 `rule:<名字>` 照旧能对上。内核本身不带规则。`codingTools` 第 3 步也搬了过来。
- 分类器能读 session（第 4 步，随 `agent.read`）：`Classify` 的上下文多一个只读的 `read`（同 `Agent.read`，但先前调用只有参数、没有结果），审核模型（§12「审核模型」）不用再绕过 agent 直接扫 store。它仍然只拿得到库里的东西，拿不到调用结果，§6.2 的要害不变。

## 两档 runtime

两档用类型分开，取代原来的 `WorkerOptions.permissions`：

```ts
// 第一档：自己没有工具，每次调用都走 input.tools[i].invoke，由内核裁决、记日志、执行。
type KernelRuntime = { kind: "kernel"; run(input: RunInput): Promise<RunResult> };

// 第二档：harness 自带工具，内核不裁决也不执行它们，只转达询问（§12「权限归 harness 的 agent」）。
type HarnessRuntime = { kind: "harness"; run(input: RunInput & { ask: Ask }): Promise<RunResult> };
type Ask = (r: { callId: CallId; tool: string; args: unknown; reason?: string }) => Promise<"allow" | "defer">;

type RunInput = {
  /* 现有字段 */
  signal: AbortSignal;                    // host.stop() 时触发；runtime 停下模型请求和子进程
  emit?(a: RunActivity): void;
};

type RunActivity =
  | { kind: "text"; delta: string }
  | { kind: "reasoning"; delta: string }
  | { kind: "tool_start"; callId: CallId; tool: string; args: unknown }
  | { kind: "tool_end"; callId: CallId; result: ToolResult };
```

- SDK 只内置 pi（第一档）：pi 的 agent loop 和模型接入，放在子路径 `@aoa/sdk/pi`，只用第二档的人不用装 pi 的依赖。编码工具（bash、read、edit、write）和编码规则是可选的 `@aoa/sdk/tools/coding`，不默认装上，内核层不假设 agent 在写代码。
- 第二档 SDK 只给接口，不实现任何 harness。Codex 和 dsh 的适配器搬到 `examples/`，是 workspace 里的包，测试照跑、不发布；`apps/aoa` 从那里引用，继续支持 `runtime: "codex" | "dsh"`。Codex 示例里的 `autoReview` 是为 `apps/aoa` 的审查角色加的选项，在示例的说明里写明。
- `ToolExecContext` 也带 `signal`，长时间的工具（bash 的子进程）跟着停。

### 活动流

`emit` 是可选的，只在跑这次 run 的进程里推送，不落库；run 结束后能看的是库里的工具日志和结局。谁发什么：

- 内核在 `invoke` 里为 `input.tools` 发 `tool_start`/`tool_end`。`tool_start` 只在裁决放行之后发，延后和拦截的调用不发 `tool_start`，只记在 `decisions` 里。重跑时从日志里重放的结果不再发。
- runtime 发文字、思考，以及 harness 自带工具的调用。它不为 `input.tools` 里的工具发事件：harness 的会话事件里也有这些调用，再发一遍就是两条 call id 不同的重复。

### 第二档适配器要守的约定

写进 SDK 文档，Codex、dsh 是两种写法：

1. harness 每次征求同意都调 `ask`。`allow` 就让它跑；`defer` 就拒绝这次请求、停下 harness，以 `deferred` 结束 run。
2. 下一次 run 带着 `answer`。如果它答的是这个适配器经 `ask` 问过的调用（适配器按自己起的工具名认得出），批准时告诉模型照原样再做一次（那次 `ask` 会凭许可直接 `allow`），拒绝时告诉它别再试。如果答的是 `input.tools` 里的工具，内核已经执行完了，把 `answer.result` 原样交给模型，不让它再调一次。
3. 把 `input.tools` 交给 harness（Codex 用动态工具，dsh 用 MCP 桥），调用时走 `invoke`；结果是 `deferred` 时同样停下。
4. call id 在一个 session 里唯一，回答过的 id 不再拿来 `ask`。
5. 把 harness 自己的会话标识作为 `sessionRef` 返回，下次从 `session.ref` 恢复。
6. `signal` 触发时停下 harness，等它把会话存好再退出（Codex 的 `turn/interrupt`、dsh 的 `shutdown`），不留孤儿进程。

## 多 agent

一个宿主持有多个 agent，共用一个 store 和时钟。`send_to` 是 SDK 提供的可选工具：

```ts
function sendToTool(host: Host, o?: { check?(target: Agent, args: { text: string; [k: string]: unknown }): Promise<void> }): ToolDef;
```

- 工具说明按 `AgentSpec.name` 和 `description` 列出目标，模型填名字，不填 inbox。
- 往目标 inbox 追加 `agent_message`，跳数上限和可信传递照 §12「具名 agent」。不是回复时由 SDK 开一条新 thread（`agent:<目标名>/<随机 id>`），所以发给同一目标的几条消息各自开 session，不会因为没有 thread 被合进同一个新 session；目标的回信也有主线程可回。
- 额外参数和前置检查由 `check` 给：`apps/aoa` 用它接受 `branch`、检查目标是审查角色、检查分支存在，免得事件写进去重试三次后进死信。
- implement、review 这些角色、审查 agent 的只读规则、交审的提示词留在 `apps/aoa`。

## 内核里残留的编码假设

- `reportDead` 的「Run `aoa status` for the details.」去掉，死信通知的末行由应用给（`AgentSpec` 不加字段，应用在 channel 的 `deliver` 里补）。
- 常驻上下文的开头（`RESIDENT_PREAMBLE`）只在传了 `memory` 时加上记忆那几段；issue、PR、提交的说法改成「能查到的东西只存指针」。没有 `memory` 时只剩「保持安静」和「已经告诉过用户的」两段。

## 留在应用里的

worktree 和分支（经 `session.prepare`/`cleanup` 接进来）、本地通道和 GitHub 通道、审查模型的提示词和影子判断、配置文件格式、CLI、`aoa mcp`、观察页。

## 步骤

每步单独提交，前一步是后一步的前提。第 1 步已完成（2026-11-18）：`packages/sdk` 有了 `createHost`、`host.agent`、`agent.step`、`agent.closeSession`，`apps/aoa` 只经它组装循环。过渡期的字段已随第 3、4 步去掉：`AgentSpec.permissions`、只在给了时才轮询的 `pollMs`、`agent.wake()`，以及 `apps/aoa` 里 `serve` 的心跳和每 5 秒的唤醒。第 2 步已完成（2026-11-18）：工具自带风险等级，不传 `policy` 按等级走，内核不再带规则，编码规则在 `@aoa/sdk/tools/coding`。

第 3 步已完成（2026-11-18）：`AgentRuntime` 是 `KernelRuntime | HarnessRuntime`，worker 看 `runtime.kind`，`ask` 只在 `HarnessRunInput` 上；`RunInput.signal` 和 `ToolExecContext.signal` 在 `stop()` 时触发。pi 在 `@aoa/sdk/pi`，`codingTools` 在 `@aoa/sdk/tools/coding`，Codex 和 dsh 在 `examples/`（`@aoa/example-codex`、`@aoa/example-dsh`）。和上文不同或上文没写的地方：

- 被停下的 run 不算失败：它的事件回到 `pending`，不等重试间隔，停多少次都不会进死信；但次数照样加一，下一次 run 才知道上一次可能做了一半（Codex、dsh 靠它加重试提示）。一直停在同一组事件上，会比正常失败更快用完三次，这在真的失败时才显出来。
- 停下时正在跑的工具不记结果，下一次 run 再调同一个 id 得到「结果未知」，和崩溃一样；可重入的工具照常重跑。停下之后 `invoke` 不再开始新的调用。
- 运行时之间共用的渲染（事件块、答复、`encode`、`resultText`）放在 `@aoa/sdk/prompt`，第二档适配器从这里取，不用装 pi。
- pi 的依赖现在是 `@aoa/sdk` 的普通依赖：仓库没发布，分不出可选依赖。发布时改成可选的 peer 依赖，`@aoa/sdk/pi` 以外的子路径不引用它们。
- 第六条约定的写法：Codex 等手上的回复都发出去再 `turn/interrupt`，等 Codex 回 `turn/completed` 再结束；dsh 走和 `idle` 一样的 `shutdown`。

第 4 步已完成（2026-11-18）：`agent.append`、`answer`、`read`、`followUp`、`schedule`、`cancelTimer`，`host.messages`、`serving`、`watch`、`close`，`sendToTool` 都在 `@aoa/sdk`；`agent.wake()` 和 `serve` 每 5 秒的唤醒去掉了。和上文不同或上文没写的地方：

- 锁、心跳和 `watch` 不在内核的 `Store` 上，在 `HostStore extends Store` 上（`lock()`、`lastBeat()`、`watch()`、`close()`），`createHost` 要的是它：内核的 worker、scheduler 这些只用 `tx`。SQLite 的锁是在旁边的 `<db>-host` 文件上开着一个排他事务：持有的进程死了由系统放掉，同一个进程里第二个连接也拿不到。`lock()` 拿不到时抛错，`:memory:` 返回 null。
- `watch(fn, { othersOnly })`：宿主的循环只因别的进程的提交被叫醒，否则自己的每次写入都会把所有循环叫醒一遍。本进程的写事务按 SQLite 的 `total_changes()` 判断，只读的事务不触发。
- 没有 channel 时，消息在写进 outbox 的同一个事务里标为 `sent`，不经 dispatcher：这样只调 `step.worker()` 也成立，同一次 drain 里的下一个 run 也看得到。
- `schedule` 的 id 在库里是 `schedule:<inbox>:<id>`，两个 agent 的同名定时器互不相干，也碰不上内核自己的 `wake:`、`expire:`。用同样的参数再调什么都不改，所以宿主停着时错过的那一次照样触发；参数不同，或定时器已被撤，才按新的锚点重排并重新武装。`followUp` 带了调用方的 id 时同样加前缀（`follow_up:<inbox>:<id>`）。
- `read` 的 `since` 是时间（事件按收到、run 按开始），`limit` 取 `since` 之后最早的几条。读口的类型 `Reader` 在内核，分类器经 `PolicyContext.read` 拿到同一个读口；`apps/aoa` 的审核模型改用它。分类器的读口是 `PolicyReader`：没有 `journal`，换成 `calls`，只有先前调用的工具名和参数，不带结果（2026-11-18 定）。结果是工具从外面取回的文字，正是 §6.2 不让它左右判断的东西，这一次的和先前的都一样。
- `append` 拒绝时抛 `AwaitingApproval`（带着在等的调用），措辞由调用方给。
- `send_to`：一个工具给所有 agent 共用，说明里列出全部 agent（包括发送方自己），发给自己时报错。不是回复时的默认 thread 是 `agent:<目标名>/<发送方 session>/<调用 id>`，由调用推出而不是随机，所以同一个调用重跑仍然写进同一条 thread。额外参数用 `params` 声明（JSON Schema 属性），原样进 payload；`check` 之外多一个 `thread` 钩子，`apps/aoa` 用它照旧开 thread（GitHub 模式下是一个 issue，`agent:` 开头的 thread 发不到 GitHub）。
- `AgentSpec.description` 和 `Agent.description` 给 `send_to` 的列表用；`apps/aoa` 填角色名。
- `SqliteStore` 只剩 `HostStore` 加一个 `db`（store 自己的连接）：`apps/aoa` 的 PR 状态、`aoa close` 的声明和影子判断在 `apps/aoa/src/records.ts`，用同一个连接读写，免得两个连接互相等锁。建这几张表的旧迁移留在 store 里（迁移只追加，不改已发布的）。outbox 行（`OutboxRow`）带 `seq` 和 `sentAt`。
- 观察页的「serve 状态」读 `host_beat`；从来没有宿主跑过时仍是 `never`。

第 5 步已完成（2026-11-18）：`RunInput.emit` 和 `RunActivity` 在内核，内核在执行工具的唯一入口（`executeRecorded`）前后发 `tool_start`/`tool_end`，pi 把模型的 `text_delta`、`thinking_delta` 转成 `text`、`reasoning`。和上文不同或上文没写的地方：

- 订阅口是 `agent.activity(fn)`，`fn` 收到活动和 `{ runId, sessionId }`，返回取消订阅的函数；上文没写从哪里订阅。`AgentSpec` 不加回调，订阅可以随时开关（以后的页面或 GUI 连上才订）。
- worker 每次 run 都给 `emit`，`RunInput.emit` 的类型仍是可选的，runtime 写 `input.emit?.(...)`，手搭的 `RunInput`（比如 Codex 的冒烟测试）不用给。
- 订阅者抛错被丢掉（宿主记一行日志），不影响 run 的结局和工具日志：抛错落在执行和记结果之间，下一次 run 就会拿到「结果未知」。run 结束后再来的活动不送出。
- 被批准的调用在拿到答复的那次 run 里执行，也在那次 run 里发 `tool_start`/`tool_end`。只有意图、没有结果的可重入调用重跑时是真的执行，照样发。被停下打断的调用只有 `tool_start`，没有 `tool_end`：看的人以 run 的结束收尾，不另加事件类型。
- `tool_end` 在结果写进日志之后才发，活动流不会比库里多。
- pi 在同一次 `prompt` 里自己重试模型请求时，重试前已经发出的文字会再来一遍。
- Codex 和 dsh 示例还不发自己的文字和自带工具的调用；它们经 `input.tools` 的调用由内核发。

第 6 步已完成（2026-11-18）：`examples/digest`（`@aoa/example-digest`），说明见它的 README。一个子进程在 `PATH` 里没有 git、不在任何仓库里，经 pi 跑完一天，pi 本身也不碰 git。顺带做了「内核里残留的编码假设」一节：没有 `memory` 时常驻上下文只剩「保持安静」一段；有 `memory` 时「只存指针」不再点名 issue、PR、提交；死信通知不再提 `aoa status`，`apps/aoa` 在自己的 channel 里按去重键前缀（`DEAD_NOTICE_PREFIX`）补上这一行。

这个示例碰到的、SDK 还不顺手的地方：

- 每次定时器触发开一个新 session，跑完不关；SDK 没有「run 结束」的钩子，应用只能自己扫着关。
- 工具要知道「上一次成功检查是什么时候」，只能在工具里经 `agent.read.runs()` 推，工具定义时 agent 还没注册，得晚绑定。
- 宿主的时钟不交给工具：工具里的「现在」只能借当前 run 的开始时间。

2026-11-18 起 `apps/aoa` 只经 `@aoa/sdk` 用内核，`package.json` 里不再有 `@aoa/kernel`，`apps/aoa/test/depends-on-sdk.test.ts` 守着这一点。`@aoa/sdk` 重新导出内核的全部类型，值只导出不属于宿主的几样（`systemClock`、`dirMemory`、`followTools`、单独跑策略的 `decide`、`DEAD_NOTICE_PREFIX`、`RESIDENT_RECENT_MESSAGES`），另加 `builtinToolRisk()`：按名字查内置工具、`follow` 和 `send_to` 的风险等级，给只知道工具名的重放和测试用。store 和 channel 仍是应用直接依赖、传进 SDK 的包，SDK 不依赖它们。

| 步 | 内容 | 验收 |
| --- | --- | --- |
| 1 | `createHost` / `host.agent`：把 `wiring.ts` 里每个 agent 的组装（worker、scheduler、dispatcher、poller、工具拼装、session 收尾）搬进 SDK；`apps/aoa` 改用它 | 现有 `bun test` 全过；`apps/aoa` 里不再 `new Worker`；关 session 时有 run 在用，返回 `busy`、什么都不动；只能关自己 inbox 的 session |
| 2 | 策略：`ToolDef.risk`、默认安全、内核不带规则；`defaultRules` 和编码工具拆成 `tools/coding` | 不传 `policy` 的 agent 调未知工具会延后；`notify` 不用等审批 |
| 3 | 两档 runtime 的类型取代 `permissions`，`signal` 进 `RunInput`；`runtimes/codex`、`runtimes/dsh` 搬到 `examples/` | 示例测试照跑；一致性测试用脚本 harness 覆盖六条约定；`stop()` 能停下卡住的 run |
| 4 | `Store` 收口和 `lock()`；`agent.read`、`host.messages`、`host.watch`、`serving()`；定时器 id 和 `cancelTimer`；无 channel 的投递；`send_to` 进 SDK | 另一个进程写入后 1 秒内 `watch` 到；第二个 `start()` 抛错；重启后同 id 的 `schedule` 只有一条 |
| 5 | 活动流：`RunInput.emit`，内核发工具事件，pi 发文字 | 脚本模型下按序收到 text、tool_start、tool_end；延后的调用和重放不发 `tool_start` |
| 6 | 一个不写代码的示例 agent（每天汇总 issue，有事才找你），不传 channel，用 `step` 写测试 | 不依赖 git 就能跑通，证明 SDK 不绑在编码上 |

## 暂缓

- GUI、本地协议、主会话。
- 外部事件分给哪个 agent：channel 挂在 agent 上，路由策略由应用定。
- run 结束后看完整 transcript：给 runtime 加读取接口。
- 第二个 store 实现；一个宿主多个仓库（内核层本来没有仓库的概念）。
