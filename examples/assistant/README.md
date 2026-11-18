# @aoa-dev/example-assistant

一个与后台编码工单（`apps/aoa`）互补的对话式示例：直接文字回复、结构化按钮审批卡片、单网关多 agent 路由，跑在零第三方依赖的 `@aoa-dev/sdk/loop` 上（不装 `pi`，不依赖 `git`，设计 §15 第 10 步）。

验证的四个能力：

- **直接对话回复（`reply: "final_text"`）**：模型输出的最终文字直接进 outbox（同样享受持久化、去重、限流与 `Already told the user` 防重），无需每次调 `notify`；常驻上下文不注入英文 `Stay quiet...`，与中文提示词不打架；模型返回空串时仍按 `silent` 结束（C18）。
- **结构化按钮审批（`OutMsg.detail` + `approvals: { by: "answer", ttlMs }`）**：通道直接读取 `m.detail`（`kind: "approval"`）渲染审批卡片，不解析英文 Markdown；用户在卡片待批期间继续发普通聊天消息补充说明时，消息排在会话队列里等按钮点击后一并进入下一次 run，不会把待批操作误判成 `deny`。
- **单网关多 agent 路由**：一个 `DeskGateway` 入口按规则把外部消息分给 `desk`（中文客服前台）和 `ops`（后台操作员），两个 agent 经 `send_to` 协作，出站消息统一回到同一个网关。
- **任意模型接入（`@aoa-dev/sdk/loop`）**：`src/openai.ts` 用原生 `fetch` 写了约 70 行的 OpenAI 兼容 Chat Completions 适配器，不装任何外部模型 SDK 即可接入 OpenAI、DeepSeek、OpenRouter 或本地模型。
