# aoa 设计文档

- 状态：已实现。本地模式在一次性仓库上用真实模型（DeepSeek flash）冒烟跑通过一次；GitHub 模式只在假 GitHub 和脚本模型上跑过，还没接过真实的 GitHub App
- 日期：2026-11-16
- 规范：[spec.md](spec.md)（下文的 §、I-*、C*、D-* 编号都指它）
- 决策记录：<（链接已删除）>

## 1. 要做什么

aoa 是按规范从头写的 always-on agent 内核，第一件事是写代码：一条 `aoa send` 进来，agent 在自己的 worktree 里改，提交到本地分支，只在需要你的时候找你。

默认是本地模式，不需要 GitHub：消息写到本地文件并发桌面通知，分支由你自己合并。配置里加上 `github` 一节才接 GitHub（带标签的 issue 进、评论出、推送并开 PR）。两种模式的差别都在 §8。

它要回答一个问题：只保留规范里的五个原语，不加任何外围，能不能提高生产力。所以第一版刻意精简，并且从第一天起记录能回答这个问题的数（§10）。

和 早先的项目 的关系：独立新写，不抽取 早先的项目 的 Inbox。早先的项目 那层绑在 pi-durable 文档和「项目 / 任务 / worktree」模型上；它在 ADR-0051、ADR-0052 里记下的实现教训直接沿用，下文标「沿用 早先的项目」的都是。

### 不做

界面、收件对话、插件系统、推送服务、沙箱、多用户、公网 webhook 入口、记忆的定期整理。这些在 早先的项目 里已经有，再做一遍只会让「结构本身有没有用」的结论变浑。

## 2. 用法

```ts
// ~/.aoa/aoa.config.ts
export default {
  dataDir: "~/.aoa",
  repo: { path: "~/code/some-repo", base: "main" },
  model: { provider: "anthropic", modelId: "...", apiKeyEnv: "ANTHROPIC_API_KEY" },
  classifier: { provider: "anthropic", modelId: "...", apiKeyEnv: "ANTHROPIC_API_KEY" },
  // github: { owner, repo, userLogin, botLogin, appId, installationId, privateKeyPath },  // 可选
};
```

```bash
aoa serve                               # 唯一的常驻进程：worker、scheduler、dispatcher
aoa send "修掉 ..."                     # 开出一项任务
aoa send --to <thread> "再改一下 ..."   # 给已有任务追加消息；任务在等回答时，这段文字就是回答
aoa answer <id> approve|deny [理由]     # 回答一个延后的调用
aoa close <thread> merged|discarded     # 本地模式：告诉它这项任务的分支最后怎样了
aoa messages --since <id> --wait 600    # agent 说了什么；给聊天里的 agent 当回程用
aoa status                              # 各任务的结局、被问次数、时长
```

本地模式下消息在 `<dataDir>/messages.md`。接了 GitHub 时，提问和审批也可以直接在 issue 或 PR 的评论里回答。

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
| `packages/kernel` | 类型、worker 循环、scheduler、dispatcher、策略裁决 |
| `packages/store-sqlite` | 表结构和事务，`bun:sqlite` |
| `packages/runtime-pi` | agent loop 适配器（`@earendil-works/pi-coding-agent`） |
| `packages/channel-local` | 本地通道：消息写文件，发桌面通知 |
| `packages/channel-github` | 可选。轮询 issue 和评论，开 PR，发评论 |
| `packages/conformance` | C1–C20，带故障注入点的假 runtime 和假时钟 |
| `apps/aoa` | CLI、`serve`、worktree 管理 |

写代码用的工具（bash、read、edit、write 等）也是内核里登记的工具：`runtime-pi` 把 pi 自带的实现包成内核工具，pi 自己不直接执行任何工具。所以每一次调用都经过裁决和日志，没有第二条路。

runtime 只返回 `silent` 或 `deferred`；这次 run 往 outbox 里写过消息时，内核把结局记成 `sent`。

「任务」不是内核概念。内核只有 session；`apps/aoa` 在新 session 开始时建一个 worktree，于是一项任务就是一个 session 加一个 worktree。

## 4. 数据

五个存储加辅助表都在同一个 SQLite 文件里，所以「追加事件 + 推进定时器」这类 ATOMIC 就是一个事务。

| 表 | 对应 | 关键列 |
| --- | --- | --- |
| `events` | §3.2 `Event` | `(source, dedupe_key)` 唯一，`status`，`lease_until`，`attempts`，`thread`，`resume`，`trusted` |
| `timers` | §4.2 `Timer` | `kind`，`due`，`recurrence`，`status` |
| `sessions` | §1.2 `Session` | `status`，`pending`，`runtime_ref`，`workdir` |
| `outbox` | §7.2 `OutMsg` | `dedupe_key` 唯一，`status`，`attempts` |
| `deferred` | §6.2 `PendingCall` | `call_id` 主键，`expires_at` |
| `threads` | 无 | `thread_key → session_id` |
| `tool_journal` | I-EVT-3 | `(session_id, call_id)` 主键，`state`，`result` |
| `decisions` | I-PRM-7 | `call_id`，`decision`，`basis`，`at` |
| `runs` | 无 | `session_id`，`end`，`started_at`，`ended_at` |

记忆是磁盘上的目录，不进数据库（§7）。

### 事件怎么回到原任务

沿用 早先的项目：事件带 `thread`（例如 `github:owner/repo#12`），`threads` 表把它映射到 session。开出任务的事件自带的 thread 在建 session 时登记；之后才出现的（agent 开的 PR）由 agent 调 `follow` 工具登记。对得上就设 `resume`，对不上就开新 session。这个判断只读数据库，不读 worker 内存（§3.2）。

组批的键是 `resume`；没有 `resume` 的事件按 `thread` 分组，两者都没有的才共用一个新 session。规范的 I-EVT-6 让所有首次出现的事件共用一个新 session，这里收紧了：两个不同的 issue 不该进同一项任务。一次 run 仍然只在一个 session 里。

事件状态比规范多一个 `dead`：重试超过 `MAX_ATTEMPTS` 的事件停在这里，不再被取走，在 `aoa status` 里可见。

## 5. 流程

### worker

照 §8.2。每个 inbox 一个 worker，每次醒来都重新从 `events` 拉取，不信唤醒信号里带的内容。互斥由数据库保证，不靠进程里的锁：claim 是一个事务，只有这个 inbox 没有未过期的租约时才成功。run 的结局、session 的更新和事件标 `done` 在同一个事务里提交。

每个提交点都有名字：`after_append`、`after_claim`、`after_tool_exec`、`after_tool_result`、`before_complete`。一致性测试靠这些名字在指定位置杀进程。

一项任务停在延后调用上时，session 标 `paused`，run 结束，worker 接着取下一项（I-PRM-4）。每项任务有自己的 worktree，互不干扰。

### 重跑时副作用不重复

规范写的是按 `(run_id, call_id)` 幂等。重跑会得到新的 run，所以这里改用 `(session_id, call_id)`，分两层：

1. transcript 只追加，每次工具调用后落盘。重跑的 run 恢复 session，已有结果的调用不会再执行（I-CTX-4）。
2. 剩下的缺口是「工具执行了，结果还没落盘就崩了」。工具执行前先在 `tool_journal` 记下意图；恢复时遇到有意图、没结果的调用，不重跑，把「结果未知，先查再决定」作为工具结果交回 loop。自带幂等键的工具（开 PR 以分支名为键）可以声明自己能安全重跑。

### scheduler

照 §4.3。第一版的周期只有固定间隔（`{ everyMs, anchor }`），下一次总是从 anchor 算，不累加，所以不会漂；没有 cron。按最早的 `due` 定闹钟，最长一分钟复查一次。到点时在同一个事务里写事件、把 follow-up 标完成、把 schedule 推到下一次。事件的 `dedupe_key` 是 `(timer_id, occurrence)`。停机期间错过的只补最近一次。

### dispatcher

读 `outbox` 里 pending 的消息，按节奏交给 `Channel.deliver`，失败按 1、2、4、8 分钟退避，超过上限的留在表里并在 `aoa status` 里显示（I-OUT-4）。节奏规则是纯函数，方便测试（沿用 早先的项目）。

### 事件源

GitHub 靠轮询，不开 webhook 入口。游标和事件在同一个事务里存下，崩溃只会重复一次轮询，重复的事件被 `dedupe_key` 去掉（沿用 早先的项目）。

## 6. 权限

裁决在模型之外，顺序是规则表、分类器、延后：

1. 规则表：只读工具和只读命令放行；`sudo`、强推、改 git 配置或远端、`curl | sh` 直接拦。
2. 规则判不了的交给分类器（一个小模型）。事件带 `trusted` 标记：issue 正文、PR 评论算外部内容，这次运行里判得更严。
3. `high` 风险和分类器拿不准的一律延后，等你回答。未知工具默认延后。

谁的话算数按作者判断，不按内容判断：只有配置里那个 GitHub 登录名发的评论才算 `approval_answer`，才算你的指令；其他人的评论和 issue 正文一律是外部内容（`trusted = false`），不能批准任何调用（I-PRM-2）。

每次裁决连同依据写进 `decisions`。

凭据（GitHub 模式；本地模式下宿主手里只有模型的 key）：`git_push`、`github_open_pr`、`github_comment` 是宿主进程里的工具，由宿主加上凭据再发请求，agent 的上下文和调用参数里不出现凭据（I-PRM-1）。不做沙箱。agent 的 shell 和宿主是同一个系统用户，所以读凭据路径和 `~/.aoa` 的调用不会被规则直接放行。这是已知并接受的风险，和 早先的项目 ADR-0052 §7 撤回后的状态一致。

延后调用照 §6.4：session 存盘，run 结束，请求进 outbox，答复作为 `approval_answer` 事件回到 inbox，同一个 `call_id` 的第二次答复被去重丢掉。24 小时没答复就写一个到期事件。

三处规范没写、这里定下的：

- 怎么回答。session 停在延后调用上时，你在它的 thread 上发的下一条评论就是答复：`/approve` 是批准，`/deny 理由` 是拒绝；其他内容对提问来说是答案，对审批来说算拒绝并把内容当作你的意见交给 agent。通道不解析，它只按作者标出这是你的话；改写成 `approval_answer` 在内核收事件时做。
- 批准之后谁执行。内核在新 run 开始前自己执行被批准的那次调用（照常记日志），把结果连同答复一起交给 runtime；runtime 只告诉模型结果，不让模型再调一次。这样不用改写 transcript 里停在半路的那次调用。
- 失败的 run 立刻重试，不退避，三次后事件进 `dead`。

## 7. 记忆

每个仓库一个目录，在 `~/.aoa/memory/<repo>/`，不进仓库。

| 路径 | 内容 | 谁写 | 何时加载 |
| --- | --- | --- | --- |
| `instructions.md` | 你对 agent 的指令 | 你 | 每次运行 |
| `index.md` | `notes/` 和 `progress/` 的索引 | agent | 每次运行 |
| `notes/` | 关于你和项目的东西 | agent | 需要时 |
| `progress/<session>.md` | 本任务做了什么、还剩什么 | agent | 本任务的运行 |

只存查不到的东西；issue、PR、提交只存指针。

两处和规范的写法不同，都沿用 早先的项目：

- 「已告知过的内容」不由 agent 维护 `reported.md`，由宿主从 outbox 取最近几条放进上下文。
- 指令和索引放在每批事件的消息开头，不放系统提示。放进系统提示的话，索引一变整条对话的缓存就失效。

压缩和开新会话之前，先让 agent 把进度写进 `progress/`（I-CTX-2）。

## 8. 发件

第一版只在三种时候发消息：活干完了、需要你回答、任务失败。其余安静结束。

模式由配置决定，装配时只判断一次：有 `github` 一节是 GitHub 模式，没有就是本地模式。

### 本地模式（默认）

- 消息追加到 `<dataDir>/messages.md`，每条带一个隐藏标记，重复投递不会写第二遍。审批请求里带着回答它要敲的 `aoa answer` 命令。
- 写完文件后发一条 macOS 通知。通知是尽力而为：发不出来只记日志，以文件为准；别的系统上不发。消息正文作为参数交给 `osascript`，不拼进脚本。
- agent 只提交到 worktree 里的本地分支 `aoa/<session id 前 8 位>`，不推送、不开 PR，没有 `git_push`、`github_*`、`follow` 这些工具。worktree 从本地的 base 分支切出，不 fetch，仓库没有 remote 也能用。
- `bash` 里出现 `git push` 的调用一律延后给你。这只是约定：agent 的 shell 和你是同一个用户，用得了你的 SSH key（§6）。
- 分支怎么收场由你用 `aoa close` 声明。它只把结果记进库里；关 session 和删 worktree 由 `serve` 在下一次 5 秒巡检时做，分支永远不删。不自动探测「分支是否合进了 base」，因为 squash 合并探测不到，丢弃的任务也本来就需要一条命令来关。

### GitHub 模式

agent 用独立的 GitHub 身份，一个 GitHub App。它发的评论和开的 PR 会通知到你；轮询按作者分清三种评论：App 发的是 agent 自己的，配置里那个登录名发的是你的，其余是外部内容。宿主用 App 的私钥换短期的 installation token，私钥和 token 都不进 agent 的环境（§6）。

消息是 issue 或 PR 上的一条评论，靠 GitHub 自己的通知送到你手上。经 `aoa send` 开出的任务没有 issue，宿主先用 App 建一个，之后的消息和提问都挂在它上面。PR 合并或关闭就是任务的结局。

## 9. 参数

| 编号 | 取值 |
| --- | --- |
| `ACK_MAX` | 1 秒；没有 HTTP handler，C5 对着 `aoa send` 的追加路径测 |
| `LEASE` | 5 分钟，run 活着时每分钟续租；worker 死了租约才会过期 |
| `MAX_ATTEMPTS` | 3，之后进死信 |
| `POLL_INTERVAL` | 定时器最长 60 秒；GitHub 60 秒 |
| `COMPACT_THRESHOLD` | 75% |
| D-EVT-1 | `next_run` |
| D-EVT-2 | 每个仓库一个 inbox |
| D-EVT-3 | 2 秒 debounce |
| D-TMR-1 | 只补最近一次 |
| D-TMR-3 | 自建轮询，单实例 |
| D-MEM-3 | 新 session 不带旧消息 |
| D-PRM-2 | 24 小时，到期写事件 |
| D-OUT-1 | outbox |
| D-OUT-3 | 每个 session 内保序 |

## 10. 怎么判断有没有用

自用两周，每项任务记三样，全部从已有的表推出，不另外埋点：

- 结局：合并、返工（交付之后又来了用户事件才合并）、丢弃。本地模式下「交付」是第一条送达的消息，合并或丢弃由 `aoa close` 声明；GitHub 模式下「交付」是 PR 开出，结局看 PR 的状态，没开出 PR 就关掉的算丢弃。
- 被问次数：`decisions` 里这个 session 裁决为 `defer` 的条数（`deferred` 表只留到答复或过期，不能数它）。
- 时长：第一个事件的 `received_at` 到交付。

`aoa status` 直接出这张表，拿去和同期 早先的项目 Inbox 的任务比。

## 11. 测试

规范 §9 的验收项和它们的测试在哪：

| 验收项 | 测试在哪 | 说明 |
| --- | --- | --- |
| C1–C10、C14–C20 | `packages/conformance` | 真内核、真 SQLite，假 runtime 和假时钟，在命名的提交点崩溃 |
| C11 | 没有 | 压缩由 pi 自己做，内核看不到；靠常驻上下文里要求 agent 随时更新 `progress/` |
| C12 | `packages/runtime-pi` | 恢复 transcript 后不重跑旧调用 |
| C13 | `apps/aoa` 的端到端测试 | 扫描模型收到的每个请求、每张表的每一行、数据目录下的每个文件、日志 |

C13 不保证「shell 读不到凭据」（§6）。模型的 API key 在 `serve` 读入后会从环境变量里删掉，所以 agent 的 shell 继承不到它；GitHub App 的私钥文件和 `~/.aoa` 仍然靠规则把关。C19 检查宿主放进上下文的最近消息，不检查 `reported.md`（§7）。

端到端测试经过和 `serve` 同一个装配函数，两种模式各一套，都用脚本模型和真 git。本地模式：没有 remote 的仓库，`send` 到分支上的提交、消息文件和通知、`aoa answer`、`send --to`、`close` 之后的收尾。GitHub 模式：内存里的假 GitHub 加本地裸仓库，issue 进到 PR 出、经评论审批、外部内容标记、PR 关闭后收尾。

标为 `POLICY` 的条目（`PointerNotCopy`、I-CTX-2）没法机械验证，测试通过不等于符合规范。

## 12. 实现中定下的

写代码时定的、前面各节没写到的：

- 去重键按 inbox 算：`(inbox_id, source, dedupe_key)`。
- 被当成答复的评论，它原本的去重键另记在 `consumed_keys` 里，重复投递不会再变成新消息或回答下一个问题。
- call id 交给内核前加上 session id 前缀；同一 session 里 provider 给出空的或重复的 id 时，适配器按出现次数区分。
- 通道给事件的 payload 带 `text` 字段，内核只从它读答复的内容。
- 每个 session 一个 transcript 目录。run 失败后重试时接着已有的 transcript 写，并提醒模型上一次被打断过、先查现状再重复操作。
- 常驻上下文里进度那一段总是出现，文件还没写时显示「还没写」；否则 agent 不知道自己的 session id。
- 一个 session 同时只能有一个待答的调用；这次 run 里之后的调用也返回延后，但不再发请求。
- 事件重试到上限进 `dead` 时，同一个事务里给这项任务写一条失败通知（§8 的第三种消息）。
- `serve` 必须配分类器。`bash` 是中风险，没有分类器时，只读白名单之外的每条命令都会停下来等你，写代码的循环转不起来。
- 文件工具的路径落在任务的 worktree 之外时延后。
- GitHub 模式：PR 的状态存在 `pull_states` 表里，由存储层直接提供，内核不知道 PR。`serve` 每 5 分钟查一次；PR 合并或关闭后关掉 session、删掉 worktree。之后再来事件会重开 session，在原分支上重建 worktree。
- `aoa status --refresh` 只更新 PR 状态，不关 session；本地模式下它什么都不做。
- 本地模式声明的结局存在 `declared_results` 表里，一次声明只生效一次：`serve` 关掉 session 后，之后用 `send --to` 重开的 session 不会被同一条声明再关掉。
- session 在等回答时，它的 thread 上来的用户消息就是回答：`/approve` 批准，`/deny 理由` 拒绝，别的文字对审批算拒绝并当作理由，对提问算答案。`aoa send --to` 和 GitHub 评论走的是同一条路。
- 没有主会话。入口只是往 inbox 追加事件，谁来追加都行；聊天里的 agent 用 `aoa send` 派活、`aoa messages --since <游标> --wait <秒>` 读回程、`aoa answer` 回答。`messages` 直接读 outbox，游标是最后一条消息的 id，不依赖通道把消息送到了哪里。
- `aoa` 用 `bun link` 装成全局命令。配置依次找 `--config`、当前目录的 `aoa.config.ts`、`~/.aoa/aoa.config.ts`，所以在任何项目的聊天里都能调用。配置文件默认导出一个普通对象，不需要 import，可以放在仓库之外。
- 调用一旦被回答，outbox 里还没送出的那条审批请求就撤回，不会再问一遍。
- 审批是留给人的。聊天里的 agent 当入口时只转述请求，得到用户明确同意才运行 `aoa answer`；这是约定，内核分不清敲命令的是人还是 agent。
- 本地模式的 `git push` 规则排在内核规则之后，所以强推之类仍然是直接拦掉，不会变成可以批准。
- GitHub 模式下 `serve` 自己每 60 秒驱动一次轮询并记下错误，网络出错不会让轮询停掉。两种模式都每 5 秒叫醒一次 worker 和 dispatcher，因为 `aoa send` 和 `aoa answer` 是别的进程。

## 13. 没验证的

下面这些只能接上真实服务才知道，现在都只是按文档写的：

- GitHub App 的 JWT 和 installation token 交换，经 HTTPS 带 token 的 `git push`。
- GitHub 接口的细节：`since` 的语义、按创建时间排序、带标签的 PR 是否出现在 issues 列表里、`head=owner:branch` 过滤、经 issues 接口给 PR 加标签、真实的分页和限流。
- 真实模型会不会照系统提示的流程走；分类器会不会只回答一个词。本地模式下用 DeepSeek flash 试过一次（2026-11-16）：派活到提交 19 秒，返工、越界读文件的审批、`close` 后收尾都按设计走，被要求推送时它拒绝了，macOS 通知也弹出来了；只有这一个模型、一项任务，别的模型没试过。
- 宿主时钟要和 GitHub 相差一分钟以内，否则换 token 会失败。

已知的局限：

- 失败的 run 立刻重试，不退避。pi 自己会在一次 run 里对限流、过载和网络错误重试 3 次（2 秒起，翻倍），所以一次限流不会直接耗掉一次尝试；分类器没有重试，出错时那次调用会交给你。
- 同一批里有一个调用被延后时，同批的其他调用照常执行。
- agent 的工作目录里的 `pre-push` 钩子或 `url.insteadOf` 规则能看到或改走推送用的凭据；和 §6 接受的同用户风险是一回事。
- 给 issue 打标签之前的评论不会进来，只有 issue 本身会。
- 本地模式的 inbox 是 `local/<仓库目录名>`：同一个 `dataDir` 下两个目录名相同的仓库会共用 inbox、记忆和 worktree 目录。
- 审批请求正在投递时被回答、而那次投递又失败了，它会回到待发并在之后送出：撤回只改待发和发送中的行，投递失败的更新不看当前状态。
- macOS 通知最多等 5 秒，超时算发送失败，只记日志。

还要你来做的：给出模型的 key 和分类器配置，定下跑在哪台机器上，然后才是在真实仓库上跑通和两周自用。要接 GitHub 时再建 App 并装到目标仓库。

## 14. 暂缓

- 记忆的定期整理和历史版本（D-MEM-5）。
- 消息量评测。
- 多用户和 inbox 拆分。
- 第二个 runtime 适配器（Claude Agent SDK）。
- 早先的项目 要不要迁到 aoa 上。
- 公开仓库：公开前要把 `spec.md` 里逐字引用的原文改成转述加链接。原文已经进了 git 历史，所以还要重写历史或换一个新仓库。
