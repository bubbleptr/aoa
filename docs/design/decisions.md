# 实现中定下的

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
- 本地模式的 `git push` 规则排在编码规则之后，所以强推之类仍然是直接拦掉，不会变成可以批准。
- GitHub 模式下 `serve` 自己每 60 秒驱动一次轮询并记下错误，网络出错不会让轮询停掉。`aoa send` 和 `aoa answer` 是别的进程，它们的写入经 store 的 `watch` 叫醒 `serve` 的循环（2026-11-18 起；之前是每 5 秒叫醒一次）。
