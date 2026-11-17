# aoa

按规范从头写的 always-on agent 内核。第一件事是写代码：你交代任务，它在自己的分支上做完，只在需要你的时候找你。

- [设计文档](docs/design.md)
- [规范](docs/spec.md)

状态：内核、SQLite 存储、pi 适配器、本地通道、GitHub 通道和 `aoa` 命令都已实现，端到端测试在脚本模型上跑通；还没在真实仓库上用过。

## 用法（本地模式）

准备：

- [Bun](https://bun.sh)，在仓库根目录运行 `bun install`，再在 `apps/aoa` 下运行 `bun link`，之后 `aoa` 在任何目录都能用。
- 模型的 API key 放在环境变量里，例如 `ANTHROPIC_API_KEY`。
- 一个 `classifier` 模型：`serve` 要求有它，否则每条 `bash` 都要等你批准，agent 自己跑不了检查，也提交不了。

把 `aoa.config.example.ts` 复制成 `~/.aoa/aoa.config.ts`，填上仓库路径和模型。配置按这个顺序找：`--config`、当前目录的 `aoa.config.ts`、`~/.aoa/aoa.config.ts`。配置里只写环境变量名，不写密钥。没有 `github` 一段就是本地模式：不用 GitHub，不推送，不开 PR。

```bash
aoa serve                                # 常驻：跑任务、发消息；Ctrl-C 停
aoa send "修掉 README 的错字"            # 开一个任务，输出它的线程，如 local:1a2b3c4d
aoa send --to <线程或前缀> "再改一下标题"  # 接着同一个任务说
aoa answer <调用 id 或前缀> approve|deny [理由]
aoa close <线程或会话前缀> merged|discarded
aoa status [--json]                      # 各任务的状态、结局、被问次数、分支、到第一条消息的时长
```

每个任务在 `<dataDir>/worktrees/` 下有自己的 worktree，提交在本地分支 `aoa/<会话 id 前 8 位>` 上。agent 找你时，消息追加到 `<dataDir>/messages.md`，在 macOS 上同时弹一条通知。需要批准时，消息里写着该运行的 `aoa answer` 命令；任务在等回答时，用 `send --to` 发的话也算回答：`/approve` 批准，其他内容算拒绝并作为理由。

你自己看分支、合并，然后用 `aoa close` 告诉 aoa 结局。`close` 只记录；`serve` 在下一次检查（5 秒内）关掉任务并删掉 worktree，分支保留。

agent 的 `bash` 里出现 `git push` 时会先问你。这只是约定，不是隔离：agent 的 shell 就是你的 shell。

## 多个 agent：实现加审查

配置里可以加 `agents`，让几个有名字的 agent 同时跑在一个 `serve` 里。顶层字段就是默认 agent，和以前一样；每个具名 agent 有自己的 inbox、worker、角色、权限和记忆，没写的字段（`model`、`classifier`、`risk`）沿用顶层。角色有两种：`implement`（默认，和默认 agent 一样写代码）和 `review`（只读：没有 edit、write，改引用或历史的 git 命令一律拦掉）。

```ts
agents: {
  reviewer: { role: "review", instructions: "Focus on missing tests." },
},
```

有审查 agent 时，实现 agent 提交后用 `send_to` 把分支交给它；审查 agent 在一个停在那个提交上的独立 worktree 里检查能否干净合并、跑测试、看新测试去掉修复后会不会失败，然后把结论发回实现 agent，同时通知你。结论只是建议：合并、关任务、回答审批都还是你来。两个 agent 之间来回最多 4 条消息，再多就该找你了。

```bash
aoa send --agent reviewer --branch aoa/1a2b3c4d "看看这个分支"   # 直接给审查 agent 派活
```

`status`、`messages`、`answer`、`send --to`、`close` 都会在所有 agent 里找；`messages.md` 和通知里写着是哪个 agent。具名 agent 的数据在默认 agent 旁边：inbox 是 `local/<repo>@<名字>`，记忆和 worktree 在 `memory/local/<repo>@<名字>/`、`worktrees/local/<repo>@<名字>/`，分支是 `aoa/<名字>/<会话 id 前 8 位>`。只能用在本地模式。

## 用 Codex 跑一个 agent

agent 可以写 `runtime: "codex"`（顶层或某个具名 agent），这时每次运行交给本机的 `codex app-server`，在任务的 worktree 里开一个 Codex 线程，同一个任务接着用同一个线程。读文件、改代码、跑命令用的是 Codex 自己的工具，它不问就能做什么由你在 Codex 里的审批和沙箱设置决定，aoa 不改这些设置。但你在 Codex 里装的插件、MCP server 和 hooks 不会带进 aoa 的运行，aoa 启动 Codex 时会把它们全部关掉。Codex 要问的时候，问题照常变成 aoa 的审批请求，你批准以后 Codex 会再做一次同样的操作并直接放行。记忆、`notify`、`ask_user`、`send_to` 这些 aoa 自己的工具仍由 aoa 裁决和记录。Codex 用自己的登录或环境变量认证，aoa 不读也不传它的密钥；`model` 可以不写（用 Codex 的默认模型），写的话是 Codex 的模型名。只能用在本地模式，审查角色不能用 Codex。

```ts
agents: {
  coder: { runtime: "codex", model: "your-codex-model-id" },
},
```

注意：aoa 的推送规则和 `~/.aoa` 规则管不到 Codex 自己的工具，`serve` 启动时会为每个这样的 agent 提醒一次；`aoa status` 和观察页会标出每个 agent 用的是哪个 runtime、权限归谁。

## 看它在做什么

```bash
aoa serve                                # 启动时打印页面地址 http://127.0.0.1:7878
aoa web [--port 7878]                    # serve 没在跑时，单独开这个页面
```

`aoa serve` 会顺带开这个页面并把地址打印到终端；端口被占用时只打一行提示，`serve` 照常跑。`--port` 换端口。`serve` 停着时用 `aoa web` 单独开，它不需要模型的 key。页面上方是流向图：事件进 inbox、worker 认领、每次工具调用过权限、定时器和记忆、outbox 发消息，哪条边上有东西经过，就有一个点沿它走一遍；没事发生时什么都不动。下面五块分别是 inbox、定时器、记忆、权限和 outbox 的计数和最近几条，等你回答的调用旁边写着该运行的 `aoa answer` 命令。页面靠推送更新，不轮询：库里每有一次提交就重读一遍，有变化才推给浏览器。头部显示 `serve` 是否在跑，超过 15 秒没心跳就显示离线。只监听 `127.0.0.1`，没有任何写操作。配置了多个 agent 时，页面顶部可以切换看哪一个。

## 让聊天里的 agent 当入口

aoa 自己没有主会话。你在别的聊天 agent（比如 Claude Code）里说话，由它敲命令就够了：

```bash
aoa send "..."                          # 派活，记下输出的线程
aoa messages --since <游标> --wait 600   # 等 agent 的下一条消息；输出末尾是新游标
aoa answer <调用 id> approve|deny [理由]  # 消息是审批请求时
```

`messages` 读的是 outbox，不是 `messages.md`，所以两种模式都能用，消息在通道送达之前就能读到；加 `--json` 给程序读。

一条约定：审批是留给你的，聊天 agent 只转述请求，得到你明确同意后才运行 `aoa answer`。

会说 MCP 的 harness 不用敲命令：`aoa mcp` 是一个 stdio 上的 MCP 服务器，把 `send`、`messages`、`status`、`close`、`answer` 作为工具提供，读写的是同一份配置和库，不需要 `serve` 在跑。在 Claude Code 里注册一次：

```bash
claude mcp add aoa -- aoa mcp
```

通过 MCP 时，`send` 不能拿来回答等审批的任务，只能用 `answer`；同样只有你明确同意或拒绝之后，聊天 agent 才能调用它。

## 接 GitHub（可选）

在配置里加上 `github` 一段（示例在 `aoa.config.example.ts` 里），并建一个 GitHub App 装到目标仓库，权限给 Issues、Pull requests、Contents 的读写，私钥文件放在本机。之后 `send` 会开一个带标签的 issue，agent 推送分支、开 PR，并在 issue 上评论；在评论里回复 `/approve` 或 `/deny 理由`。PR 合并或关闭就结束任务，`aoa close` 不可用；`status --refresh` 先去 GitHub 查 PR 状态。
