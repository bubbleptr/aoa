# @aoa-dev/sdk

在 aoa 内核上搭长期运行的 agent：宿主、agent、定时器、审批、`send_to`，内置 pi 作为第一档 runtime。只支持 Bun（≥ 1.3），包里直接是 TypeScript 源码。

```sh
bun add @aoa-dev/sdk
```

完整能跑的例子（一个要批准才发邮件的 agent）见[仓库首页](https://github.com/bubbleptr/aoa#一个例子)。

- `sqliteStore` 内置在 `@aoa-dev/sdk`（也挂在 `@aoa-dev/sdk/sqlite`），直接走 Bun 内置的 `bun:sqlite`，零第三方依赖；`createHost({ store })` 接收 `HostStore` 接口。
- 默认是后台静默模式（只有调 `notify` 才发消息，thread 回复可答审批）；对话和卡片类应用可传 `reply: "final_text"` 和 `approvals: { by: "answer", ttlMs }`，并从 `OutMsg.detail` 读结构化的审批和死信信息。
- 入口：`@aoa-dev/sdk`（宿主、agent、`sqliteStore`、内核的类型和少量值）、`@aoa-dev/sdk/sqlite`（同 `sqliteStore`）、`@aoa-dev/sdk/loop`（零外部依赖的第一档 tool-loop runtime，接任意模型 SDK 或 `fetch`）、`@aoa-dev/sdk/pi`（pi runtime）、`@aoa-dev/sdk/prompt`（第二档适配器共用的渲染）、`@aoa-dev/sdk/tools/coding`（可选的编码工具和规则）。
- pi 是可选的 peer 依赖：只有用 `@aoa-dev/sdk/pi` 或 `@aoa-dev/sdk/tools/coding` 时才装 `@earendil-works/pi-ai`、`@earendil-works/pi-coding-agent` 和 `typebox`；用 `@aoa-dev/sdk/loop` 不需要。
- 0.x 期间接口可能有破坏性改动。设计和每一步的取舍见仓库里的 `docs/design/sdk.md`。
