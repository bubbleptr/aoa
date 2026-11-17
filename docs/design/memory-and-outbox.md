# 记忆和发件

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
