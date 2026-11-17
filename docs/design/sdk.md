# 内核层 SDK（§15，已定，未实现）

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
  start(): Promise<void>;                 // 拿 store.lock()；每个 agent 的 worker、scheduler、dispatcher、poller
  stop(): Promise<void>;                  // 发 abort，等在途的 run 结束
  serving(): { pid: number; since: number } | null;   // 别的宿主是否在跑循环
  watch(fn: () => void): () => void;      // 库里有提交（包括别的进程），调用方自己再读
  drain(): Promise<void>;                 // 不起常驻循环，把能做的做完：测试用
  messages(o?: { since?: MsgId; limit?: number }): QueuedOutMsg[];   // 所有 agent 按入队顺序合并
  close(): void;
}

type AgentSpec = {
  name: string;                           // send_to 的目标名，模型看得懂
  description?: string;                   // 写进 send_to 的说明
  inbox: InboxId;
  runtime: KernelRuntime | HarnessRuntime;
  tools?: ToolDef[];                      // 内核再加上 timers、notify、memory、ask_user、follow
  memory?: Memory;
  policy?: { rules?: Rule[]; classify?: Classify; risk?: Record<string, Risk> };
  channel?: Channel;
  session?: {
    prepare?(s: Session): Promise<string | null>;    // 工作目录，默认没有
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
  closeSession(id: SessionId): Promise<void>;
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

- 宿主内的追加和答复（包括 `send_to`）当场唤醒对应的 worker 和 dispatcher；别的进程的写入经 `watch` 唤醒，取代 `serve` 现在每 5 秒的轮询。
- `watch` 只说「库里有提交」，不说哪个 inbox、哪种表变了：WAL 文件的触发分不出这些，要分就得给每张表维护水位。调用方收到后自己重读，观察页现在就是这么做的（§12「观察页」：盯 WAL 文件，`data_version` 每秒兜底，从 `web.ts` 提到 SDK）。
- 锁是 store 的能力：`Store` 多一个 `lock(): Lock | null`。SQLite 文件库用文件锁，`:memory:` 返回 null（同一个进程里本来就只有一个宿主）。拿到锁的宿主每 5 秒记一次心跳，`serving()` 读的就是它，取代 `apps/aoa` 里的 `serve:started`/`serve:seen`。不跑循环的宿主照样能追加、答复、读和 `watch`，就是现在 `aoa send`、`aoa answer`、`aoa web` 的用法。
- `append` 的 `refuseWhileAwaitingApproval`：目标 session 停在审批（不是 `ask_user` 的提问）上时，在同一个事务里拒绝并抛错。`aoa mcp` 的 `send(to)` 靠它，免得聊天里的文字被改写成审批的结论（§12「主会话接入」）。
- `answer` 返回 `AppendResult`：同一个调用的第二次答复是 `dropped`，观察页据此回 409。
- `closeSession` 先关 session、取消它的定时器；有 run 正在用这个 session 时，等那次 run 结束才调 `cleanup`。同一个 session 被新事件重开时，`prepare` 等上一次 `cleanup` 做完。这就是 `wiring.ts` 现在 `inRun` 加 `removals` 队列做的事。
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
- 风险等级跟着工具走：`ToolDef` 多一个 `risk?: Risk`。内核自带的工具（timers、notify、memory、follow、`send_to`）自己标 `low`，`ask_user` 不经风险；编码工具包里的工具自己标等级。`policy.risk` 只用来覆盖。现在 `low` 的名单写死在 `apps/aoa/src/policy.ts`，SDK 用户一开 `policy`，连 `notify` 都会停下来等审批。
- 规则只有一张有序的表，SDK 不往里拼任何东西。`apps/aoa` 现在分 `ahead` 和 `rules` 两段，是因为审查的只读拦截要排在凭据路径的延后之前，本地 `git push` 的延后要排在禁止强推之后；这种顺序由调用方自己拼表决定。
- 编码相关的规则跟着编码工具走：内核的 `defaultRules`（sudo、强推、git 配置、`curl | sh`、凭据路径、tainted 时联网、只读命令）和 `apps/aoa` 的 `outsideWorktree` 都搬进 `@aoa/sdk/tools/coding`，导出成数组，由调用方放进自己的规则表。内核本身不带规则。
- 分类器能读 session：`Classify` 的上下文多一个只读的 `read`（同 `Agent.read`），审核模型（§12「审核模型」）不用再绕过 agent 直接扫 store。它仍然只拿得到库里的东西，拿不到调用结果，§6.2 的要害不变。

## 两档 runtime

两档用类型分开，取代现在的 `WorkerOptions.permissions`：

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

每步单独提交，前一步是后一步的前提。

| 步 | 内容 | 验收 |
| --- | --- | --- |
| 1 | `createHost` / `host.agent`：把 `wiring.ts` 里每个 agent 的组装（worker、scheduler、dispatcher、poller、工具拼装、session 收尾）搬进 SDK；`apps/aoa` 改用它 | 现有 `bun test` 全过；`apps/aoa` 里不再 `new Worker`；关 session 时有 run 在用，`cleanup` 等它结束 |
| 2 | 策略：`ToolDef.risk`、默认安全、内核不带规则；`defaultRules` 和编码工具拆成 `tools/coding` | 不传 `policy` 的 agent 调未知工具会延后；`notify` 不用等审批 |
| 3 | 两档 runtime 的类型取代 `permissions`，`signal` 进 `RunInput`；`runtimes/codex`、`runtimes/dsh` 搬到 `examples/` | 示例测试照跑；一致性测试用脚本 harness 覆盖六条约定；`stop()` 能停下卡住的 run |
| 4 | `Store` 收口和 `lock()`；`agent.read`、`host.messages`、`host.watch`、`serving()`；定时器 id 和 `cancelTimer`；无 channel 的投递；`send_to` 进 SDK | 另一个进程写入后 1 秒内 `watch` 到；第二个 `start()` 抛错；重启后同 id 的 `schedule` 只有一条 |
| 5 | 活动流：`RunInput.emit`，内核发工具事件，pi 发文字 | 脚本模型下按序收到 text、tool_start、tool_end；延后的调用和重放不发 `tool_start` |
| 6 | 一个不写代码的示例 agent（每天汇总 issue，有事才找你），不传 channel，用 `drain()` 写测试 | 不依赖 git 就能跑通，证明 SDK 不绑在编码上 |

## 暂缓

- GUI、本地协议、主会话。
- 外部事件分给哪个 agent：channel 挂在 agent 上，路由策略由应用定。
- run 结束后看完整 transcript：给 runtime 加读取接口。
- 第二个 store 实现；一个宿主多个仓库（内核层本来没有仓库的概念）。
