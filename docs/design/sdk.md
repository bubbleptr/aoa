# 内核层 SDK（§15，已定，未实现）

2026-11-18 定下：把 aoa 做成内核层的 Bun SDK。使用者拿到的是 inbox、thread、session、事件、延后调用、定时器、outbox、记忆这些原语，以及把它们组装起来的接口。「任务 = session + worktree + 分支」不在 SDK 里，现在的编码 agent（`apps/aoa`）是建在 SDK 上的一个应用。

接口只从 aoa 自己的原语推出。CLI、`aoa mcp`、观察页和以后可能有的 GUI 只用来检查有没有漏掉什么，不决定接口的形状。GUI、本地协议、主会话都留到 SDK 定了之后，当作应用另行设计。

## 组装和操作

组装用对象，不用配置：`createHost` 拿一个 store，`host.agent` 给每个 inbox 登记一个 agent。配置文件里的 `runtime: "codex"` 怎么变成对象，是应用的事，SDK 没有按名字查的注册表。

```ts
function createHost(o: { store: Store; clock?: Clock; log?: (line: string) => void }): Host;

interface Host {
  agent(spec: AgentSpec): Agent;          // start() 之前登记
  readonly agents: Agent[];
  start(): Promise<void>;                 // 每个 agent 的 worker、scheduler、dispatcher、poller；拿不到锁抛错
  stop(): Promise<void>;                  // 等在途的 run 结束
  watch(fn: (c: Change) => void): () => void;   // 包括别的进程写入的
  close(): void;
}

type AgentSpec = {
  inbox: InboxId;
  runtime: KernelRuntime | HarnessRuntime;
  tools?: ToolDef[];                      // 内核再加上 timers、notify、memory、ask_user
  memory?: Memory;
  policy?: { rules?: Rule[]; risk?: Record<string, Risk>; classify?: Classify };
  channel?: Channel;
  session?: { prepare?(s: Session): Promise<string | null> };   // 工作目录，默认没有
  debounceMs?: number;                    // 默认 2000（D-EVT-3）
};

interface Agent {
  readonly inbox: InboxId;
  append(e: NewEvent): AppendResult;      // (source, dedupeKey) 去重；trusted 由调用方标
  answer(callId: CallId, a: { verdict: "approve" | "deny"; text?: string; via?: string }): void;
  closeSession(id: SessionId): void;
  followUp(t: FollowUpInput): TimerId;
  schedule(t: ScheduleInput): TimerId;
  read: {
    sessions(): Session[];
    events(o?: { status?: EventStatus }): Event[];
    pending(): PendingCall[];
    outbox(o?: { since?: MsgId }): OutMsg[];
    timers(): Timer[];
    runs(): RunRecord[];
    decisions(s: SessionId): DecisionRecord[];
    journal(s: SessionId): JournalRecord[];
  };
}

type Change =
  | { inbox: InboxId; kinds: ("event" | "session" | "deferred" | "outbox" | "timer" | "run" | "decision")[] }
  | { inbox: InboxId; activity: { runId: RunId; item: RunActivity } };   // 只在跑循环的进程里
```

- 同一个库同时只有一个宿主跑循环，用锁文件保证。不跑循环的宿主照样能追加、答复、读和 `watch`，就是现在 `aoa send`、`aoa answer`、`aoa web` 的用法。
- `watch` 是观察页现在那套：盯 WAL 文件，`data_version` 每秒兜底（§12「观察页」），从 `web.ts` 提到 SDK。
- 「谁的话算数」由追加事件的一方标 `trusted`，SDK 不判断调用者是谁。审批只经 `answer` 或可信的 `user_message` 生效（§6、I-PRM-2）。
- 密钥不经 SDK：runtime 和分类器拿到的是已经读出来的 key，从环境变量里删掉是应用的事（现在 `assemble` 做的那一步留在 `apps/aoa`）。
- store 只有 SQLite 一个实现，但 `Store` 端口收口：`SqliteStore` 专有的东西（PR 状态、`aoa close` 声明的结局、outbox 的入队顺序）要么进 `Tx`，要么归应用，SDK 的公开类型里不出现 `SqliteStore`。

## 两档 runtime

两档用类型分开，取代现在的 `WorkerOptions.permissions`：

```ts
// 第一档：自己没有工具，每次调用都走 input.tools[i].invoke，由内核裁决、记日志、执行。
type KernelRuntime = { kind: "kernel"; run(input: RunInput): Promise<RunResult> };

// 第二档：harness 自带工具，内核不裁决也不执行它们，只转达询问（§12「权限归 harness 的 agent」）。
type HarnessRuntime = { kind: "harness"; run(input: RunInput & { ask: Ask }): Promise<RunResult> };
type Ask = (r: { callId: CallId; tool: string; args: unknown; reason?: string }) => Promise<"allow" | "defer">;

type RunInput = { /* 现有字段 */ emit?(a: RunActivity): void };

type RunActivity =
  | { kind: "text"; delta: string }
  | { kind: "reasoning"; delta: string }
  | { kind: "tool_start"; callId: CallId; tool: string; args: unknown }
  | { kind: "tool_end"; callId: CallId; result: ToolResult };
```

- SDK 只内置 pi（第一档）：pi 的 agent loop 和模型接入。编码工具（bash、read、edit、write）拆成可选的工具包 `@aoa/sdk/tools/coding`，不默认装上，内核层不假设 agent 在写代码。
- 第二档 SDK 只给接口，不实现任何 harness。Codex 和 dsh 的适配器搬到 `examples/`，是 workspace 里的包，测试照跑、不发布；`apps/aoa` 从那里引用，继续支持 `runtime: "codex" | "dsh"`。测试一直跑才能证明接口够用。
- 活动流：`emit` 是可选的。内核在 `invoke` 里为自己的工具发 `tool_start`/`tool_end`，runtime 发文字和 harness 自带工具的调用。只在跑这次 run 的进程里推送，不落库；run 结束后能看的是库里的工具日志和结局。

第二档适配器要守的约定（写进 SDK 文档，Codex、dsh 是两种写法）：

1. harness 每次征求同意都调 `ask`。`allow` 就让它跑；`defer` 就拒绝这次请求、停下 harness，以 `deferred` 结束 run。
2. 下一次 run 带着 `answer`：批准时告诉模型照原样再做一次（那次 `ask` 会凭许可直接 `allow`），拒绝时告诉它别再试。
3. 把 `input.tools` 交给 harness（Codex 用动态工具，dsh 用 MCP 桥），调用时走 `invoke`；结果是 `deferred` 时同样停下。
4. call id 在一个 session 里唯一，回答过的 id 不再拿来 `ask`。
5. 把 harness 自己的会话标识作为 `sessionRef` 返回，下次从 `session.ref` 恢复。

## 多 agent

多 agent 在 SDK 里：一个宿主持有多个 agent，共用一个 store 和时钟。`send_to` 是 SDK 提供的可选工具，往另一个 inbox 追加 `agent_message`，跳数上限和可信传递照 §12「具名 agent」。implement、review 这些角色、审查 agent 的只读规则、交审的提示词留在 `apps/aoa`。

## 留在应用里的

worktree 和分支、本地通道和 GitHub 通道、审查模型的提示词和影子判断（SDK 只有 `policy.classify` 这个口）、配置文件格式、CLI、`aoa mcp`、观察页。

## 步骤

每步单独提交，前一步是后一步的前提。

| 步 | 内容 | 验收 |
| --- | --- | --- |
| 1 | `createHost` / `host.agent`：把 `wiring.ts` 里每个 agent 的组装（worker、scheduler、dispatcher、poller、工具拼装）搬进 SDK；`apps/aoa` 改用它 | 现有 `bun test` 全过；`apps/aoa` 里不再 `new Worker` |
| 2 | 两档 runtime 的类型取代 `permissions`；`runtimes/codex`、`runtimes/dsh` 搬到 `examples/` | 示例测试照跑；一致性测试用脚本 harness 覆盖第二档约定 |
| 3 | 编码工具拆成 `tools/coding`；`Store` 收口；`send_to` 进 SDK | `apps/aoa` 之外没有代码碰 `SqliteStore` 专有的方法 |
| 4 | `agent.read` 和 `host.watch`，`start()` 加锁 | 另一个进程写入后 1 秒内 `watch` 到；第二个 `start()` 抛错 |
| 5 | 活动流：`RunInput.emit`，内核发工具事件，pi 发文字 | 脚本模型下按序收到 text、tool_start、tool_end |
| 6 | 一个不写代码的示例 agent（每天汇总 issue，有事才找你） | 不依赖 git 就能跑通，证明 SDK 不绑在编码上 |

## 暂缓

- GUI、本地协议、主会话。
- 外部事件分给哪个 agent：channel 挂在 agent 上，路由策略由应用定。
- run 结束后看完整 transcript：给 runtime 加读取接口。
- 第二个 store 实现；一个宿主多个仓库（内核层本来没有仓库的概念）。
