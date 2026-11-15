# aoa

按规范从头写的 always-on agent 内核。第一件事是写代码：issue 进，PR 出，只在需要你的时候找你。

- [设计文档](docs/design.md)
- [规范](docs/spec.md)

状态：内核、SQLite 存储、pi 适配器、GitHub 通道和 `aoa` 命令都已实现，端到端测试在本地假 GitHub 和脚本模型上跑通；还没在真实仓库上用过。

## 用法

准备：

- [Bun](https://bun.sh)，在仓库根目录运行 `bun install`。
- 一个 GitHub App，装到目标仓库上，权限给 Issues、Pull requests、Contents 的读写。把私钥文件放在本机。
- 模型的 API key 放在环境变量里，例如 `ANTHROPIC_API_KEY`。

把 `aoa.config.example.ts` 复制成 `aoa.config.ts` 再改。配置里只写环境变量名和私钥路径，不写密钥。

```bash
bun run aoa serve                      # 常驻：轮询 GitHub，跑任务，发评论；Ctrl-C 停
bun run aoa send "修掉 README 的错字"  # 用 App 开一个带标签的 issue 作为任务
bun run aoa answer <调用 id 或前缀> approve|deny [理由]
bun run aoa status [--json] [--refresh]  # 各任务的状态、结局、被问次数、到 PR 的时长
```

给 issue 加上配置里的标签（默认 `aoa`），agent 就会接手。只有配置里那个登录名的话算数，其他人的 issue 和评论只当外部材料。

agent 需要你批准时，会在 issue 或 PR 上发一条评论。直接回复：

- `/approve`：批准，被延后的调用执行一次。
- `/deny 理由`：拒绝，理由会转给 agent。

也可以在本机用 `aoa answer` 回答，id 从 `aoa status` 里看。
