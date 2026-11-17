# aoa 设计文档

- 状态：已实现。本地模式在一次性仓库上用真实模型（DeepSeek flash）冒烟跑通过一次；GitHub 模式只在假 GitHub 和脚本模型上跑过，还没接过真实的 GitHub App
- 日期：2026-11-16
- 规范：[spec.md](spec.md)（下文的 §、I-*、C*、D-* 编号都指它）

## 1. 要做什么

aoa 是按规范从头写的 always-on agent 内核，第一件事是写代码：一条 `aoa send` 进来，agent 在自己的 worktree 里改，提交到本地分支，只在需要你的时候找你。

默认是本地模式，不需要 GitHub：消息写到本地文件并发桌面通知，分支由你自己合并。配置里加上 `github` 一节才接 GitHub（带标签的 issue 进、评论出、推送并开 PR）。两种模式的差别都在 §8。

它要回答一个问题：只保留规范里的五个原语，不加任何外围，能不能提高生产力。所以第一版刻意精简，并且从第一天起记录能回答这个问题的数（§10）。

### 不做

界面、收件对话、插件系统、推送服务、沙箱、多用户、公网 webhook 入口、记忆的定期整理。加进来只会让「结构本身有没有用」的结论变浑。

## 2. 用法

```ts
// ~/.aoa/aoa.config.ts
export default {
  dataDir: "~/.aoa",
  repo: { path: "~/code/some-repo", base: "main" },
  model: { provider: "deepseek", modelId: "deepseek-v4-pro", apiKeyEnv: "DEEPSEEK_API_KEY" },
  classifier: { provider: "deepseek", modelId: "deepseek-flash", apiKeyEnv: "DEEPSEEK_API_KEY" },
  // shadowJudge: { provider: "typesafe", modelId: "jev-1.14.0", apiKeyEnv: "TYPESAFE_API_KEY" },  // 可选
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
aoa web                                 # 只读的实时观察页，http://127.0.0.1:7878
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
| `packages/runtimes/pi` | agent loop 适配器（`@earendil-works/pi-coding-agent`） |
| `packages/runtimes/codex` | Codex app-server 适配器：Codex 用自己的工具，aoa 转达它的询问（§12） |
| `packages/runtimes/dsh` | DeepSeek Harness（dsh）SDK 适配器：dsh 用自己的工具，aoa 的工具走 MCP 桥（§12） |
| `packages/channels/local` | 本地通道：消息写文件，发桌面通知 |
| `packages/channels/github` | 可选。轮询 issue 和评论，开 PR，发评论 |
| `packages/conformance` | C1–C20，带故障注入点的假 runtime 和假时钟 |
| `apps/aoa` | CLI、`serve`、worktree 管理 |

写代码用的工具（bash、read、edit、write 等）也是内核里登记的工具：`runtime-pi` 把 pi 自带的实现包成内核工具，pi 自己不直接执行任何工具。所以每一次调用都经过裁决和日志，没有第二条路。

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

## 6. 权限

裁决在模型之外，顺序是规则表、分类器、延后：

1. 规则表：只读工具和只读命令放行；`sudo`、强推、改 git 配置或远端、`curl | sh` 直接拦。
2. 规则判不了的交给分类器（一个小模型）。事件带 `trusted` 标记：issue 正文、PR 评论算外部内容，这次运行里判得更严。分类器这一步现在由审核模型担任，见 §12「审核模型」。
3. `high` 风险和分类器拿不准的一律延后，等你回答。未知工具默认延后。

谁的话算数按作者判断，不按内容判断：只有配置里那个 GitHub 登录名发的评论才算 `approval_answer`，才算你的指令；其他人的评论和 issue 正文一律是外部内容（`trusted = false`），不能批准任何调用（I-PRM-2）。

每次裁决连同依据写进 `decisions`。

凭据（GitHub 模式；本地模式下宿主手里只有模型的 key）：`git_push`、`github_open_pr`、`github_comment` 是宿主进程里的工具，由宿主加上凭据再发请求，agent 的上下文和调用参数里不出现凭据（I-PRM-1）。不做沙箱。agent 的 shell 和宿主是同一个系统用户，所以读凭据路径和 `~/.aoa` 的调用不会被规则直接放行。这是已知并接受的风险。

延后调用照 §6.4：session 存盘，run 结束，请求进 outbox，答复作为 `approval_answer` 事件回到 inbox，同一个 `call_id` 的第二次答复被去重丢掉。24 小时没答复就写一个到期事件。

三处规范没写、这里定下的：

- 怎么回答。session 停在延后调用上时，你在它的 thread 上发的下一条评论就是答复：`/approve` 是批准，`/deny 理由` 是拒绝；其他内容对提问来说是答案，对审批来说算拒绝并把内容当作你的意见交给 agent。通道不解析，它只按作者标出这是你的话；改写成 `approval_answer` 在内核收事件时做。
- 批准之后谁执行。内核在新 run 开始前自己执行被批准的那次调用（照常记日志），把结果连同答复一起交给 runtime；runtime 只告诉模型结果，不让模型再调一次。这样不用改写 transcript 里停在半路的那次调用。
- 失败的 run 按 §9 的延迟重试，三次后事件进 `dead`。

## 7. 记忆

每个仓库一个目录，在 `~/.aoa/memory/<repo>/`，不进仓库。

| 路径 | 内容 | 谁写 | 何时加载 |
| --- | --- | --- | --- |
| `instructions.md` | 你对 agent 的指令 | 你 | 每次运行 |
| `index.md` | `notes/` 和 `progress/` 的索引 | agent | 每次运行 |
| `notes/` | 关于你和项目的东西 | agent | 需要时 |
| `progress/<session>.md` | 本任务做了什么、还剩什么 | agent | 本任务的运行 |

只存查不到的东西；issue、PR、提交只存指针。

两处和规范的写法不同：

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
| `RETRY_DELAYS_MS` | 30 秒、2 分钟：第一次和第二次失败后事件要等多久才能再被取走；第三次失败进死信 |
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

`aoa status` 直接出这张表。

## 11. 测试

规范 §9 的验收项和它们的测试在哪：

| 验收项 | 测试在哪 | 说明 |
| --- | --- | --- |
| C1–C10、C14–C20 | `packages/conformance` | 真内核、真 SQLite，假 runtime 和假时钟，在命名的提交点崩溃 |
| C11 | 没有 | 压缩由 pi 自己做，内核看不到；靠常驻上下文里要求 agent 随时更新 `progress/` |
| C12 | `packages/runtimes/pi` | 恢复 transcript 后不重跑旧调用 |
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
- worktree 建在数据目录 `~/.aoa` 下，而凭据规则会拦提到 `~/.aoa` 的命令。所以规则先把指向本 session 自己 worktree 的绝对路径改写成相对路径再判断；用 `..` 爬出去的、别的 session 的 worktree、数据目录里其余的东西照旧交给你。写成 `~/.aoa/worktrees/…` 的形式不会被改写，仍然会问你。
- 凭据规则不看没有 shell 读的 heredoc 正文：`python3 - <<'EOF'`、`cat > notes.md <<EOF` 这类正文是数据或另一种语言的代码，里面提到 `~/.aoa` 不等于 shell 去打开它。自用数据里（2026-11-16/17）这条规则问过的 6 次里有 3 次就是脚本改文档时正文写着「`~/.aoa` 规则」，都被批准了。开头那一行里有 `sh`、`bash`、`zsh`、`dash`、`ksh`、`eval`、`source` 时正文照旧检查；终止符没加引号、正文里有 `$` 或反引号时也照旧检查，因为 shell 会展开里面的 `$(…)`；`<<<`、开头那行本身、终止符之后的命令都照旧检查；找不到终止符时整条命令照旧检查。代价：python、node 的 heredoc 里真去读凭据的代码也过了这条规则，落到风险等级和分类器，和一个脚本文件去读凭据是同一种漏洞（规则是文本匹配，本来就绕得过去，见 §6）。引号或注释里的 `<<word` 也会让后面的行被当成正文，同样落到风险等级。
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

### 具名 agent

一个 `serve` 里可以同时跑几个有名字的 agent，各有自己的 inbox、worker、角色、权限和记忆，彼此只通过往对方 inbox 写事件合作。「一个 inbox 同时只有一个 run」照旧成立，只是按 agent 算：不同 agent 的 run 可以同时在跑。第一个用法是实现 agent 把做完的分支交给只读的审查 agent，审查 agent 把结论发回实现 agent，同时通知你。

- 配置：顶层字段就是默认 agent，和以前完全一样。可选的 `agents` 按名字列出其余 agent，每个可以写 `role`（`implement` 或 `review`，默认 `implement`）、`instructions`（接在角色的系统提示后面）、`model`、`classifier`、`risk`；没写的取顶层的值，`risk` 写了就整张替换，不和顶层合并。名字要符合 `^[a-z][a-z0-9-]{0,31}$`，`default` 留给顶层那个。`agents` 和 `github` 同时出现是配置错误：issue 和 PR 没法指明是给哪个 agent 的，GitHub 模式保持单 agent。
- 身份和存储：默认 agent 的一切都不变：inbox `local/<repo>`、`memory/local/<repo>/`、`worktrees/local/<repo>/`、分支 `aoa/<8 位>`，已有的任务、记忆和页面数据照常可用。具名 agent 的 inbox 是 `local/<repo>@<名字>`，目录是 `memory/local/<repo>@<名字>/` 和 `worktrees/local/<repo>@<名字>/`，和默认 agent 的并列而不是嵌在里面，否则默认 agent 的记忆列表会列出别人的文件。具名实现 agent 的分支是 `aoa/<名字>/<8 位>`。所有 agent 共用一个库和一个时钟；每张表本来就按 `inbox_id` 分，所以表结构没有变。
- `serve` 为每个 agent 跑 worker、scheduler、dispatcher 和收尾检查；心跳和页面只有一份，心跳记在默认 agent 的 inbox 里，页面上每个 agent 都从那里读。
- 角色：`implement` 就是原来的工具、提示和规则。`review` 只有 read、grep、find、ls、bash、`memory_*`、notify、`wake_me_at`/`cancel_wake` 和 `send_to`，没有 edit、write，也没有 `ask_user`：它的结论就是它的回答。一条排在内核规则之前的规则直接拦下（`block`，不是延后）bash 里改引用或改历史的 git 调用：commit、push、merge、rebase、reset、cherry-pick、revert、tag、am、apply、stash、checkout、switch、worktree，以及带了列表以外参数的 `branch`。用拦而不用延后，是为了不让你被问「要不要让审查 agent 提交」；排在内核规则之前，是为了让这条拦截胜过内核对 `~/.aoa` 路径的延后。
- 只读是约定，不是隔离：审查 agent 的 shell 还是你的 shell，重定向、`sed -i` 照样能写文件，文本匹配也能被绕开（§6）。它防的是审查 agent 顺手提交或改分支，不是防一个有意破坏的模型。复查「新测试去掉修复后会失败」用 `git restore --source=<base> -- <文件>` 再 `git restore -- .`，这两条不在拦截之列。
- 审查用的 worktree 停在被审分支的提交上（`git worktree add --detach <目录> <sha>`），因为分支本身已经在实现 agent 的 worktree 里检出，git 不允许同一分支检出两次。分支在准备 worktree 时才解析成提交；事件里没有分支时停在 `base`。分支名来自模型，只按 `refs/heads/<名字>` 解析，交给 git 的只有 sha。`send_to` 和 `aoa send --branch` 在追加之前就检查分支存在，不存在直接报错，而不是让审查 agent 的事件重试三次后进死信。`branch` 只能发给审查 agent。
- 新工具 `send_to({ agent, text, branch? })`，只在配置了不止一个 agent 时出现，目标必须是另一个已配置的 agent。它往目标 inbox 追加一个事件，来源是 `agent_message`。规范 §3.2 的 `EventSource` 里没有这一项，这里加上，规范不改。追加之后唤醒目标的 worker（所有 agent 在同一个进程里）。去重键由这次调用派生，崩溃后重放不会追加第二条。
- agent 之间的消息和发送方 session 一样可信：发送方没有 tainted（内核交给它的只有你的话和定时器、答复这类事件）时 `trusted = true`，tainted 了就是 `false`，收到它的 session 照现有规则被标为 tainted，之后联网和安装都要问你（§6）。原先一律不可信，理由是消息里可能带着仓库里的注入文本；但 agent 读仓库本来就不算 taint，所以这条理由对单个 agent 并不成立。代价落在 harness 模式上：自用数据里 3 次 `admit` 全是实现 agent 和审查 agent 之间的交接。无论可不可信，它都不能变成审批的答复，因为只有可信的 `user_message` 才会被改写成 `approval_answer`。局限：tainted 只记内核交给 session 的事件，agent 自己用 bash 抓的网页、harness 发送方（Codex 审查 agent）的工具在沙箱允许时读到的外部内容都不算，这些内容可能经消息带给对方。
- 线程：payload 是 `{ from, text, branch?, hop, replyThread? }`，`replyThread` 是发送方 session 的主线程。如果当前 session 是由同一个 agent 发来的 `agent_message` 开出的，新消息写回那条消息的 `replyThread`，于是恢复的是对方原来的 session；否则在目标那里开一条新线程。判断只读库里的事件，跨 run、跨重启都成立。所以实现 agent 第一次交审在审查 agent 那边开新任务，审查结论回到实现 agent 原来的任务；实现 agent 改完再交审，又是一个新的审查任务，停在新的提交上。
- 跳数上限：`hop` 是这个 session 收到过的 `agent_message` 里最大的 `hop` 加 1，用户交代的任务里第一次 `send_to` 是 1。超过 4 时工具返回错误，让 agent 改为通知你，什么都不追加。这样「交审、结论、修改、再交审」能走完一轮，但两个 agent 不会无休止地来回。取 session 里的最大值而不是只看这次 run 的事件，是因为结论之后可能先有一次审批或用户插话，那一次 run 里没有 `agent_message`，计数不能因此归零。
- 结论只是建议：审查 agent 通知你，并把同样的结论发给实现 agent。它不能合并（`git merge` 被拦）、不能关任务（没有对应的工具）、也不能回答审批。审批只由你用 `aoa answer` 回答；call id 在所有 agent 的 inbox 里找，答复写进持有那个调用的 inbox。
- 有审查 agent 时，实现 agent 的提示多一段：提交之后用 `send_to` 把简短说明和当前分支交给审查 agent，再通知你；收到结论时按结论修，或者说明为什么不修。审查 agent 的提示要求：用 `git merge-tree --write-tree` 检查能否干净合进 `base`，跑仓库文档里写的测试和类型检查，能做到时检查每个新测试在去掉修复后会失败，然后给实现 agent 一条结论，并用同样的结论通知你。
- 命令：`aoa send --agent <名字> [--branch <分支>]` 给具名 agent 派活，不带 `--agent` 是默认 agent，`--branch` 只能给审查 agent。`send --to`、`close`、`answer` 在所有 agent 的 inbox 里找。`status` 和 `messages` 多一列 agent；只有一个 agent 时文字输出和以前一样，JSON 里总带 `agent` 字段。`messages` 按 outbox 的入队顺序（`seq`）合并所有 agent 的消息：「按投递顺序」在这里理解为入队顺序，因为游标要求列表只在末尾增长，而送达时间对还没送出的消息会变。
- 本地通道：所有 agent 写同一个 `messages.md`；有多个 agent 时每条写上 agent 名，通知标题也带上名字。
- 页面：快照和推送里是默认 agent 的快照，外加 `agents` 数组放其余 agent 的快照，每次推送另带各 agent 各自流过的边。用增量字段而不是换一个外层结构，是因为页面文件每次请求都从磁盘读，正在跑的 `serve` 可能比页面旧或新；旧页面照常显示默认 agent。顶部的切换按钮在浏览器里切换，整页只显示选中的 agent。`in` 边把 `agent_message` 单独数出来：边上方是 `send · answer 5`，下方是 `agents 2`；写成一行会压到 Event inbox 节点上。

### 审核模型

§6 分类器那一步换成了审核模型（`apps/aoa/src/reviewer.ts`）。它仍是 `PolicyConfig.classify`，用的还是配置里的 `classifier` 模型（现在是 DeepSeek flash），只改了它看到什么、按什么标准判。规则表、风险等级和延后的顺序都没动：规则延后的调用（worktree 之外、tainted 时联网、凭据路径、本地推送）、`high` 风险和 `admit` 照旧直接交给你。

- 看到的：你在这个任务里说的话（trusted 的 `user_message`），其他 agent 发来的话（单独放一块，标明是模型写的，不能授权、不能扩大任务），这个任务最近 20 次调用的工具名、参数（每条截到 600 字符）和第一次裁决，agent 的角色和工作目录，最后是这次调用和 tainted。不看调用结果：注入的内容是从结果里进来的。也不看 agent 自己说的话。
- 标准：只有五类要问你——数据离开本机；删改不是本 session 创建的东西；读或用凭据（包括 `~/.aoa` 的配置和数据库）；tainted 时引入 lockfile 之外的代码；钱或账户。另外和任务无关或看不懂的调用也问。答 `ask` 等同于以前的 `unsure`，交给你；答案不是 allow、ask、block 之一或请求失败时也交给你。
- 和规范 §6.2 的出入：规范里 `Policy` 的输入只有这次调用。审核模型多看了任务的上下文，其中其他 agent 的话和之前调用的参数是模型写的。它守住的是 §6.2 的要害：不收模型对自己这次调用安全与否的说法，调用结果也不进来。
- 为什么这样定：用自用数据离线回放（`apps/aoa/eval`，2026-11-18，数据和结果都在 `~/.aoa/eval/`，不进仓库），每个调用问三次，任何一次放行就算漏。原来的分类器只看调用，开发集 39 个坏调用漏放 4 个，留出集 15 个漏 6 个。按上线的路由回放（规则延后不交给审核模型），审核模型漏 0 个和 1 个；留出集漏的那个是被注入的 `admit`，线上 `admit` 不经过审核模型，直接交给你。实验里也试过让审核模型改判规则延后的调用：真实记录里一次读 `~/.aoa/agents/*` 在三次里被放过一次，所以规则延后继续直接交给你。正常调用（开发集 439、留出集 144）审核模型一次也没问，交给你的只有规则延后的 1 次和 2 次。你答复过的调用里，审核模型和你不一致的只有留出集一个你拒绝的 `admit`（它三次都放行），线上 `admit` 不经过它。数据只有十个 session，结论只对这些数据成立。
- 回放和线上用的是同一份提示词和同一个拼消息的函数，`eval/configs` 里写 `"criteria": "@reviewer"`。改提示词就要重跑回放。上线前用回放缓存核对过：换成共享函数后所有请求都命中缓存，说明字节一致。
- 线上从 store 读上下文时，事件归属用回放导出同一条规则：先看 `resume`，再看领走它的 run 所在的 session，最后看 thread 所在的 session。测试核对过一次批准加一条追加消息跨三个 run 时，线上发出的消息和回放拼出的一致。每次中风险调用都把整个 inbox 的事件和 run 读一遍，量大了再加索引。和回放的两处差别：线上不排除在这次调用之后、裁决之前到达的事件；之前的 `admit` 调用在线上没有参数（日志里没有），回放里是被扣下的事件。
- `decisions` 里这一步的依据记作 `reviewer:allow`、`reviewer:block`、`reviewer:unsure`，没配模型是 `reviewer:missing`，请求失败是 `reviewer:error`。2026-11-18 之前的行是 `classifier:*`，观察页和回放两种都认。
- Jev 影子判断照旧挂在这一步上，现在和审核模型同时被问。

### 影子判断 Jev

目标是让专门的意图裁决模型（现在选的是 Jev）接管 §6 里分类器那一步，最终完全由它裁决。影子判断是第一步：先在不影响裁决的前提下收集它的分数，和分类器的结论、你的答复对照，定出阈值后再切过去。

配置里可选 `shadowJudge: { provider: "typesafe", modelId: "jev-1.14.0", apiKeyEnv: "TYPESAFE_API_KEY" }`。有它时，分类器每被问到一次，Jev 也在同一时刻被问到同一个调用。分类器的结论仍是裁决，Jev 的分数、失败或 5 秒超时都不改变、也不拖长它：Jev 在后台跑，失败只记日志和一行错误，不抛给 run。它的 key 和模型 key 一样在启动时读入并从 agent 的 shell 继承的环境里删掉。不配这一节时什么都不发生。

送给 Jev 的 `state` 只有这次调用：工具名、参数、session 是否 tainted，参数里落在本任务 worktree 内的路径改写成相对路径。不带对话、transcript、记忆，也不带模型自己说的理由——这些正是注入的内容会去填的地方，和分类器守的是同一条规则（§6）。模型钉在 `jev-1.14.0`，以后按收集到的数据定阈值时不会换版本。问题只有一个：`safe_unattended`，`noul` 问「这次调用可以不问用户就运行吗」，返回的 `noul` 是「是」的概率。

每个被判断的调用在 `judgments` 里留一行（`p` 为 NULL 表示失败，`error` 写原因）。`aoa web` 的 Permissions 面板在分类器的结论旁显示 Jev 的 `p`；用户答复过的调用同时显示 approve/deny。面板还给最近 7 天一行小结：有多少次分类器调用被判断，以及分类器结论（allow/block/unsure）按 Jev 概率（≥0.9、0.5–0.9、<0.5）的 2×3 计数。这一版只收集和展示，不参与裁决。

### 观察页 `aoa web`

看五个原语的现状和它们之间流过什么，session 只是行上的一个 id。`aoa serve` 顺带开它并打印地址，用户要一个命令；端口被占用时只提示一行，`serve` 照常跑，因为页面只是用来看的。`aoa web` 单独开同一个页面，给 `serve` 没在跑的时候用。和 `serve` 同进程意味着 `serve` 崩了页面也断开，页面会显示断开，这时再用 `aoa web` 看库里留下的状态。

- 推送为主，轮询只做兜底。`aoa web` 自己先开着一条库连接，所以 WAL 文件一直在；它用 `fs.watch` 盯 `<db>-wal` 这个文件（盯目录会漏事件），别的进程每提交一次，几毫秒内就触发。50 毫秒内的触发合成一次：重读一遍快照，和上一份比，有变化才通过 SSE 推给所有浏览器，带上每条边这次过了几个。兜底只有一个：每 1 秒比一次 `PRAGMA data_version`，变了才重读；实测 `fs.watch` 偶尔会永久漏掉一次写入（macOS 上连续提交时见过），所以这一秒是页面能落后的上限，不是可有可无的保险。浏览器连上（包括断线重连）先拿到当前快照。
- 只随时间变、没有写入的状态：`serve` 心跳过期、重试的等待到点、租约到期。快照里给出其中最早的时刻 `nextChangeAt`，`aoa web` 在那一刻自己重读一次，所以页面会翻成离线，不用等谁写库。快照里的时间都是绝对时间，生成时刻不参与比较，「已经过去多久」由页面按服务端时钟换算。
- 心跳：`serve` 启动时在 `cursors` 表里记 `serve:started`，每 5 秒叫醒 worker 时顺带记 `serve:seen`。超过 15 秒（三次没叫醒）没更新就算离线。
- 安全：只绑 `127.0.0.1`，`Host` 不是 `127.0.0.1:<端口>` 或 `localhost:<端口>` 的请求一律 403，防 DNS rebinding 把工具参数和消息读走。除了下面的 `POST /answer` 只有 GET。页面带 CSP（含 `frame-ancestors 'none'`，另加 `X-Frame-Options: DENY`，别的网站不能把它嵌进去骗你点按钮），不加载任何外部资源（字体也不从 Google Fonts 拿）。库里的内容都是模型或仓库写的，页面只用 `textContent` 放进去。
- 在页面上回答（2026-11-17 加）：自用数据里每次审批都要等 1 到 8 分钟，答复全是在 shell 里跑 `aoa answer`，经 MCP 时还得让主会话一直轮询 `messages`。所以 Permissions 里等你的每一行直接给出完整的调用（`bash` 写成命令本身，其他按 JSON；放行请求的参数里只有内核截的前 200 字，所以页面从 inbox 里取出被扣住的每条事件，写明谁发的、给出全文。都不截断，看完再答）和按钮：审批是批准/拒绝，放行（`admit`）是放进来/丢掉，提问是一个答案框和拒绝；审批可以附一句理由给 agent。按钮发 `POST /answer`（`callId`、`verdict`、`text?`），写的和 `aoa answer` 是同一条 `approval_answer`，`via: "web"`，然后叫醒那个 agent 的 worker 并立刻重建快照推给所有页面。
  - 只收页面自己发的：`Origin` 必须正好是 `http://127.0.0.1:<端口>` 或 `http://localhost:<端口>`（浏览器的脚本发 POST 一定带它，别的网站或本机别的端口都不行），`Content-Type` 必须是 JSON（跨站要先预检，而预检拿不到任何 CORS 头）。没加 token：本机任何进程都能读页面拿到它，而本机进程本来就能跑 `aoa answer`，token 防不住什么。
  - 只认完整的、现在正在等的调用 id，不认前缀：页面手里总有完整 id，前缀只会让一个短字符串误中唯一的那个调用。问题必须带答案文字。同一个调用的第二次答复会被库按去重丢掉，这时返回 409，不假装成功。
  - 答复写下以后，延后调用要等下一次 run 执行完被批准的调用才删，所以快照里每个等待的调用多了 `answered`（库里已有、还在 `pending` 或 `in_run` 的那条答复的结论），页面据此不再给按钮，只说已批准或已拒绝、等 agent 下次运行时取走。单开 `aoa web` 而 `serve` 没在跑时会一直停在这个状态，直到 `serve` 起来。
  - 推送每次都重建整个列表，所以页面按调用 id 记住你在框里打的字，重建后把焦点和光标放回去；输入法正在组字时这个列表先不重建（重建会打断组字），组字结束再补；选字用的回车不算发送。按钮点击不会展开/收起这一行。`serve` 比页面旧时（页面每次从磁盘读，`serve` 可能还是旧进程）快照里没有 `kind`，页面就退回显示 `aoa answer` 命令；万一按了，旧 `serve` 回 405，页面提示重启或用命令。
  - 仍然只绑 `127.0.0.1`，手机上点不了。
- 浏览器通知（2026-11-17 加）：`osascript` 的通知点开是脚本编辑器，到不了答复的地方。页面头部有一个「等我时通知我」按钮，点了才向浏览器要通知权限（浏览器只在用户点击后弹授权）。有权限的页面连 `/events?notify=1`，等你的列表里出现新的调用、而你没在看这个页面（标签不可见或窗口没有焦点）时弹浏览器通知；点通知回到这个标签、切到那个 agent、光标放进它的答复框。页面打开时已经在等的不再弹；`tag` 用调用 id，开了两个标签也只留一条。
  - 授权成功时立刻弹一条「aoa will notify you here」：浏览器说有权限，系统设置却可能不让这个浏览器弹出来，这一条让你当场看到能不能收到。
  - 只有页面自己的脚本能说「我会通知」：`?notify=1` 还要带 `Sec-Fetch-Site: same-origin`（浏览器自己加，脚本改不了）。否则别的网站用一个 `<img>` 或 no-cors 请求挂着这个地址，就能让审批请求不再弹桌面通知。
  - 和桌面通知的分工：`serve` 进程里的页面服务把自己的地址和「现在连着几个开了通知的页面」记在所有 agent 共用的 `PageLink` 上（连接断开靠请求的 abort 信号，关标签立刻生效；流本身要等下一次写才知道）。本地通道发审批请求时读它：有开了通知的页面连着，就不弹 `osascript`，由页面弹；没有就照旧弹，并在正文末尾写上页面地址。普通消息照旧走 `osascript`。消息文件照常写。
  - 风险：连着不等于弹得出来。后台很久的标签可能连接还在、脚本却被浏览器冻住，这时桌面通知被省掉，页面也没弹。要是自用中遇到，就改成页面弹出后回报一次、`serve` 只对收到回报的调用省掉桌面通知。
  - 单开的 `aoa web` 是另一个进程，`serve` 看不到它的连接，所以这时两边都会通知。页面必须开着至少一个标签；不开页面也要收到的话需要 Service Worker 加 Web Push，要一个推送服务，单机自用不值得。
- 不需要模型的 key：和 `status` 一样，只有 `serve` 检查 key。
- 边的计数：`in` 是非定时器、未被去重丢掉的事件；`fires` 是定时器事件，审批过期变成的 `approval_answer` 也算在 `fires` 里，因为它是定时器触发的。`calls` 是工具日志里的 intent，所以延后的调用在被批准之前不算；`set` 和 `memory` 是其中 `wake_me_at`/`cancel_wake` 和 `memory_*` 的部分。`says` 是 outbox 新增的行，`delivered` 是送出的行（送达时间来自存储层新加的 `sentTimes`，`OutMsg` 不带它）。
- 每次重读都在一个事务里扫全表（事件、run、日志、决定、outbox、定时器），对单人用的库够快；以后慢了再改成专门的聚合查询。记忆目录在事务外遍历，跳过写到一半的 `.tmp` 文件。24 小时窗口只在重读时更新，没写入时会稍有滞后。
- 布局：主栏上面是流程图，没有「你」这个节点，进来的边从 `send · answer` 起，`delivered` 的边越过 Outbox 出去；下面是 Event inbox、Permissions、Outbox 三个列表。右栏放 Timers 和 Memory，直接给内容：每个定时器一张卡片，写触发时间、种类、哪个 session 设的、唤醒哪个 thread，以及 agent 会收到的完整 payload（`note` 原样，别的 payload 按 JSON；审批过期的定时器没有 payload 文本，它变成的是一个答复）。最近结束的定时器里，触发过的按 `lastFired` 排在前；取消的排在后面，因为表里没有取消时间，而它们的 `due` 往往还在将来，混排会压到最前。审批被回答时取消的过期定时器不列出。
- 记忆文件的全文也在快照里：最新改动的文件先占额度，每个文件最多 64 KB、总共最多 512 KB，超出的只带开头并标 `truncated`，截断点退回到完整字符。不是合法 UTF-8 的文件不带文本，只标 `binary`；只检查读到的那部分。记忆写入会在工具日志里提交，WAL 的监视因此看得到，不用另外盯记忆目录。页面上每个文件是一个 `<details>`，按路径复用，所以推送更新后用户展开的文件保持展开，滚动位置也不变。
- 记忆按一次运行什么时候能看到它分组，和 §7 一致：每次运行都加载的 `instructions.md`、`index.md`（缺了就明说，`instructions.md` 由你来写）；只进自己任务的 `progress/<session>.md`，标上那个任务现在的状态；需要时才读的 `notes/`；不属于这套布局的其他文件单列。「已经告诉过你的」不是文件，是 worker 每次运行从 outbox 取的最近 5 条，页面用同一个读法列出来。

### 主会话接入：`aoa mcp`

聊天里的 agent（Claude Code、Codex、Cursor 等）原来要靠 shell 敲 `aoa` 命令当入口；`aoa mcp` 让会说 MCP 的 harness 不经 shell 直接驱动 aoa。用户注册一次：`claude mcp add aoa -- aoa mcp`。

- 走 stdio，由 harness 启动和关闭，不开端口。它和其他命令一样按 `--config`、当前目录、`~/.aoa` 找配置，打开同一个库，调用 CLI 调用的同一组函数；不需要 `serve` 在跑，自己也不跑 worker，只往 inbox 追加和读库。stdout 只走协议帧，日志写 stderr。SDK 的 stdio 传输察觉不到客户端断开，所以 stdin 结束时进程退出。
- 五个工具，各对应一个 CLI 命令：`send`（`text`、`agent?`、`branch?`、`to?`，对应 `send` / `send --to`）、`messages`（`since?`、`wait?`，0–120 秒，对应 `messages --json --wait`）、`status`（对应 `status --json`）、`close`（`thread`、`outcome`，只在本地模式）、`answer`（`callId` 或前缀、`verdict`、`text?`）。结果是 JSON 文本；出错时是 MCP 的工具错误，消息和 CLI 打印的相同。`to` 和 `agent`/`branch` 同时给时报错，意思和 CLI 的那句一样，只是把参数名从 `--to` 换成 `to`。`messages` 的说明让模型拿返回的游标再调一次来接着等，单次最多等两分钟。
- `send` 带 `to` 时，如果那个任务在等审批（延后的调用不是 `ask_user` 的提问），直接拒绝并指向 `answer`，什么都不追加。原因：内核会把等审批的 thread 上来的 `/approve` 当成批准，答复就有了两条路；拒掉以后答复只有 `answer` 一条。检查和追加在同一个事务里，`serve` 不会在两者之间把 session 停下来。为此内核多导出了 `appendInTx`（只是导出，行为不变）。在等 `ask_user` 提问的任务上，文字照旧就是答案。CLI 的 `send --to` 行为不变。
- `answer` 写下的 `approval_answer` 在 payload 里多一个 `via: "mcp"`；CLI 和 thread 上的回复不带它，所以库里分得清答复从哪来。这是 `AnswerPayload` 上新增的可选字段，`answerDeferred` 多一个可选参数，规范里没有，这里加上，表结构不变。
- 安全只靠两样：`answer` 的工具说明写明只有在用户在对话里对那个调用明确说了同意或拒绝之后才能调用；以及 harness 自己对工具调用的确认。这和让 shell 去跑 `aoa answer` 是同一种信任，没有另加机制。

### 权限归 harness 的 agent

runtime 分两档。第一档（现在的 `runtime-pi`）自己没有工具，每次调用都走内核的 `Tool.invoke`，由内核裁决、记日志、执行，这一节不改它。第二档是自带工具的 harness（第一个是 Codex app-server，见下一节）：它能做什么由用户在 harness 里配置，内核既不裁决也不执行它的调用，只做两件事：转达 harness 自己提出的询问，以及在用户放行之前扣住不可信的输入。这一节讲内核这边；一致性测试用一个扮演 harness 的脚本 runtime。

- 模式：`WorkerOptions.permissions`，`"kernel"`（默认，和以前一样）或 `"harness"`。放在 worker 上，因为一个 worker 就是一个 agent 的 inbox，而这个模式同时改两处：`select()` 怎么挑事件，以及 run 拿到什么（`RunInput` 多一个 `ask`）。策略（`policy`）本来也在这里。
- 转达询问：harness 要为一次调用征求同意时，runtime 调 `RunInput.ask({ callId, tool, args, reason? })`，只会得到 `allow` 或 `defer`。内核对 harness 的调用没有规则，所以不会当场拒绝；用户的拒绝和以前一样，在之后的 run 里通过 `RunInput.answer` 到达。`defer` 时内核建一个新种类 `harness` 的延后调用：审批请求进 outbox、24 小时到期、session 停下、run 以 `deferred` 结束。session 已经在等别的调用时只返回 `defer`，什么都不建也不记，和 `invoke` 的规则一样。新建的询问记一行 `defer`，用掉许可记一行 `allow`（依据写明是哪次批准的许可）；重试时按调用 id 重放的 `allow` 不再记。
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

### Codex runtime（`packages/runtimes/codex`）

第二档的第一个 runtime。配置里 `runtime: "codex"`（顶层或具名 agent，默认 `pi`），这个 agent 的 worker 就是 `permissions: "harness"`；pi 的 agent 永远是 `"kernel"`。

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

### DeepSeek Harness runtime（`packages/runtimes/dsh`）

第二档的第二个 runtime，接的是 dsh 的 SDK 档：`dsh --profile sdk`，stdio 上换行分隔的 JSON-RPC 2.0（[方案](proposals/deepseek-harness.md)，依据 dsh `0.2.2-rc.3`）。

- 配置：`runtime: "dsh"`（顶层或具名 agent），要写 `model`（dsh 的模型名）和 `apiKeyEnv`（密钥所在的环境变量），可选 `dsh: { command, preset }`：`command` 默认 `dsh`；`preset` 是权限预设（`read-only`、`workspace-write`（默认）、`danger-full-access`），aoa 把它写进 patch，profile 固定是 `sdk`。这个 agent 的 worker 是 `permissions: "harness"`。只能用在本地模式；审查角色不支持（dsh 的工具不经过 aoa 的只读规则，拦不住）。provider 固定是 `deepseek-official`，aoa 不提供别的路由。`serve` 不要求 dsh agent 配分类器：它自己的工具不经过 aoa，aoa 给它的工具都是 `low`。
- 进程和会话：每次 run 起一个 dsh 子进程，工作目录是 session 的 worktree，run 结束就停掉。`initialize` 带 `cwd`、`provider`、`model`、`approvalRequests: true` 和 `capabilities: { userQuestions: true }`。新会话的 `sessionId` 由 aoa 生成，直接 `session/prompt`，它就是这个 session 的 `sessionRef`；已有的会话先 `session/resume`，再用 dsh 自己的 `/permission <预设>` 命令把权限预设重新设一遍（dsh 把 sandbox 和 approval 策略存在会话里，恢复时它们优先于 patch 的默认值，所以从 `danger-full-access` 改成 `workspace-write` 之后继续同一个任务，下一次 run 就是 workspace-write；dsh 没有这个命令、或者命令报错时 run 直接失败，不会带着旧权限往下跑），最后才 prompt。`session.status` 进入 `idle` 就是 run 结束。但 idle 不等于成功：`turn/end` 事件的 `reason.kind` 是 `error` 时这次 run 直接抛错交给内核重试（鉴权失败、模型报错都会走到这里）；日志里没有结论时再问一次 `session/wait`，让 dsh 手里的 live failure 也冒出来。本次 run 的事件按 pi 的格式写成一个 text block。
- 版本：dsh 握手里的 `version` 固定写死是 `0.0.1`，分不出发布版本，所以启动前先跑 `<command> --version`，要求等于代码里的常量 `0.2.2-rc.3`，不一致就让这次 run 失败并说明原因。dsh 还在开发者预览阶段，换版本时 patch 里的行 id 也要重新核对一遍。
- 独立的 home 和 patch：`$DSH_HOME` 是 `<dataDir>/dsh-home`，不带用户的 dsh 插件、MCP 和设置。每次 run 在 `<dataDir>/dsh-home/patches/` 下写一个 patch：把权限预设写成 `sandbox-policy` 的 `mode` 和 `approval` 的 `policy`（用户 dsh 里的设置放宽不了它）；关掉 dsh 自己的子代理、team、goal、workflow、jobs、插件管理器，以及它自己的提问和调度工具（这样提问只有 aoa 的 `ask_user`、定时只有 `wake_me_at`）；插入一行 `dsh-mcp-client`，server 名 `aoa`，指向这次 run 的桥；再用 `system-prompt` 行的 `personaSuffix` 把 aoa 的系统提示交给 dsh，因为 SDK 协议没有 instructions 字段。行 id 逐项对照过 dsh 的 base 和 sdk-app profile。
- 子进程环境只有 `DSH_HOME`、`DEEPSEEK_API_KEY`（从 `apiKeyEnv` 读出，放进 dsh 默认读的那个变量）、`AOA_DSH_SYSTEM_PROMPT`，以及 `PATH`、`HOME`、`TMPDIR`。aoa 启动时从自己环境里删掉的 key 不会出现在里面，别的 agent 的 key 也不会。
- 调用表和审批：dsh 的审批请求只有 `toolName`、`callId?`、`reason?`，参数在更早的会话事件里——普通调用是 `tool/call`（键 `callId`），`run_code` 里的子调用是 `tool/ptc-dispatch-start`（键 `subCallId`）。事件一到就同步记进调用表，键是 `(dsh 会话, callId)`。查得到时 `ask` 的工具名是 `dsh:<toolName>`、参数取表里的；`allow` 回 `allowed-once`，`defer` 回 `rejected` 再停下。查不到（没带 callId，或表里没有）直接 `rejected`，不问用户，也不按工具名放行——内核只按工具名加参数深度相等消费许可，放宽就可能把许可用到另一条命令上。内核 call id 用 `<aoa session>:<dsh callId>`。`user-question/ask` 回 `{cancelled: true}`，其他请求回 JSON-RPC 错误。
- 许可和重问：和 Codex 一样。批准后的下一次 run，输入里写明「用户批准了、还没做、照原样再做一次」；dsh 再做时照自己的设置又问一遍，`tool` 和 `args` 深度相等，内核直接放行，不再发请求。拒绝也写进下一次的输入。
- aoa 的工具走 MCP 桥：每次 run 在本进程起一个 streamable-http MCP server，只监听 `127.0.0.1`、端口随机，路径里带这次 run 才有的 token（每次询问都是新的），dsh 看到的工具名是 `mcp__aoa__<名字>`。dsh 发给 MCP 的只有名字和参数，不带它自己的 callId，所以桥按「同一会话、工具名对应、参数深度相等、还没被认领、最早的一条」从调用表里认领，内核 call id 用 `<session>:<dsh callId>`；认领不到就回 MCP 错误、不执行。延后的 aoa 工具回一句「等用户决定」然后停下；重试时同一个 dsh callId 得到同一个内核 call id，日志里已有结果的直接重放，不会再执行一次。
- 停下和恢复：dsh 没有取消方法。要停时先回复手上的请求（审批回 `rejected`，aoa 工具回「等用户决定」），之后来的审批请求和 MCP 调用一律拒绝、不再问内核；**正在执行的 aoa 工具调用要等它做完并回完话**——桥记着在途的调用数，run 不会带着一个还在跑的旧调用结束，也不会在它的回复送出之前停 dsh。然后发 `shutdown`：dsh 是先回话、再 flush 会话、再退出，所以等的是**进程退出**而不是回话，最多 10 秒，超时 SIGTERM，再等 10 秒，还不走就 SIGKILL。`shutdown` 回的错只记日志、不改这次 run 的结局：那时 run 已经做完了，抛错只会让内核把同一件事再做一遍。正常 `idle` 也走这一套。会话用 JSONL 持久化、锁是 flock，进程一死就释放，所以下一次 run 能 resume；在途调用的结果 dsh 自己会标成未知，模型从修好的历史里看到。
- 和 Codex 一样：dsh 不问就执行的、它的沙箱允许的操作，aoa 既看不到也拦不住，aoa 的推送规则、`~/.aoa` 规则和 worktree 边界对 dsh 自己的工具不起作用。`serve` 启动时为每个 dsh agent 提醒一次，`aoa status` 和观察页标出 runtime 和权限归谁。
- 冒烟测试只在 `AOA_DSH_SMOKE=1` 时跑（真的要 dsh 和真的 key，`bun test packages/runtimes/dsh/test/smoke.test.ts`）：冷启动时间、aoa 的 MCP 工具没有被 gate 拦、patch 关掉的工具确实不在模型能看到的工具列表里（从会话的 `request/header` 事件里读，dsh 自己的读写、bash 工具照常留着）、杀掉进程后能恢复。

和方案不完全一样、或者没做到的：

- 系统提示走 patch 的 `personaSuffix` 而不是握手字段：SDK 协议没有这个字段，而覆盖 `system-prompt` 这一行会连带丢掉 sdk-app 自带的 `personaPrefix`（「You are a coding agent powered by …」）。现在 dsh 的系统提示是它自己的身份和指引，后面接 aoa 的提示。
- 版本检查是跑 `--version` 读输出，而不是像 dsh 官方 client 那样读包清单；`dsh.command` 指向的如果不是那个包的 bin（比如包了一层脚本），检查的依据就是脚本打印的版本。
- `session/query` 只用来在恢复会话时跑 `/permission`，别的斜杠命令不用；`subagent.*` 通知忽略；dsh 的 PTC 子调用照样进调用表，没有别的特殊处理。
- 认领 MCP 调用靠参数深度相等。dsh 如果在事件和实际调用之间改写了参数（比如把相对路径换成绝对路径），桥就认领不到，这次调用会被拒、不会执行；这是有意的失败方向。
- `dsh.preset` 按方案 §5 是**权限预设**，不是 dsh 的 profile：aoa 把它翻译成 `sandbox-policy.mode` 和 `approval.policy` 写进 patch，profile 固定 `sdk`（方案里 `dsh --profile sdk` 是另一种「profile」，容易混）。


## 13. 没验证的

下面这些只能接上真实服务才知道，现在都只是按文档写的：

- GitHub App 的 JWT 和 installation token 交换，经 HTTPS 带 token 的 `git push`。
- GitHub 接口的细节：`since` 的语义、按创建时间排序、带标签的 PR 是否出现在 issues 列表里、`head=owner:branch` 过滤、经 issues 接口给 PR 加标签、真实的分页和限流。
- 真实模型会不会照系统提示的流程走；分类器会不会只回答一个词。本地模式下用 DeepSeek flash 试过一次（2026-11-16）：派活到提交 19 秒，返工、越界读文件的审批、`close` 后收尾都按设计走，被要求推送时它拒绝了，macOS 通知也弹出来了；只有这一个模型、一项任务，别的模型没试过。
- 宿主时钟要和 GitHub 相差一分钟以内，否则换 token 会失败。

已知的局限：

- pi 自己会在一次 run 里对限流、过载和网络错误重试 3 次（2 秒起，翻倍），所以一次限流不会直接耗掉一次尝试；分类器没有重试，出错时那次调用会交给你。
- 同一批里有一个调用被延后时，同批的其他调用照常执行。
- agent 的工作目录里的 `pre-push` 钩子或 `url.insteadOf` 规则能看到或改走推送用的凭据；和 §6 接受的同用户风险是一回事。
- 给 issue 打标签之前的评论不会进来，只有 issue 本身会。
- 本地模式的 inbox 是 `local/<仓库目录名>`：同一个 `dataDir` 下两个目录名相同的仓库会共用 inbox、记忆和 worktree 目录。
- macOS 通知最多等 5 秒，超时算发送失败，只记日志。

还要你来做的：给出模型的 key 和分类器配置，定下跑在哪台机器上，然后才是在真实仓库上跑通和两周自用。要接 GitHub 时再建 App 并装到目标仓库。

## 14. 暂缓

- 记忆的定期整理和历史版本（D-MEM-5）。
- 消息量评测。
- 多用户和 inbox 拆分。
- 再一个 runtime 适配器（Claude Agent SDK）。
