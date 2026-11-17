# aoa

- 设计在 `docs/design/`（`README.md` 是目录），规范在 `docs/spec.md`。实现和规范不一致的地方记在设计文档里，不改规范。
- 开始阶段直接提交并推送 `main`，不走 PR。
- Bun + TypeScript，monorepo。测试用 `bun test`。
- 规范 §9 的 C1–C20 是验收项：每个原语先写失败的一致性测试再实现。
- 文档用中文，代码和标识符用英文。
- 仓库是公开的。`docs/spec.md` 只转述原文，逐字引用只留少量短句，并注明出处。
