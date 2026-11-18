# @aoa-dev/example-digest

一个不写代码的 agent：每天看一次仓库的 issue，有需要你知道或决定的才发消息，否则不出声。它只用 SDK 的原语，用来证明 SDK 不绑在编码上（设计 §15 第 6 步）。

- 没有 channel：消息写进 outbox 即算送出，从 `host.messages()` 读，或者 `host.watch` 到了再读。
- 没有工作目录、编码工具、记忆，不用 git。
- 工具只有两个：`recent_issues`（自上一次成功检查开始以来更新过的 issue，正文截到 1000 字）和 `notify`。issue 的文字是外人写的，所以它拿不到任何能改东西的工具。
- 每天的定时器用 `agent.schedule({ id: "daily" })`，重启不会多出一条。任务说明放在定时器的 payload 里，用哪个 runtime 都能送到模型。`anchor` 要传常量。
- issue 来源是 `IssueSource` 接口；`githubIssues` 读 GitHub REST 的一页（最多 100 条，去掉 PR）。

```ts
const host = createHost({ store: sqliteStore("digest.db") });
digestAgent(host, { inbox: "digest/o/r", runtime, issues: githubIssues({ owner: "o", repo: "r" }), anchor: Date.UTC(2026, 0, 1, 8) });
host.start();
```

测试只用 `agent.step`，模型是脚本：安静的一天、有事的一天、每次检查的时间窗、重启后定时器只有一条；另有一个子进程在 `PATH` 里没有 git、不在任何仓库里，经 pi 跑完一天。这些测试证明的是组装，不是模型对「值不值得说」的判断。

`src/main.ts` 能对真实仓库和模型跑（见文件开头），只做过类型检查，没有真跑过。

已知的不顺手：每次触发开一个新 session，跑完不关，SDK 没有「run 结束」的钩子可以在这里关掉它。
