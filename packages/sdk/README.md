# @aoa-dev/sdk

在 aoa 内核上搭长期运行的 agent：宿主、agent、定时器、审批、`send_to`，内置 pi 作为第一档 runtime。只支持 Bun（≥ 1.3），包里直接是 TypeScript 源码。

```sh
bun add @aoa-dev/sdk @aoa-dev/store-sqlite
```

完整能跑的例子（一个要批准才发邮件的 agent）见[仓库首页](https://github.com/bubbleptr/aoa#一个例子)。

- store 是必传的；channel 可选，不传时消息写入即算送出，从 `host.messages()` 读。
- 入口：`@aoa-dev/sdk`（宿主、agent、内核的类型和少量值）、`@aoa-dev/sdk/pi`（pi runtime）、`@aoa-dev/sdk/prompt`（第二档适配器共用的渲染）、`@aoa-dev/sdk/tools/coding`（可选的编码工具和规则）。
- pi 是可选的 peer 依赖：用 `@aoa-dev/sdk/pi` 或 `@aoa-dev/sdk/tools/coding` 时自己装 `@earendil-works/pi-ai`、`@earendil-works/pi-coding-agent` 和 `typebox`，其余入口不需要。
- 0.x 期间接口可能有破坏性改动。设计和每一步的取舍见仓库里的 `docs/design/sdk.md`。
