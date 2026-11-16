# aoa

按规范从头写的 always-on agent 内核。第一件事是写代码：你交代任务，它在自己的分支上做完，只在需要你的时候找你。

- [设计文档](docs/design.md)
- [规范](docs/spec.md)

状态：内核、SQLite 存储、pi 适配器、本地通道、GitHub 通道和 `aoa` 命令都已实现，端到端测试在脚本模型上跑通；还没在真实仓库上用过。

## 用法（本地模式）

准备：

- [Bun](https://bun.sh)，在仓库根目录运行 `bun install`。
- 模型的 API key 放在环境变量里，例如 `ANTHROPIC_API_KEY`。
- 一个 `classifier` 模型：`serve` 要求有它，否则每条 `bash` 都要等你批准，agent 自己跑不了检查，也提交不了。

把 `aoa.config.example.ts` 复制成 `aoa.config.ts`，填上仓库路径和模型。配置里只写环境变量名，不写密钥。没有 `github` 一段就是本地模式：不用 GitHub，不推送，不开 PR。

```bash
bun run aoa serve                                # 常驻：跑任务、发消息；Ctrl-C 停
bun run aoa send "修掉 README 的错字"            # 开一个任务，输出它的线程，如 local:1a2b3c4d
bun run aoa send --to <线程或前缀> "再改一下标题"  # 接着同一个任务说
bun run aoa answer <调用 id 或前缀> approve|deny [理由]
bun run aoa close <线程或会话前缀> merged|discarded
bun run aoa status [--json]                      # 各任务的状态、结局、被问次数、分支、到第一条消息的时长
```

每个任务在 `<dataDir>/worktrees/` 下有自己的 worktree，提交在本地分支 `aoa/<会话 id 前 8 位>` 上。agent 找你时，消息追加到 `<dataDir>/messages.md`，在 macOS 上同时弹一条通知。需要批准时，消息里写着该运行的 `aoa answer` 命令；任务在等回答时，用 `send --to` 发的话也算回答：`/approve` 批准，其他内容算拒绝并作为理由。

你自己看分支、合并，然后用 `aoa close` 告诉 aoa 结局。`close` 只记录；`serve` 在下一次检查（5 秒内）关掉任务并删掉 worktree，分支保留。

agent 的 `bash` 里出现 `git push` 时会先问你。这只是约定，不是隔离：agent 的 shell 就是你的 shell。

## 让聊天里的 agent 当入口

aoa 自己没有主会话。你在别的聊天 agent（比如 Claude Code）里说话，由它敲命令就够了：

```bash
bun run aoa send "..."                          # 派活，记下输出的线程
bun run aoa messages --since <游标> --wait 600   # 等 agent 的下一条消息；输出末尾是新游标
bun run aoa answer <调用 id> approve|deny [理由]  # 消息是审批请求时
```

`messages` 读的是 outbox，不是 `messages.md`，所以两种模式都能用，消息在通道送达之前就能读到；加 `--json` 给程序读。

两条限制：这些命令现在只能在 aoa 仓库根目录运行（或用 `--config` 指到配置）；审批是留给你的，聊天 agent 只转述请求，得到你明确同意后才运行 `aoa answer`。

## 接 GitHub（可选）

在配置里加上 `github` 一段（示例在 `aoa.config.example.ts` 里），并建一个 GitHub App 装到目标仓库，权限给 Issues、Pull requests、Contents 的读写，私钥文件放在本机。之后 `send` 会开一个带标签的 issue，agent 推送分支、开 PR，并在 issue 上评论；在评论里回复 `/approve` 或 `/deny 理由`。PR 合并或关闭就结束任务，`aoa close` 不可用；`status --refresh` 先去 GitHub 查 PR 状态。
