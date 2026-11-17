# aoa 设计文档

- 状态：已实现。本地模式在一次性仓库上用真实模型（DeepSeek flash）冒烟跑通过一次；GitHub 模式只在假 GitHub 和脚本模型上跑过，还没接过真实的 GitHub App
- 日期：2026-11-16
- 规范：[spec.md](../spec.md)（下文的 §、I-*、C*、D-* 编号都指它）

## 1. 要做什么

aoa 是按规范从头写的 always-on agent 内核，第一件事是写代码：一条 `aoa send` 进来，agent 在自己的 worktree 里改，提交到本地分支，只在需要你的时候找你。

默认是本地模式，不需要 GitHub：消息写到本地文件并发桌面通知，分支由你自己合并。配置里加上 `github` 一节才接 GitHub（带标签的 issue 进、评论出、推送并开 PR）。两种模式的差别都在 §8。

它要回答一个问题：只保留规范里的五个原语，不加任何外围，能不能提高生产力。所以第一版刻意精简，并且从第一天起记录能回答这个问题的数（§10）。

### 不做

界面、收件对话、插件系统、推送服务、沙箱、多用户、公网 webhook 入口、记忆的定期整理。加进来只会让「结构本身有没有用」的结论变浑。

其中「插件系统」在 §15 部分改变：aoa 要变成内核层的 SDK，runtime、channel、工具、策略这些端口对外开放。界面仍然不在 aoa 里，要做也是建在 SDK 上的应用。

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

## 目录

章节编号保持不变，代码注释里的「design §N」照旧能找到。

| 文件 | 内容 |
| --- | --- |
| [README.md](README.md) | §1 要做什么、§2 用法 |
| [architecture.md](architecture.md) | §3 结构、§4 数据、§5 流程 |
| [permissions.md](permissions.md) | §6 权限 |
| [memory-and-outbox.md](memory-and-outbox.md) | §7 记忆、§8 发件 |
| [parameters-and-tests.md](parameters-and-tests.md) | §9 参数、§10 怎么判断有没有用、§11 测试 |
| [decisions.md](decisions.md) | §12 实现中定下的（零散的决定） |
| [agents.md](agents.md) | §12 具名 agent |
| [reviewer.md](reviewer.md) | §12 审核模型、影子判断 Jev |
| [observe.md](observe.md) | §12 观察页 `aoa web`、主会话接入 `aoa mcp` |
| [harness.md](harness.md) | §12 权限归 harness 的 agent、Codex runtime、dsh runtime |
| [status.md](status.md) | §13 没验证的、§14 暂缓 |
| [sdk.md](sdk.md) | §15 内核层 SDK（已定，未实现） |
