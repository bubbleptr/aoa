# @aoa-dev/example-tui

建在 `@aoa-dev/sdk` 和仓库内的 `@aoa-dev/pi` 上的极简终端对话 agent（约 150 行）。不被任何包引用，单文件组装即可看清全部原语怎么配合：

```bash
DEEPSEEK_API_KEY=... bun examples/tui/src/main.ts
# 或设 ANTHROPIC_API_KEY / OPENAI_API_KEY，或 AOA_PROVIDER + AOA_MODEL + AOA_API_KEY
```

- **直接对话 + 实时流式**：`reply: "final_text"` 让模型的回复自动进 outbox，`agent.activity` 实时输出思考、文字与工具调用。
- **规则放行 + 审批暂停**：装上 `@aoa-dev/pi` 的编码工具和 `@aoa-dev/sdk/tools/coding` 的规则，`read` 与只读 `bash` 直接跑；写文件或非常规命令由内核停下，从 `OutMsg.detail` 打出待批提示，输入 `/y` 批准、`/n [理由]` 拒绝。
- **待批期间不误拒**：`approvals: { by: "answer" }` 让审批只走 `/y` 和 `/n`；期间直接打字发补充说明会排进会话队列，等批准后一并交给下一次 run。
- **随时中断与重启恢复**：运行中按一次 Ctrl-C（或输入 `/abort`）调 `agent.abort` 中断当前 run 而不进死信；状态全在 `.aoa-tui/tui.db` 和记忆目录里，关掉重开接着聊，定时提醒（`wake_me_at`）到点照常唤醒。
