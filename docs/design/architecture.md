# 结构、数据和流程

## 3. 结构

内核只认三个端口，不知道 GitHub、worktree 和具体模型。runtime 拿到的工具是内核包好的，裁决（§6）和日志（§5）都在 `invoke` 里，适配器绕不过去。

```ts
interface Store { tx<T>(fn: (t: Tx) => T): T }   // 一个事务 = 规范里的 ATOMIC

interface AgentRuntime { run(input: RunInput): Promise<RunResult> }

type RunInput = {
  runId: RunId;
  session: { id: SessionId; resumed: boolean; ref: string | null };
  events: Event[];                 // 转义后的摘要加指针
  resident: string;                // 指令 + 索引，前缀稳定
  tools: Tool[];                   // 内核包好的：invoke 里先裁决、再记日志、再执行
  answer?: { callId: CallId; verdict: "approve" | "deny"; text?: string };
};

type Tool = {
  name: string; description: string; schema: unknown;
  invoke(callId: CallId, args: unknown): Promise<ToolResult>;
};

type RunEnd =
  | { kind: "sent"; msgs: MsgId[] }
  | { kind: "silent" }
  | { kind: "deferred"; callId: CallId };

type RunResult = { end: RunEnd; sessionRef?: string };   // sessionRef 指向适配器保管的 transcript

interface Channel {
  deliver(m: OutMsg): Promise<void>;
  poll(cursor: string | null): Promise<{ events: NewEvent[]; cursor: string }>;
}
```

| 包 | 内容 |
| --- | --- |
| `packages/sdk` | 唯一对外发布的 npm 包（`@aoa-dev/sdk`）：内部含内核（`src/kernel`：类型、worker 循环、scheduler、dispatcher、策略裁决，不单独导出）与 SQLite 存储（`src/sqlite`：`bun:sqlite` 表结构和事务）；对外导出 `createHost`、`sqliteStore`、`@aoa-dev/sdk/loop`、`@aoa-dev/sdk/prompt`、`@aoa-dev/sdk/tools/coding`（§15） |
| `packages/pi` | `@aoa-dev/pi`，不发布：pi 作为第一档 runtime（`piRuntime`）、`piClassifier`、`codingTools`；`apps/aoa` 和 `examples/tui` 用 |
| `packages/channels/local` | 本地通道：消息写文件，发桌面通知 |
| `packages/channels/github` | 可选。轮询 issue 和评论，开 PR，发评论 |
| `packages/conformance` | C1–C20，带故障注入点的假 runtime 和假时钟 |
| `apps/aoa` | CLI、`serve`、worktree 管理；只经 `@aoa-dev/sdk` 公开接口组装 agent |
| `examples/tui` | 极简 TUI 交互式编码 agent 示例，建立在 `@aoa-dev/sdk` 与 `@aoa-dev/pi` 之上 |

写代码用的工具（bash、read、edit、write 等）也是内核里登记的工具：`@aoa-dev/pi` 的 `codingTools` 把 pi 自带的实现包成内核工具，pi 自己不直接执行任何工具。所以每一次调用都经过裁决和日志，没有第二条路。

runtime 只返回 `silent` 或 `deferred`；这次 run 往 outbox 里写过消息时，内核把结局记成 `sent`。

「任务」不是内核概念。内核只有 session；`apps/aoa` 在新 session 开始时建一个 worktree，于是一项任务就是一个 session 加一个 worktree。

## 4. 数据

五个存储加辅助表都在同一个 SQLite 文件里，所以「追加事件 + 推进定时器」这类 ATOMIC 就是一个事务。

| 表 | 对应 | 关键列 |
| --- | --- | --- |
| `events` | §3.2 `Event` | `(source, dedupe_key)` 唯一，`status`，`lease_until`，`attempts`，`next_attempt_at`，`thread`，`resume`，`trusted` |
| `timers` | §4.2 `Timer` | `kind`，`due`，`recurrence`，`status` |
| `sessions` | §1.2 `Session` | `status`，`pending`，`runtime_ref`，`workdir` |
| `outbox` | §7.2 `OutMsg` | `dedupe_key` 唯一，`status`，`attempts` |
| `deferred` | §6.2 `PendingCall` | `call_id` 主键，`expires_at` |
| `threads` | 无 | `thread_key → session_id` |
| `tool_journal` | I-EVT-3 | `(session_id, call_id)` 主键，`state`，`result` |
| `decisions` | I-PRM-7 | `call_id`，`decision`，`basis`，`at` |
| `judgments` | 影子判断（§12） | `call_id` 主键，`session_id`，`model`，`p`（失败为 NULL），`latency_ms`，`error`，`at` |
| `runs` | 无 | `session_id`，`end`，`started_at`，`ended_at` |

记忆是磁盘上的目录，不进数据库（§7）。

### 事件怎么回到原任务

事件带 `thread`（例如 `github:owner/repo#12`），`threads` 表把它映射到 session。开出任务的事件自带的 thread 在建 session 时登记；之后才出现的（agent 开的 PR）由 agent 调 `follow` 工具登记。对得上就设 `resume`，对不上就开新 session。这个判断只读数据库，不读 worker 内存（§3.2）。

组批的键是 `resume`；没有 `resume` 的事件按 `thread` 分组，两者都没有的才共用一个新 session。规范的 I-EVT-6 让所有首次出现的事件共用一个新 session，这里收紧了：两个不同的 issue 不该进同一项任务。一次 run 仍然只在一个 session 里。

事件状态比规范多一个 `dead`：重试超过 `MAX_ATTEMPTS` 的事件停在这里，不再被取走，在 `aoa status` 里可见。

## 5. 流程

### worker

照 §8.2。每个 inbox 一个 worker，每次醒来都重新从 `events` 拉取，不信唤醒信号里带的内容。互斥由数据库保证，不靠进程里的锁：claim 是一个事务，只有这个 inbox 没有未过期的租约时才成功。run 的结局、session 的更新和事件标 `done` 在同一个事务里提交。

一次尝试失败时（runtime 抛出，或租约过期），这批事件带着 `next_attempt_at` 回到 `pending`：第一次失败后 30 秒，第二次后 2 分钟（§9）。租约过期的算在租约到期那一刻，不是某个 worker 发现它的时刻。延迟期间同一 inbox 里别的 session 照常运行；同一 session 之后来的事件排在它们后面，所以 session 内的顺序不变。worker 按 `next_attempt_at` 睡到点，自己醒来。

每个提交点都有名字：`after_append`、`after_claim`、`after_tool_exec`、`after_tool_result`、`before_complete`。一致性测试靠这些名字在指定位置杀进程。

一项任务停在延后调用上时，session 标 `paused`，run 结束，worker 接着取下一项（I-PRM-4）。每项任务有自己的 worktree，互不干扰。

### 重跑时副作用不重复

规范写的是按 `(run_id, call_id)` 幂等。重跑会得到新的 run，所以这里改用 `(session_id, call_id)`，分两层：

1. transcript 只追加，每次工具调用后落盘。重跑的 run 恢复 session，已有结果的调用不会再执行（I-CTX-4）。
2. 剩下的缺口是「工具执行了，结果还没落盘就崩了」。工具执行前先在 `tool_journal` 记下意图；恢复时遇到有意图、没结果的调用，不重跑，把「结果未知，先查再决定」作为工具结果交回 loop。自带幂等键的工具（开 PR 以分支名为键）可以声明自己能安全重跑。

### scheduler

照 §4.3。第一版的周期只有固定间隔（`{ everyMs, anchor }`），下一次总是从 anchor 算，不累加，所以不会漂；没有 cron。按最早的 `due` 定闹钟，最长一分钟复查一次。到点时在同一个事务里写事件、把 follow-up 标完成、把 schedule 推到下一次。事件的 `dedupe_key` 是 `(timer_id, occurrence)`。停机期间错过的只补最近一次。

### dispatcher

读 `outbox` 里 pending 的消息，按节奏交给 `Channel.deliver`，失败按 1、2、4、8 分钟退避，超过上限的留在表里并在 `aoa status` 里显示（I-OUT-4）。节奏规则是纯函数，方便测试。

### 事件源

GitHub 靠轮询，不开 webhook 入口。游标和事件在同一个事务里存下，崩溃只会重复一次轮询，重复的事件被 `dedupe_key` 去掉。
