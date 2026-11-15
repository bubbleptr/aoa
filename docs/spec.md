# Always-on Agent 设计规范

> 提炼自 Claude《Building always-on agents》（William Hu，2026-11-13）。
> 原文：<https://claude.com/resources/articles/building-always-on-agents>
>
> 原文的论断在各节「原文要点」里转述，只保留少量短句原话（引用块），完整内容请读原文；其余是按原文推出的约束。原文的 7 张插图不再保留，全部替换为与编程语言无关的形式化模型；每张图对应哪一段形式化，见[附录 B](#附录-b-与原图的对应)。

**适用范围**：任何需要长期存在、跨多次运行保持状态、无人值守地主动行动的 agent。不绑定模型、框架、存储或部署形态。

**版本**：v1 · 2026-11-16。

## 0. 读法

### 0.1 三种用法

| 用途 | 路径 |
| --- | --- |
| 从零实现 | §1 定义 → §3–§7 五个原语 → §8 接线 → §9 验收 |
| 评审已有系统 | 直接对照 §9 与各节「不变量」；多数可以用故障注入或事件重放验证 |
| Agent 读取 | 只读标记为 `spec` 的代码块。`PARAM` 必须由产品先赋值，`PREMISE` 是模型前提，缺一不可执行 |

### 0.2 文内标记

- **「原文要点」**：原文的转述，少量短句原话放在引用块里，只用于核对，不参与改写。
- **`spec` 代码块**：形式化模型。语法见[附录 A](#附录-a-形式记号)。块内注释与标识符用英文，以实现无关的符号表达关系。
- **【推导】**：原文没写、但由原文约束可以推出的实现要求。
- **【决策】**：原文未规定，实现者必须选定并记录，否则实现不可复现。
- 各节不变量若不是原文原话，都是从引用块里的约束推出的形式化写法；原文的说法以引用块为准。
- **规范性内容**是 §3–§8 的 `STATE`、`RULE`、`FLOW`、`INVARIANT`、`POLICY`；其余是说明性内容。

**合规判定**：实现只要能表达「持久集合、原子状态迁移、因果顺序」三件事，并满足各节不变量、通过 §9，就与本规范一致。存储用表、日志、队列还是对象存储不影响判定。

### 0.3 五个原语

| 原语 | 职责 | 回答的问题 | 自己的存储 |
| --- | --- | --- | --- |
| Event inbox | 收下所有唤醒源 | 什么时候醒来 | 事件表 |
| Timers | 由时间触发 | 什么时候再醒来 | 定时器表 |
| Memory | 跨 run 携带信息 | 什么带到下一次 | 文件或对象存储 |
| Permissions | 裁决每个工具调用 | 能自己做什么 | 凭据代理 + 策略 |
| Outbox | 把结果送达用户 | 说了什么 | 消息表 |

## 1. 定义与运行周期

### 1.1 三个术语

原文把 always-on agent 定义为有状态、主动的 agent：跨会话管理上下文，不需要人盯着就能行动。它跑的仍是和其他 agent 一样的核心循环，区别在外围架构：一组原语决定 agent 何时醒来、哪些东西跨 run 保留、工作结果怎么送到用户手里。

> An always-on agent is not actually “always on.” This is just a description of the user experience.

实际上 agent 大部分时间在睡眠，周期性醒来干活。每一段工作叫一次 **run**：收到事件、完成任务、保存这次发生了什么。run 在一个 **session** 里进行，session 是消息和工具调用的记录。run 结束后 agent 回去睡，如此无限循环。

三个术语的边界，后文一律以此为准：

| 概念 | 定义 | 时间尺度 | 持久性 |
| --- | --- | --- | --- |
| run | 一次从醒来到睡下的工作 | 分钟级，有界 | 进程内，结束即消失 |
| session | 消息与工具调用的记录 | 可横跨多次 run | 持久 |
| 存储状态 | 五个原语里的数据 | 跨 run 无限期 | 持久 |

原文把这一形态最近变得可行归因于两点：模型判断力提升，更可靠地理解用户意图、判断何时该来确认；推理成本下降，长程任务的单任务成本降得比典型负载更快。

### 1.2 时间轴

原文的第一张图是一条时间轴：大段睡眠不消耗 token，中间插入短暂的 run，每个 run 四步走，并把状态写回跨 run 保留的存储。

```spec
-- TIME: idle is the default state, not the exception.
Idle     ≜ { σ : σ.runs = ∅ }
Timeline ≜ [ Idle, Run, Idle, Run, ... ]              -- unbounded; idle dominates

WakeSource ≜ user_message | webhook | timer | background_job | approval_answer
-- an event is the only way a run starts (I-SYS-1)

PREMISE  while idle: no model inference, no worker assignment, no tokens spent
```

```spec
-- SORT: the two durable units a run reads and writes.
Session ≜ {
  id         : SessionId,
  transcript : [Turn],             -- append-only
  status     : open | paused | closed,
  pending    : CallId?,            -- set while a deferred call waits for the user
  last_run   : RunId?
}
Turn ≜ UserMsg | AgentMsg | ToolCall | ToolResult | PermissionAnswer

RunEnd ≜ Sent([MsgId]) | Silent | Deferred(CallId)

Run ≜ {
  id      : RunId,
  inbox   : InboxId,
  session : SessionId,
  trigger : {EventId},             -- non-empty
  phase   : Phase,
  end     : RunEnd?                -- set exactly once, when the run ends
}
```

```spec
-- PHASE: the four steps of one run, then back to idle.
Phase ≜ arrive | open_session | loop | write_back | ended

RULE Wake(i)
  PRE   ¬busy(i) ∧ pending(i) ≠ ∅
  DO    e0 ← head(pending(i))
        batch ← { e ∈ pending(i) : resume(e) = resume(e0) }   -- one session per run; see I-EVT-6
        batch.status ← in_run
        r ← Run(trigger = ids(batch), session = choose(batch), phase = arrive)
        phase(r) ← open_session
  POST  one active run per inbox

RULE Finish(r)
  PRE   phase(r) = write_back ∧ all writes of r committed
  DO    events(trigger(r)).status ← done
        phase(r) ← ended ; σ.runs ← σ.runs \ { r }
  POST  idle

choose(batch) ≜
  let e = head(batch)
  in  if e.resume ≠ ⊥ then e.resume else fresh(SessionId)
-- every event in a batch carries the same resume value; ⊥ means one shared new session
```

### 1.3 每个 run 的四个阶段

| # | 阶段 | 动作 | 提交点 |
| --- | --- | --- | --- |
| 1 | 事件到达 | handler 把事件写入 inbox，唤醒 worker | 事件落盘后才 ack |
| 2 | session 开始 | 新建 session，或恢复既有 session | session 指针 |
| 3 | agent loop | 读 memory 建立基线，按权限调用工具 | 每次工具调用 |
| 4 | 写回 | memory、session、timer、outbox 更新 | 全部提交后才回到睡眠 |

### 1.4 从定义直接得到的约束

- **「always on」是体验描述，不是进程描述**。用常驻进程轮询模型来模拟它是错的成本模型。
- **run 必须短**。每个 run 都有固定上下文开销（见 5.5），长任务靠 progress 文件加 timer 分片，而不是靠一个 run 跑到底。【推导】
- **唤醒只来自事件**。定时器不直接叫 run，而是把事件放进 inbox（§4）。
- **连续性只能落在持久状态上**。session 之间没有任何内存共享，跨 session 的连续性全部由 memory 承载（§5）。

## 2. 全局状态

### 2.1 状态空间

```spec
Σ ≜ {
  inbox    : EventId   ⇀ Event,
  timers   : TimerId   ⇀ Timer,
  sessions : SessionId ⇀ Session,
  memory   : MemoryTree,
  outbox   : MsgId     ⇀ OutMsg,
  deferred : CallId    ⇀ PendingCall,     -- tool calls waiting for the user
  runs     : RunId     ⇀ Run,             -- active only
  workers  : WorkerId  ⇀ Worker           -- volatile
}

PERSISTENT  inbox, timers, sessions, memory, outbox, deferred
VOLATILE    runs, workers
REQUIRE     every write to a PERSISTENT store is committed before the run reports done
```

### 2.2 谁写、谁读、活多久

| 存储 | 写者 | 读者 | 保留期 |
| --- | --- | --- | --- |
| inbox | handler（追加）、worker（改状态） | worker | 直到 done 或 dropped；审计另存 |
| timers | run（设置）、scheduler（递推） | scheduler | 到触发；schedule 长期存在 |
| sessions | run（追加） | run | 到会话关闭 |
| memory | run、离线整理任务 | run | 永久 |
| outbox | run（追加）、dispatcher（改状态） | dispatcher | 到 sent；失败保留 |
| deferred | run（创建、消解） | worker、dispatcher、UI | 到答复或过期 |
| runs / workers | worker | worker | run 期间 |

## 3. Event inbox

### 3.1 原文要点

大多数 agent 只在用户发消息时运行；always-on agent 可以被 webhook、定时任务、后台作业等多种事件触发。让每个事件源直接调用 agent 看似简单，但会出问题：两个事件同时到达会启动互相竞争的 run，进程崩溃会让事件整个丢掉。

原文的解法是事件 inbox：

> Instead of calling the agent, every source sends an event to an inbox, where a worker picks it up.

最简单的形态有三部分：一个持久的事件列表（通常是数据库表）；一个把事件写进列表的 handler（通常是 HTTP 端点）；一个从列表读取的 worker（通常是后台服务）。

inbox 要记录每个事件的状态，可以按事件源给的唯一标识去重。关系数据库很合适，每个事件追加一行。原文建议从每个用户一个 inbox 开始，需要更多并行时再拆分。

新事件到达时，handler 把它写进 inbox 并唤醒 worker；worker 读取所有待处理事件，开始一次 run。延续之前工作的事件（比如用户的回复）恢复已有 session，其余的开新 session。worker 把事件交给 agent loop，等 run 结束，再把对应事件标为完成。

四条最佳实践（原文要点）：

- **handler 要快速确认。** 有些事件源（比如 webhook 提供方）把慢响应当成失败。handler 只做轻量检查，更深的校验（比如检查 prompt injection）放到 run 里做。
- **inbox 是事实来源。** worker 被唤醒时先从 inbox 拉最新事件；这样 worker 在 run 中途死掉，新的 worker 能接手同一个事件重试。
- **一个 inbox 同时只有一个活跃的 worker。** 避免两个 run 重复干活或互相覆盖。run 进行中来了新事件，可以推到下一次 run、并进当前 run，或者中断后重来。
- **worker 把待处理事件合成一批。** 比如用户连发几条消息，worker 把它们合进一次 run，agent 只需回复一次。

### 3.2 结构

```spec
SORT EventStatus ≜ pending | in_run | done | dropped
SORT EventSource ≜ user_message | webhook | timer | background_job | approval_answer

Event ≜ {
  id          : EventId,
  source      : EventSource,
  dedupe_key  : Text,          -- unique id from the source (delivery id, message id, ...)
  received_at : Time,
  payload     : Payload,
  resume      : SessionId?,    -- set iff the event continues earlier work
  status      : EventStatus,
  lease_until : Time?,         -- set while status = in_run
  attempts    : Nat,
  run         : RunId?
}

Inbox ≜ { Event }              -- logical set, one per user by default; Σ.inbox is keyed by id
UNIQUE (source, dedupe_key) over { e ∈ Inbox : e.status ≠ dropped }
```

`resume` 是原文“继续早先工作”与“其余开新会话”这两条路径的唯一区分依据。判断发生在入队时或 claim 时都可以，但必须只依据持久数据，不能依据 worker 内存。

### 3.3 事件状态机

```spec
STATE Event.status
  append   : —        → pending    -- durable before the handler acks
  dedupe   : —        → dropped    -- same (source, dedupe_key) already accepted; kept for audit
  claim    : pending  → in_run     -- atomic; lease_until ← now + LEASE
  complete : in_run   → done       -- only after the run's writes are committed
  expire   : in_run   → pending    -- lease expired because the worker died; attempts += 1
```

`in_run` 不是终态，是带期限的租约。这条是从原文“a new one can pick up the same event and retry”推出的：如果 `in_run` 永久占用，崩溃一次事件就永远卡住。【推导】

### 3.4 处理流程

```spec
FLOW F-INBOX [source, handler, inbox, worker, run]
  1  source  --event--> handler
  2  handler --append(e)--> inbox                 [durable]
  3  handler --2xx--> source                      [≤ ACK_MAX; no deep verification here]
  4  handler --wake--> worker                     [volatile signal; may arrive before step 2 or be lost]
  5  worker  --read(pending)--> inbox             after 3
  6  worker  --claim(batch)--> inbox              after 5   [atomic]
  7  worker  --start--> run                       after 6
  8  run     --loop--> run                        after 7
  9  worker  --complete(batch)--> inbox           after 8   [after all writes commit]
```

顺序约束只有 `2 ≺ 3` 和 `5 ≺ 6 ≺ 7 ≺ 8 ≺ 9`。步骤 4 是尽力而为的信号，因此 worker 每次醒来都必须重新从 inbox 拉取，不能信任唤醒里携带的内容。

```spec
POLICY P-EVT-8  (deep checks inside the run)
  REQUIRE  the handler performs only cheap, stateless checks
  REQUIRE  content-dependent verification (e.g. prompt-injection screening) happens after claim
  why   the ack deadline rules out anything expensive; content is only meaningful in context
```

### 3.5 不变量

```spec
INVARIANT I-EVT-1  (single active worker)
  ∀ i : |{ w ∈ σ.workers : owns(w, i) }| ≤ 1
  also  ∀ i : |{ r ∈ σ.runs : inbox(r) = i }| ≤ 1
  why   prevents competing runs that duplicate work or overwrite each other

INVARIANT I-EVT-2  (no silent loss)
  accepted(e) ⇒ ◇ (e.status = done ∨ e.status = dropped)
  why   a crash must not swallow an event; retry must be possible

INVARIANT I-EVT-3  (at-least-once processing)
  crash after claim ⇒ e eventually returns to pending after LEASE
  -- consequence: side effects must be idempotent, keyed by (run_id, call_id)
  why   a retried run must not duplicate its external effects

INVARIANT I-EVT-4  (dedupe)
  accepted(e1) ∧ accepted(e2) ∧ e1 ≠ e2 ⇒ (source, dedupe_key) of e1 ≠ that of e2
  why   webhook providers and queues redeliver

INVARIANT I-EVT-5  (fast ack)
  t(ack, e) - t(receive, e) ≤ ACK_MAX
  why   slow responses are treated as failures by sources; deep checks belong in the run

INVARIANT I-EVT-6  (one session per run)
  ∀ e1, e2 ∈ trigger(r) : resume(e1) = resume(e2)
  resume(e) = s  ⇒ session(r) = s ∧ status(s) ≠ paused
  resume(e) = ⊥  ⇒ session(r) is fresh, shared by every first-contact event in the batch
  why   a run works inside exactly one session; a batch is grouped by resume target first
```

I-EVT-6 是【推导】：原文说明 worker 可以合并多条待处理事件、又说 run 只在一个 session 里工作，两者并置意味着批处理必须先按 `resume` 分组。一组之外的事件留给下一个 run；未指明会话的事件共用一个新会话。

```spec
INVARIANT I-EVT-7  (session affinity)
  session ↦ inbox is stable for the lifetime of the session
  why   splitting the inbox for parallelism must not let two inboxes resume one session
```

按用户分 inbox 时 I-EVT-7 自然成立；为了提高并行度按会话或租户再分片时，它就成为必须显式维持的约束。

### 3.6 失效模式

| 失效 | 原文依据 | 机制 | 对应不变量 |
| --- | --- | --- | --- |
| 两个事件同时到，起两个竞争 run | “two events arriving at the same time can start competing runs” | 每个 inbox 单 worker，claim 原子 | I-EVT-1 |
| worker 崩溃，事件消失 | “a crash can lose an event entirely” | 先落盘再 ack，claim 是租约 | I-EVT-2 |
| 源重复投递 | 原图 “Delivered twice, same ID → dropped” | `(source, dedupe_key)` 唯一 | I-EVT-4 |
| 崩溃后重跑导致副作用两次 | 未明写 | 副作用按 `(run_id, call_id)` 幂等 | I-EVT-3 |
| 源嫌响应慢判失败并重试 | “treat slow responses as failures” | 快速 ack | I-EVT-5 |
| 注入内容在 run 外被采信 | “deeper verification … should be done during the run” | handler 只做浅检查 | P-EVT-8 |
| 连续多条消息触发多个 run | 未明写 | 批处理合并 | I-EVT-6 |
| 两个 inbox 同时恢复同一 session | 未明写 | session 亲和 | I-EVT-7 |

### 3.7 待定决策

run 进行中新事件的处理方式，原文给了三个选项，形式化如下：

```spec
PARAM MidRunPolicy ≜ next_run | fold_into_run | interrupt_restart
-- next_run        : leave the event pending; the current run continues untouched
-- fold_into_run   : add the event to the running run's input; one reply covers both
-- interrupt_restart: end the current run and start again with the union of triggers
```

| 编号 | 决策 | 取值 | 影响 |
| --- | --- | --- | --- |
| D-EVT-1 | run 进行中新事件怎么办 | `next_run` / `fold_into_run` / `interrupt_restart` | 延迟、token 浪费、可见性三者互换；原文给出这三个选项，未指定默认 |
| D-EVT-2 | inbox 粒度 | 每用户 / 每会话 / 每租户 | 并行度与 I-EVT-7 的维护成本 |
| D-EVT-3 | 批处理窗口 | 立即 / 固定 debounce | 合并率与首条消息延迟 |
| D-EVT-4 | 重试上限与死信 | `MAX_ATTEMPTS` + dead-letter | 毒事件不能无限重试 |
| D-EVT-5 | 租约长度 | 与 run 最大时长同阶 | 太短会重跑，太长会卡住 |
| D-EVT-6 | 跨 session 批次的分组顺序 | 按到达时间 / 按 session 优先级 | 同一 inbox 内的公平性 |

## 4. Timers

### 4.1 原文要点

timer 和事件 inbox 一起让 always-on agent 能主动行动。timer 大致分两类：follow-up 是 agent 给自己定的截止时间（比如回头看看有没有回复）；schedule 是按已知节奏重复的任务（比如每日简报）。

timer 有自己的持久存储，通常是另一张表，和 inbox 分开：inbox 只放已经可以处理的事件。follow-up 和 schedule 的结构相近，但 schedule 还要记录重复规则。

> A timer doesn’t initiate a run on its own.

由一个 scheduler（通常是后台服务）按固定间隔轮询存储，触发到期的 timer。每一轮它：

1. 找出到期的 timer。
2. 按类别更新：follow-up 标为完成，schedule 把到期时间推到下一次。
3. 往 inbox 加一个事件，并唤醒 worker。

scheduler 可以自己写，也可以用持久化执行引擎（durable execution engine）。

### 4.2 结构

```spec
SORT TimerKind   ≜ follow_up | schedule
SORT TimerStatus ≜ armed | done | cancelled

Timer ≜ {
  id         : TimerId,
  kind       : TimerKind,
  session    : SessionId?,      -- required for follow_up; ⊥ means the event opens a new session
  due        : Time,
  recurrence : Recurrence?,     -- present iff kind = schedule
  payload    : Payload,
  status     : TimerStatus,
  last_fired : Time?
}

REQUIRE  (kind = schedule) ⇔ (recurrence ≠ ⊥)
-- after firing: follow_up ends in done; schedule advances due (I-TMR-3)
```

两类共用一个结构，差别只在“触发之后往哪去”：follow-up 终结，schedule 递推。原文把两者分开存，理由写在就绪语义上：**inbox 只放已经可以处理的事件**，没到期的东西不在 inbox 里。

### 4.3 调度

```spec
RULE SchedulerPass(now)
  for t ∈ { u ∈ σ.timers : u.status = armed ∧ u.due ≤ now } :
    occurrence ← t.due
    e ← Event(source = timer, dedupe_key = (t.id, occurrence), resume = t.session)
    ATOMIC {
      append(e) to σ.inbox
      t.last_fired ← occurrence
      if t.kind = follow_up
        then t.status ← done
        else t.due ← next(t.recurrence, now)          -- or next(..., occurrence); see D-TMR-2
             t.status ← armed
    }
  wake(worker)
```

`ATOMIC` 是必要条件，不是优化。若“追加事件”和“推进定时器”分两步提交，中间崩溃会得到一个已发事件但未推进的定时器，下一轮再发一遍；反之则会漏发。`dedupe_key` 用 `(timer, occurrence)` 让重复也收敛到一条。

多实例调度器必须用条件更新（`WHERE status = armed AND due = occurrence`）或租约，否则两个实例会同时看到同一个到期项。

### 4.4 不变量

```spec
INVARIANT I-TMR-1  (one event per occurrence)
  ∀ t, o : |{ e ∈ σ.inbox : e.source = timer ∧ e.dedupe_key = (t.id, o) }| ≤ 1
  why   duplicated scans, restarts and clock re-reads must not duplicate wake-ups

INVARIANT I-TMR-2  (timers never start runs directly)
  ¬∃ transition : σ.timers → σ.runs
  why   the inbox stays the single entry point; all runs are traceable to events

INVARIANT I-TMR-3  (terminal and recurrence rules)
  follow_up fires ⇒ status = done
  schedule  fires ⇒ due > occurrence ∧ status = armed

INVARIANT I-TMR-4  (bounded lateness)
  fired_at(t) - due(t) ≤ POLL_INTERVAL + ε
  -- fired_at(t) is the time the timer's event was appended
  why   polling is the only source of punctuality

INVARIANT I-TMR-5  (store separation)
  at any now,  ∀ t ∈ σ.timers : t.status = armed ∧ t.due > now
    ⇒ no event in σ.inbox with dedupe_key = (t.id, t.due)
  why   the inbox only holds work that can be done now; unreached timers wait in their own store
```

### 4.5 失效模式

| 失效 | 机制 | 对应不变量 |
| --- | --- | --- |
| 调度器停摆期间到期的定时器丢失 | `armed` 持久化，重启后仍满足 `due ≤ now` | I-TMR-1 |
| 多实例重复扫描 | 条件更新 + occurrence 去重 | I-TMR-1 |
| follow-up 反复触发 | 触发即 `done` | I-TMR-3 |
| schedule 越跑越偏 | 下次 `due` 由 recurrence 重算，不累加固定间隔 | I-TMR-3 |
| 时钟回拨造成重复 | occurrence 幂等，计时用单调钟 | I-TMR-1 |
| 停机后补发风暴 | 补齐策略 | D-TMR-1 |
| 会话已关闭仍被唤醒 | 关闭时联动 `cancel` | D-TMR-6 |

### 4.6 待定决策

| 编号 | 决策 | 取值 | 影响 |
| --- | --- | --- | --- |
| D-TMR-1 | 停机错过的 occurrence | 全补 / 只补最近一次 / 跳过 | 通知类补全会骚扰；幂等任务适合全补 |
| D-TMR-2 | 下次 `due` 的基准 | `next(recurrence, now)` / `next(recurrence, occurrence)` | 用 `now` 不补发、不堆积；用 `occurrence` 保持节拍 |
| D-TMR-3 | 调度器实现 | 自建轮询 / 持久执行引擎 | 自建简单但要自己处理多实例；引擎省掉租约与重试 |
| D-TMR-4 | 抖动 | 0 / 随机窗口 | 大量定时器同一时刻到期会造成尖峰 |
| D-TMR-5 | schedule 的会话归属 | 恢复原会话 / 每次新会话 | 早报适合新会话，任务跟进适合恢复 |
| D-TMR-6 | 会话关闭时的定时器 | 取消 / 照常触发 | 悬空唤醒会创建孤立会话 |

## 5. Memory

### 5.1 原文要点

always-on agent 在许多彼此断开的 run 之间工作，靠记忆保持连续。和 inbox、timer 一样，记忆也该有自己的存储。原文提到 Claude Code 的 auto memory 和 Messages API 的 memory tool 都把记忆实现成一个文件目录；对 always-on agent，这些目录应映射到持久存储（通常是数据库或对象存储），让记忆比 worker 活得长。

> As a rule of thumb, memory should only hold what the agent can’t look up again.

已经存在别的系统里的东西（比如 issue tracker），只存一个指针。

四类记忆（原文要点）：

- **用户指令：** 用户对 agent 行为的指令单独存一个文件，每次 run 开始时加载。用户不会一直在场纠正 agent，所以指令必须跨 run 保留。
- **用户笔记：** agent 了解到的关于用户的东西，比如角色、偏好、给过的纠正。可以先用一个文件，多了再拆成小文件；拆分后每次 run 只加载索引，需要细节时再读具体文件。
- **已发消息：** agent 记下已经告诉过用户什么，避免重复。可以存在每次 run 都加载的单独文件里，也可以让 worker 加载最近几条与用户的消息。
- **任务进度：** 每个进行中的任务有一个进度文件，写清做了什么、还剩什么，新的 run 读它就能接着做。和用户笔记一样，每次只加载索引，需要时再读具体文件。

以上都是 run 中保存的记忆。原文还提到可以加 dreaming：回顾过去的 session 来整理记忆，替换过时的条目，找出只有跨多次 run 才看得出的模式。

### 5.2 结构

```spec
MemoryTree ≜ Name ⇀ Node
Node ≜ File(content) | Dir(MemoryTree)

RESIDENT  ≜ { instructions.md, index.md, reported.md }    -- loaded on every run
ON_DEMAND ≜ { notes/, progress/ }                          -- pulled in only when needed

Load(run) ≜ content(RESIDENT) ⊕ content({ f ∈ ON_DEMAND : requested(f, run) })
```

| 路径 | 内容 | 读取时机 | 写法 |
| --- | --- | --- | --- |
| `instructions.md` | 用户对 agent 行为的指令 | 每个 run | 用户修改；agent 不擅自删改 |
| `index.md` | `notes/` 与 `progress/` 的索引 | 每个 run | 增删文件时同步 |
| `reported.md` | 已经告知过用户的内容 | 每个 run | 发送后追加 |
| `notes/` | 关于用户的知识（角色、偏好、纠正） | 需要时 | 小文件，可合并 |
| `progress/` | 任务进度：已做与未做 | 需要时 | 每个进行中任务一个文件 |

常驻集合是每个 run 的固定成本，所以 `index.md` 承担“目录”而不是“内容”：目录常驻，正文按需拉取。这与 5.5 的预算约束是同一件事。

### 5.3 写回规则

```spec
RULE Persist(run, fact)
  PRE   fact ∈ learned(run)
  DO    append or update the owning file
  POST  fact ∈ σ.memory when the run reaches write_back

POLICY PointerNotCopy
  REQUIRE  ∀ f ∈ σ.memory : isPointer(f) ∨ ¬retrievable(f, external)
  -- duplicated content drifts from its source; store the reference instead

POLICY ResidentBound
  REQUIRE  size(RESIDENT) ≤ B_RESIDENT
  -- the fixed overhead is paid on every run, so it must stay small
```

`PointerNotCopy` 无法机械校验，只能作为评审项。它的代价很直接：复制一份到 memory 之后，外部系统改了，memory 就分叉，agent 会按过期事实行动。

### 5.4 离线整理

```spec
Curate : [Session] × MemoryTree ⇀ MemoryTree
  -- reviews past sessions, replaces outdated entries, finds patterns visible only across runs

PREMISE  Curate runs outside the run loop, as its own background job
REQUIRE  removing or rewriting user instructions needs user confirmation
REQUIRE  Curate writes a new version; readers never observe a half-updated tree
```

### 5.5 上下文窗口

开始干活前，agent 先加载系统提示、工具定义和记忆文件。这部分初始上下文每次 run 都要付，原文建议保持精简，并用 prompt caching 降低成本。

新 session 只带这部分开销和触发这次 run 的事件；已有 session 还会带回之前 run 的消息和工具调用。

session 太长时，可以压缩较早的消息，或者开一个新 session。两种做法都会丢细节，所以需要保留的东西要在过程中存进记忆。

```spec
Limit ≜ context window size of the model
Fixed ≜ SystemPrompt ⊕ ToolDefs ⊕ Load(run)
Context(run) ≜ Fixed ⊕ Trigger(run) ⊕ Resumed(run) ⊕ tool_io

Resumed(run) ≜ transcript(session(run))        if the session existed
             | ∅                               if the session is new
```

```spec
RULE Compact(s)
  PRE   |Context| > COMPACT_THRESHOLD
  DO    transcript(s) ← Summary(prefix) ⊕ suffix
  REQUIRE  Persist(facts that only exist in prefix) committed first

RULE NewSession(s)
  DO    s' ← Session(transcript = Recent(k, transcript(s)))    -- k may be 0
  REQUIRE  Persist(facts that only exist in s) committed first
```

两条路径都会丢细节，区别只是丢多少：压缩把旧 transcript 变成摘要，新会话只保留最近 `k` 条（原图给出的示例是最近几条消息）。因此两条路径共享同一条义务：**丢掉之前，先落盘**。

### 5.6 不变量

```spec
INVARIANT I-CTX-1  (bounded context)
  ∀ r : size(Context(r)) ≤ Limit

INVARIANT I-CTX-2  (information conservation)
  ∀ f : needed_later(f) ⇒ f ∈ σ.memory ∪ external(f)
  why   compaction and new sessions lose detail; anything not persisted is gone

INVARIANT I-CTX-3  (bounded fixed overhead)
  size(Fixed) ≤ B_FIXED
  why   the overhead is paid on every run; caching does not remove it, only discounts it

INVARIANT I-CTX-4  (append-only transcript)
  ∀ r : transcript(session(r)) is read-only during the run; the run only appends
  why   resuming a session must not re-execute earlier tool calls
```

I-CTX-2 不能机械检查，但可以按 run 审计：压缩前必须能指出被丢内容里哪些事实已经落盘。没有这条，压缩就是静默的数据丢失。

### 5.7 失效模式

| 失效 | 机制 | 对应不变量 |
| --- | --- | --- |
| 每个 run 的上下文开销过大 | 常驻集合有界 + prompt caching | I-CTX-3 |
| session 增长超过上限 | 压缩或开新会话 | I-CTX-1 |
| 压缩丢掉唯一副本 | 先写 memory 再压缩 | I-CTX-2 |
| 恢复 session 时重放旧工具调用 | transcript 只追加 | I-CTX-4 |
| memory 与外部系统分叉 | 只存指针 | 5.3 |
| memory 无限增长 | 离线整理与归档 | 5.4 |
| 沿用过期的用户指令 | 指令变更走用户确认 | 5.4 |
| 两个 run 同时写 memory | 同一 inbox 内串行；按会话拆 inbox 时要保证 memory 只有一个写者 | I-EVT-1 |

### 5.8 待定决策

| 编号 | 决策 | 取值 | 影响 |
| --- | --- | --- | --- |
| D-MEM-1 | 常驻集合 | 三文件 + 两目录 / 单文件 | 固定开销与检索精度的权衡；原文建议先单文件、内容变多再拆 |
| D-MEM-2 | 压缩阈值与保留项 | 70–80% + 最近 N 轮 | 阈值低则压缩频繁，高则易溢出 |
| D-MEM-3 | 新会话是否带最近 k 条 | 0 / k | 带则连续性好，但占用预算且可能重复告知 |
| D-MEM-4 | 整理任务频率与权限 | 每天 / 每周；只改 notes 还是也改 progress | 整理本身有出错风险 |
| D-MEM-5 | 记忆版本化 | 覆盖 / 保留历史 | 保留历史便于回溯，代价是存储与检索 |

## 6. Permissions

### 6.1 原文要点

> Permissions are where always-on agents carry the most risk.

一次 run 持有用户的访问权限，而且按设计无人值守。对每个工具调用，agent 都要决定自己继续、拦下，还是等待批准。所需的组件和其他 agent 相同：

- **凭据存储（credential store）：** always-on agent 常要用到密码、访问令牌这类敏感凭据。推荐做法是在 agent 环境之外放一个 proxy，由它给出站请求加上凭据：agent 发出的请求不带凭据，proxy 在转发前注入真实凭据。
- **Auto mode：** always-on agent 应该能在没有持续用户输入的情况下工作。Claude Code 的 auto mode 用 classifier 审查高风险操作，拦下判定为危险的，让 Claude 换一种更安全的做法；但最重要的决定仍需要用户审核。
- **Deferred tool calls：** 在 Claude Code 里，hook 可以把一个工具调用延后，等用户补充输入。always-on agent 也一样，某些操作之前可能需要澄清或批准。调用被延后时，run 结束，session 停在调用中途存下；请求展示给用户（比如用 MCP Apps 做的交互卡片），用户的答复作为事件回到 inbox，启动新的 run，带着用户的输入恢复那个 session。等答复期间 worker 可以处理别的事件，agent 不会被卡住。

### 6.2 结构

```spec
SORT RiskTier ≜ low | medium | high
SORT Decision ≜ allow | block | defer

ToolCall ≜ { id : CallId, tool : ToolName, args : Args, session : SessionId, risk : RiskTier }
PendingCall ≜ { call : ToolCall, session : SessionId, requested_at : Time, expires_at : Time }

Policy : ToolCall → Decision          -- configured per tool and risk tier; unknown calls default to defer
```

`Policy` 的输入里没有“模型认为安全”这一项。这是本节的要害：放行判断必须来自模型之外的配置或分类器，否则等于让被约束者自己签发许可。

### 6.3 裁决

```spec
RULE Check(call)
  d ← Policy(call)
  case d of
    allow → Execute(call)                                  -- unattended
    block → Result(call) ← blocked ; continue the loop      -- the agent may find a safer approach
    defer → σ.deferred[call.id] ← PendingCall(call, ...)
            σ.sessions[call.session].pending ← call.id
            σ.sessions[call.session].status ← paused
            end(run, Deferred(call.id))                   -- the run stops; no tool result yet
```

`block` 与 `defer` 的区别不是程度，而是是否继续：`block` 立即把拒绝作为工具结果交回 loop，agent 在同一 run 里换一条路；`defer` 直接把 run 结束掉，把决定权交给人。

### 6.4 延后调用

```spec
FLOW F-DEFER [run, store, outbox, ui, user, inbox, worker]
  1  run    --persist(session, pending call, transcript so far)--> store     [durable]
  2  run    --end(Deferred)--> worker                  [worker is free immediately]
  3  run    --request(call)--> outbox | ui             -- either route; exactly one
  4  user   --answer(verdict)--> inbox                 -- source = approval_answer
  5  inbox  --event(corr = call.id, resume = session)--> worker
  6  worker --claim--> run'
  7  run'   --resume(session, verdict)--> loop         [pending call cleared atomically]
```

第 2 步是这套设计的核心收益：等待用户期间不占 worker，也不占 session 的活跃 run。第 3 步的两条路径（outbox 或自有界面）在原文里是并列可选，但第 5 步的入口只有一个，答复必须回到 inbox。

```spec
FLOW F-EGRESS [run, proxy, upstream]
  1  run   --request without credentials--> proxy
  2  proxy --inject(credential)--> upstream
  -- the agent never holds the credential, so it cannot leak it into context
```

### 6.5 不变量

```spec
INVARIANT I-PRM-1  (no credentials in the agent)
  ∀ b ∈ Context(run) ∪ ⋃ { args(c) : c ∈ calls(run) } : ¬secret(b)
  why   the agent holds the user's access; a leaked secret is a leaked account

INVARIANT I-PRM-2  (no execution without authorization)
  Execute(c) ⇒ Policy(c) = allow ∨ Answer(c) = approve

INVARIANT I-PRM-3  (block continues the run)
  Decision(c) = block ⇒ Result(c) is returned to the loop and the run continues
  why   blocking must redirect the agent, not stall it

INVARIANT I-PRM-4  (defer does not hold the worker)
  status(session) = paused ⇒ no active run for that session ∧ no worker waits on it
  why   waiting for a human must not stop other events

INVARIANT I-PRM-5  (exactly one answer per call)
  |{ e ∈ σ.inbox : e.source = approval_answer ∧ e.corr = c }| ≤ 1
  -- duplicates are dropped; an unanswered call expires (see D-PRM-2)

INVARIANT I-PRM-6  (high-risk review stays human)
  risk(c) = high ∧ Decision(c) = allow ⇒ configured-by(user, allow(c))
  why   the most important decisions still need review; the model cannot authorize itself

INVARIANT I-PRM-7  (audit)
  ∀ c : (c, Decision(c), basis(c), time) is recorded
```

### 6.6 失效模式

| 失效 | 机制 | 对应不变量 |
| --- | --- | --- |
| 凭据进入模型上下文 | 出站代理注入 | I-PRM-1 |
| 模型自认安全就放行 | 策略在模型之外 | I-PRM-2 / I-PRM-6 |
| 挡住调用导致 agent 卡住 | `block` 返回结果并继续 | I-PRM-3 |
| 等用户时 worker 闲置 | `defer` 结束 run | I-PRM-4 |
| 用户一直不答复 | 到期事件 | I-PRM-5 / D-PRM-2 |
| 同一调用被批准两次 | `call_id` 去重 | I-PRM-5 |
| 注入诱导越权 | 深检在 run 内 + 分类器 | I-PRM-2 |
| 越权不可追溯 | 审计记录 | I-PRM-7 |

### 6.7 待定决策

| 编号 | 决策 | 取值 | 影响 |
| --- | --- | --- | --- |
| D-PRM-1 | 工具的风险分级 | 按工具 / 按参数 / 按目标资源 | 分级太粗会频繁打断，太细难维护 |
| D-PRM-2 | 审批超时 | 分钟 / 小时 / 不超时 | 不超时会永久挂起 |
| D-PRM-3 | 延后请求的送达通道 | outbox / 自有界面 | outbox 复用投递与重试；自有界面更可控 |
| D-PRM-4 | 哪些决策必须留给人 | 原文只说 “the most important decisions” | 需要产品明确列举 |
| D-PRM-5 | 分类器误判的兜底 | 误放行要可回滚 / 误拦截要可重试 | 两类错误的代价不对称 |

## 7. Outbox

### 7.1 原文要点

大多数 agent 的回复边生成边流式发给用户，用户能看着它推理、调用工具、写答案。always-on agent 则大部分工作在后台完成，用户拿到的是结果和少量细节，而不是完整的逐步过程。

一次 run 有三种结束方式：

- agent 往 outbox 发一条消息；
- agent 判断不需要发任何东西；
- agent 用 deferred tool call 请求许可或更多输入。

多数 always-on agent 用一个直接把消息送给用户的 “send” 工具就够了。只有想控制发消息的节奏、或者让 agent 能从发送错误中恢复时，才需要正式的 outbox。

outbox 是一张出站消息表，和事件 inbox 对应；dispatcher（通常是后台服务）和 worker 对应：它读取待发消息，决定发什么，再送给用户。deferred tool call 的请求可以走 outbox，也可以直接显示在界面里。

除了送达，还要调好 agent 发消息的量：发太多会吵，发太少会漏掉用户需要知道的事。原文建议用 eval 找平衡点，并且：

> In practice, it’s better for the agent to start quiet and then earn more of the user’s attention over time.

### 7.2 结构

```spec
SORT MsgStatus ≜ pending | sending | sent | failed | cancelled
SORT MsgKind   ≜ message | approval_request

OutMsg ≜ {
  id         : MsgId,
  session    : SessionId,
  kind       : MsgKind,
  body       : Text,
  dedupe_key : Text,
  created_at : Time,
  status     : MsgStatus,
  attempts   : Nat
}
```

### 7.3 三种结束方式

`RunEnd` 已在 §1.2 定义；这里补的是互斥与穷尽。

```spec
INVARIANT I-OUT-1  (exactly one ending)
  ∀ r : r.end ∈ RunEnd ∧ (r.end = Sent(ms) ⇒ ms ≠ [])
```

三条路互斥且穷尽。`Silent` 是正常结束，不是异常：原文明确说“the agent decides that nothing needs to be sent”。把空回复当成错误来告警，会制造噪音。

### 7.4 投递

```spec
PARAM DeliveryMode ≜ direct_send | outbox
-- outbox is required iff pace(messages) ∨ recover_from_errors

FLOW F-OUTBOX [run, outbox, dispatcher, channel, user]
  1  run        --append(m)--> outbox            [status = pending, durable]
  2  dispatcher --read(pending)--> outbox
  3  dispatcher --deliver(m)--> channel
  4  dispatcher --mark(sent)--> outbox           [or failed, then retry with backoff]
```

```spec
RatePolicy ≜ {
  max_msgs     : Nat,
  window       : Duration,
  min_interval : Duration,
  quiet_period : Duration?
}
-- start quiet; earn the user's attention over time
```

### 7.5 不变量

```spec
INVARIANT I-OUT-2  (at most one visible delivery)
  ∀ m : |{ d ∈ delivered : d.dedupe_key = m.dedupe_key }| ≤ 1
  why   channel retries and dispatcher restarts must not repeat a message

POLICY P-OUT-3  (order per session, when enabled)
  REQUIRE  m1.created_at < m2.created_at ⇒ delivered(m1) ≺ delivered(m2)
  -- see D-OUT-3; parallel delivery relaxes this on purpose

INVARIANT I-OUT-4  (no silent loss)
  status(m) = failed ⇒ retry(m) ∨ visible-to-operator(m)

INVARIANT I-OUT-5  (one request per pending call)
  m.kind = approval_request ⇒ m.call ∈ dom(σ.deferred)
  ∀ m1, m2 : m1.kind = approval_request ∧ m2.kind = approval_request ∧ m1.call = m2.call ⇒ m1 = m2

POLICY P-OUT-6  (nothing repeated)
  before sending: check reported.md
  after sending:  update reported.md
  why   the user should not be told the same thing twice
```

### 7.6 失效模式

| 失效 | 机制 | 对应不变量 |
| --- | --- | --- |
| 消息过多，用户被淹没 | 节奏策略 + evals | 7.4 / D-OUT-2 |
| 该说的没说 | 覆盖率评测 | D-OUT-2 |
| 通道重试造成重复 | dedupe_key | I-OUT-2 |
| 消息乱序 | 每会话 FIFO | P-OUT-3 |
| 审批请求两条路都送达 | 一个 pending call 对应一条请求 | I-OUT-5 |
| 崩溃后消息停在 pending | outbox 持久 + dispatcher 重试 | I-OUT-4 |
| 反复告知同一件事 | `reported.md` | P-OUT-6 |
| 空 run 也推消息 | `Silent` 是合法终态 | I-OUT-1 |

### 7.7 待定决策

| 编号 | 决策 | 取值 | 影响 |
| --- | --- | --- | --- |
| D-OUT-1 | `direct_send` 还是 outbox | 原文：需要节奏或错误恢复才上 outbox | 直接发送少一层，但没有重试与限流 |
| D-OUT-2 | 发送节奏与评测 | 频率上限、安静时段、覆盖率与打扰率指标 | 过少漏报，过多变噪音 |
| D-OUT-3 | 是否严格按会话保序 | 严格 / 允许并行 | 严格实现简单，但会拖慢长消息 |
| D-OUT-4 | 是否合并多条为一条 | 合并 / 逐条 | 合并降低打扰，但会丢可操作性 |
| D-OUT-5 | 失败重试上限与告警 | `MAX_ATTEMPTS` + 运维可见 | 无限重试会放大故障 |

## 8. 组合

### 8.1 接线

```spec
WIRING
  timers    --(fires later)--> inbox
  inbox     --(starts or resumes)--> run
  run       --(reads, and writes what it learned)--> memory
  run       --(each tool call is checked)--> permissions
  run       --(sends, or says nothing)--> outbox
  outbox    --(delivers)--> user
  user      --(the answer, as an event)--> inbox
  run       --(sets a follow-up)--> timers
  run       --(appends)--> sessions
```

每次 run 都从 inbox 里的一个事件开始，可能是用户消息、webhook 或 timer。worker 取到事件后开始一次 run，在新的或已有的 session 里唤醒 agent。agent 读记忆建立基线，在权限范围内行动，再把学到的东西写回记忆。run 结束后，agent 往 outbox 写一行，dispatcher 把消息送给用户。

这些组件构成一个循环：run 可以设一个 timer 让 agent 之后再醒来；用户回复消息时，答复作为事件回到 inbox。

> Each run is brief, but the cycle keeps going indefinitely, and that’s what makes the agent feel like it’s always on.

### 8.2 工作循环

```spec
RULE WorkerLoop(i)
  REPEAT
    e     ← oldest pending in inbox i          -- always pull; never trust the wake signal
    batch ← { e' ∈ pending(i) : resume(e') = resume(e) }
    claim(batch)                              -- atomic; one active worker per inbox
    r ← Run(trigger = ids(batch), session = choose(batch))
    wait(r)                                   -- ends as Sent, Silent, or Deferred
    commit(memory, session, outbox, timers)
    complete(batch)                           -- pending → done
  UNTIL pending(i) = ∅
  sleep until woken
```

### 8.3 三条端到端路径

**用户消息。** 用户发消息 → handler 落盘并唤醒 → worker claim 批次 → 恢复该会话（或新建）→ 读 memory → 执行工具 → 写回 memory → 推送 outbox → dispatcher 投递 → run 结束 → 回到睡眠。

**主动追问。** run 在结束时设置一个 follow-up → scheduler 到点追加事件 → worker 按 8.2 恢复原会话 → 检查是否已有回复 → 有则结束（`Silent`），无则追问。

**授权。** run 命中高风险调用 → `defer`：会话存盘、run 结束、请求送达 → 用户答复作为事件回到 inbox → 新 run 恢复会话、带上答复继续。等待期间 worker 可以处理其他事件。

### 8.4 全局不变量

```spec
INVARIANT I-SYS-1  (single entry)
  ∀ r ∈ σ.runs : trigger(r) ⊆ dom(σ.inbox)

INVARIANT I-SYS-2  (mutual exclusion)
  as I-EVT-1

INVARIANT I-SYS-3  (no idle inference)
  σ ∈ Idle ⇒ no model call

INVARIANT I-SYS-4  (persist before sleep)
  phase(r) = ended ⇒ all writes of r are committed

INVARIANT I-SYS-5  (no duplicate delivery)
  as I-OUT-2

INVARIANT I-SYS-6  (information conservation)
  as I-CTX-2

INVARIANT I-SYS-7  (no dangling deferral)
  deferred(c) ⇒ ◇ (answered(c) ∨ expired(c))

INVARIANT I-SYS-8  (progress)
  as I-EVT-2
```

### 8.5 每个原语消除的失效

| 原语 | 消除的失效 | 机制 |
| --- | --- | --- |
| inbox | 竞争 run、事件丢失、重复投递 | 单 worker + 持久队列 + 去重 |
| timers | agent 无法主动、漏掉到期任务 | 独立存储 + 调度器 |
| memory | run 之间失忆、重复告知、任务重头再来 | 常驻集合 + 指针 + 进度文件 |
| permissions | 无人值守越权、凭据泄漏 | 代理 + 外置策略 + 延后调用 |
| outbox | 消息轰炸、崩溃后消息丢失 | 持久表 + dispatcher + 节奏 |

这五者不是可选优化。去掉任何一个，都会让上面那类失效重新出现：没有 inbox 就没有统一的唤醒入口，没有 outbox 就没有可恢复的送达，没有 memory 就退化成无状态 agent。

### 8.6 部署单元

| 单元 | 职责 | 写哪些持久存储 | 原文对应 |
| --- | --- | --- | --- |
| handler | 浅层校验、落盘、快速应答、唤醒 | inbox | “a handler, usually an HTTP endpoint” |
| worker | claim、按 session 组批、恢复会话、跑 run、标记完成 | inbox、sessions、memory、outbox | “a worker, usually a background service” |
| scheduler | 扫描到期、推进定时器、追加事件 | timers、inbox | “a scheduler, usually a background service” |
| dispatcher | 读 pending、按节奏投递、标记结果 | outbox | “a dispatcher, usually a background service” |
| agent runtime | run 内的 loop 与工具执行 | 无，状态全在存储里 | “the agent loop” |
| credential proxy | 出站时注入凭据 | 无 | “a proxy outside the agent's environment” |

其中常驻的只有持久存储。handler 需要一个可接收事件的入口；worker、scheduler、dispatcher 可以按需或按间隔运行；agent runtime 只在 run 期间存在。这也是“always-on”不必是常驻进程的原因。

## 9. 验收清单

每一项都可以用故障注入或事件重放来验证。通过不等于实现正确，但失败即不合规。

| 编号 | 断言 | 注入方式 | 观察点 | 依据 |
| --- | --- | --- | --- | --- |
| C1 | 同一 inbox 同时最多一个 run | 并发投递 5 个事件 | 活跃 run 计数 | I-EVT-1 |
| C2 | 崩溃后同一事件被重取 | run 中途杀掉 worker | 事件回到 pending，最终 done | I-EVT-2 / I-EVT-3 |
| C3 | 副作用不因重跑重复 | 同上，且工具有外部写 | 外部系统只出现一次 | I-EVT-3 |
| C4 | 重复投递被丢弃 | 同一 `dedupe_key` 投两次 | 第二条为 dropped，run 数不变 | I-EVT-4 |
| C5 | ack 时延有上界 | 下游变慢 | ack 时延低于阈值 | I-EVT-5 |
| C6 | 连续消息合并成一个 run | 连发 3 条 | 一次 run，一次回复 | I-EVT-6 |
| C7 | 同一 occurrence 只触发一次 | 调度器重复扫描或重启 | 事件数 | I-TMR-1 |
| C8 | follow-up 触发后终结 | 等到期 | 状态 done，不再触发 | I-TMR-3 |
| C9 | schedule 不漂移 | 多次到期 | `due` 按 recurrence 递推 | I-TMR-3 |
| C10 | 进程外状态可恢复 | 重启整个 worker | 指令、进度、已报告仍在 | 5.3 `Persist` |
| C11 | 压缩不丢唯一副本 | 触发压缩 | 被丢事实可从 memory 恢复 | I-CTX-2 |
| C12 | 恢复会话不重放旧调用 | 恢复长会话 | 旧工具调用未再执行 | I-CTX-4 |
| C13 | 凭据不出现在上下文 | 抓取上下文与出站请求 | 无 secret，代理侧注入 | I-PRM-1 |
| C14 | 未授权调用不执行 | 命中高风险工具 | block 或 defer | I-PRM-2 |
| C15 | 延后期间 worker 不闲置 | defer 后投递无关事件 | 无关事件被处理 | I-PRM-4 |
| C16 | 答复只生效一次 | 重复答复同一 call | 第二次被丢弃 | I-PRM-5 |
| C17 | 投递至多一次 | 通道超时后重试 | 用户只看到一次 | I-OUT-2 |
| C18 | 无事可做不推送 | 空 run | 无消息 | I-OUT-1 |
| C19 | 不重复告知 | 多次 run | 已报告内容不重发 | P-OUT-6 |
| C20 | 审批请求不重复 | defer 后两条通道都可用 | 只送达一次 | I-OUT-5 |

## 10. 常量与参数

实现必须为每一项选定取值并记录，否则同一份规范会产出行为不同的系统。各节给出完整编号，这里只列全局常量与影响最大的参数。

### 10.1 全局常量

| 常量 | 含义 | 取值建议 |
| --- | --- | --- |
| `ACK_MAX` | handler 从收到到应答的上限 | 秒级，取决于源的超时 |
| `LEASE` | 事件 claim 的租约 | 与 run 最大时长同阶 |
| `MAX_ATTEMPTS` | 事件与消息的重试上限 | 3–5 |
| `POLL_INTERVAL` | 调度器扫描间隔 | 1–60 秒 |
| `COMPACT_THRESHOLD` | 触发压缩的上下文占比 | 70–80% |
| `B_RESIDENT` / `B_FIXED` | 常驻记忆与固定上下文的预算 | 按模型窗口分配 |

### 10.2 决策参数

| 编号 | 参数 | 取值 | 推荐起点 |
| --- | --- | --- | --- |
| D-EVT-1 | run 中的新事件 | next_run / fold / interrupt | next_run |
| D-EVT-2 | inbox 粒度 | 每用户 / 每会话 / 每租户 | 每用户；并发不够再按会话拆，并维持 session 亲和 |
| D-EVT-3 | 批处理窗口 | 0 / 固定 debounce | 短窗口（1–3 秒） |
| D-EVT-4 | 重试与死信 | N / 无 | 3–5 次后进死信 |
| D-TMR-1 | 错过 occurrence | 全补 / 最近 / 跳过 | 通知类取“最近”，幂等任务取“全补” |
| D-TMR-3 | 调度器 | 自建 / 引擎 | 先自建；多实例再换引擎或加租约 |
| D-MEM-1 | 记忆形态 | 三文件 + 两目录 / 单文件 | 三文件 + 两目录 |
| D-MEM-2 | 压缩阈值 | 50–90% | 75% |
| D-MEM-3 | 新会话带最近 k 条 | 0 / k | 5–10 条 |
| D-PRM-2 | 审批超时 | 分钟 / 小时 / 无 | 24 小时 + 到期事件 |
| D-PRM-4 | 必须留人的决策 | 列表 | 先从“不可逆 + 涉及外部资金或数据”开始 |
| D-OUT-1 | 投递方式 | direct_send / outbox | 需要节奏或重试时用 outbox |
| D-OUT-2 | 发送节奏 | 频率上限 + 安静时段 | 从最安静开始，按评测放宽 |

## 附录 A 形式记号

这是规约语言，不是可执行代码。实现的义务是精化它：凡规范允许的迁移，实现可以选择不做；凡规范禁止的，实现不得产生。状态始终是记录的集合，每次更新视为复制后替换。

### A.1 构造

| 构造 | 用途 | 语义 |
| --- | --- | --- |
| `SORT` | 定义类型、枚举、标签联合 | `A \| B` 为二选一 |
| `Type ≜ { f : T, ... }` | 记录 | 字段无序，按字段比较相等 |
| `UNIQUE k over S` | 唯一约束 | `S` 内任意两条记录在 `k` 上不同 |
| `REQUIRE` | 必须成立的条件 | 违反即实现不合规 |
| `PREMISE` | 环境前提 | 前提不成立时规范不保证结论 |
| `PERSISTENT` / `VOLATILE` | 存储的崩溃语义 | 前者必须活过进程崩溃 |
| `STATE` | 状态机 | 形如 `label : from → to`，迁移自身原子；`—` 表示创建，无前驱 |
| `RULE name(β)` | 带前置条件的原子迁移 | `PRE` 成立才可执行；`DO` 一次生效；`POST` 为结果 |
| `POLICY name` | 无法机械校验、只能靠评审维持的约束 | 违反即设计缺陷，测试发现不了 |
| `ATOMIC { ... }` | 多步必须一起提交 | 中间状态不可被观察，崩溃不可停在中间 |
| `FLOW name [A, B, ...]` | 交互协议 | 行内 `--msg-->` 为消息；`after n` 为 happens-before，未标注者无序 |
| `[durable]` / `[volatile]` | 消息的持久性标注 | 后者允许丢失，需要轮询兜底 |
| `INVARIANT id` | 全局断言 | 所有可达状态上恒真；`why` 记录它防止的失效 |
| `WIRING` | 原语之间的数据流 | 节点是原语，边标注流动的东西 |
| `PARAM` / `D-*` | 实现必须赋值的参数 | 不同取值即不同系统 |

### A.2 符号

| 符号 | 含义 |
| --- | --- |
| `≜` | 定义 |
| `⇀` | 部分映射（键可缺省） |
| `⊕` | 拼接（序列或文本） |
| `[τ]` | 序列 |
| `{τ}` | 集合 |
| `τ?` | 可选值，可写作 `⊥` |
| `size(x)` | `x` 的 token 数（上下文预算的单位） |
| `content(F)` | 文件集合 `F` 的内容按装载顺序拼接 |
| `isPointer(f)` | `f` 是指向外部系统的引用，而不是内容副本 |
| `◇` | 最终成立 |
| `≺` | 先于（happens-before） |
| `⊆` | 子集 |

### A.3 假设

规范的有效性依赖以下前提，它们不能从代码里验证，只能声明：

- **崩溃模型**：任一进程可能在任何时刻停机（crash-stop），不假设磁盘损坏、不假设拜占庭行为。
- **持久性**：`PERSISTENT` 中的写入提交后，进程崩溃不会丢失。提交与可见性的边界由实现自行保证，但必须在 §9 的 C2 中可观察。
- **投递语义**：事件源是 at-least-once，重复与乱序都可能；去重由 `(source, dedupe_key)` 承担。
- **并发**：不同 inbox 的 run 可并发；同一 inbox 内由 worker 串行化。`RULE`/`STATE` 的原子性只在单点执行的前提下成立，跨点的互斥必须由租约或条件更新补足。
- **时间**：判定是否到期用墙钟，测量时长用单调钟；时钟回拨时以 occurrence 的幂等性兜底。
- **模型**：agent loop 视为黑盒，每次调用返回三类结束之一，并可能执行已获准的工具调用。模型行为本身不在规范范围内。
- **范围外**：多租户隔离、模型选型、提示词内容、注入检测算法、UI 设计。

## 附录 B 与原图的对应

7 张插图已全部替换为形式化模型。下表用于核对替换是否完整，也保留原始出处。

| # | 原图内容 | 原文位置 | 替换为 |
| --- | --- | --- | --- |
| 1 | 时间轴：睡眠不消耗 token，短暂 run 四步走并写回状态 | The cycle | §1.2 `Phase` / `Wake` / `Finish` |
| 2 | inbox：handler 写入、去重、唤醒 worker，worker 读、跑、标记完成 | Event inbox | §3.2–§3.5、§8.2 |
| 3 | timers：run 设置 follow-up 或 schedule，调度器找到到期项并追加事件 | Timers | §4.2–§4.4 |
| 4 | memory：三个常驻文件与两个按需目录，run 启动时装载、运行中写入 | Memory | §5.2、§5.3 |
| 5 | 上下文用量：固定开销在每次 run 都占一段，既有会话带回整份 transcript，压缩后回落 | Inside the context window | §5.5 |
| 6 | outbox：run 以发送、静默或延后结束，dispatcher 投递，延后请求走 outbox 或自有界面 | Outbox | §7.2–§7.5 |
| 7 | 组合：五个原语与用户的循环 | How everything fits together | §8.1、§8.3 |

原图地址（第 1、5、7 张为动图）：

```text
1  https://assets.claude.com/5dc803bf06d6e92e4aecae762da096626e2fa9ec.gif
2  https://assets.claude.com/bb08543a505cea3a24c88c718ceec4405e9c0a79.png
3  https://assets.claude.com/c16694e6d979a2ace84d03da0544297b7245c0a8.png
4  https://assets.claude.com/e5d209d7ef9b3455dec8a27b777dc12bdf806699.png
5  https://assets.claude.com/48757f0a147acfe841c943674c6214d34ed4405a.gif
6  https://assets.claude.com/700b5f3a446f22493c0307ec65751b6b2f82ccb7.png
7  https://assets.claude.com/9f8df7b2dcc9d4637d27f37dae6e40a2a5851c8a.gif
```

原文由 William Hu 撰写，Rodrigo Olivares 与 Michael Segner 亦有贡献。
