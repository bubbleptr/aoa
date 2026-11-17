# 参数、度量和测试

## 9. 参数

| 编号 | 取值 |
| --- | --- |
| `ACK_MAX` | 1 秒；没有 HTTP handler，C5 对着 `aoa send` 的追加路径测 |
| `LEASE` | 5 分钟，run 活着时每分钟续租；worker 死了租约才会过期 |
| `MAX_ATTEMPTS` | 3，之后进死信 |
| `RETRY_DELAYS_MS` | 30 秒、2 分钟：第一次和第二次失败后事件要等多久才能再被取走；第三次失败进死信 |
| `POLL_INTERVAL` | 定时器最长 60 秒；GitHub 60 秒 |
| `COMPACT_THRESHOLD` | 75% |
| D-EVT-1 | `next_run` |
| D-EVT-2 | 每个仓库一个 inbox |
| D-EVT-3 | 2 秒 debounce |
| D-TMR-1 | 只补最近一次 |
| D-TMR-3 | 自建轮询，单实例 |
| D-MEM-3 | 新 session 不带旧消息 |
| D-PRM-2 | 24 小时，到期写事件 |
| D-OUT-1 | outbox |
| D-OUT-3 | 每个 session 内保序 |

## 10. 怎么判断有没有用

自用两周，每项任务记三样，全部从已有的表推出，不另外埋点：

- 结局：合并、返工（交付之后又来了用户事件才合并）、丢弃。本地模式下「交付」是第一条送达的消息，合并或丢弃由 `aoa close` 声明；GitHub 模式下「交付」是 PR 开出，结局看 PR 的状态，没开出 PR 就关掉的算丢弃。
- 被问次数：`decisions` 里这个 session 裁决为 `defer` 的条数（`deferred` 表只留到答复或过期，不能数它）。
- 时长：第一个事件的 `received_at` 到交付。

`aoa status` 直接出这张表。

## 11. 测试

规范 §9 的验收项和它们的测试在哪：

| 验收项 | 测试在哪 | 说明 |
| --- | --- | --- |
| C1–C10、C14–C20 | `packages/conformance` | 真内核、真 SQLite，假 runtime 和假时钟，在命名的提交点崩溃 |
| C11 | 没有 | 压缩由 pi 自己做，内核看不到；靠常驻上下文里要求 agent 随时更新 `progress/` |
| C12 | `packages/sdk`（pi） | 恢复 transcript 后不重跑旧调用 |
| C13 | `apps/aoa` 的端到端测试 | 扫描模型收到的每个请求、每张表的每一行、数据目录下的每个文件、日志 |

C13 不保证「shell 读不到凭据」（§6）。模型的 API key 在 `serve` 读入后会从环境变量里删掉，所以 agent 的 shell 继承不到它；GitHub App 的私钥文件和 `~/.aoa` 仍然靠规则把关。C19 检查宿主放进上下文的最近消息，不检查 `reported.md`（§7）。

端到端测试经过和 `serve` 同一个装配函数，两种模式各一套，都用脚本模型和真 git。本地模式：没有 remote 的仓库，`send` 到分支上的提交、消息文件和通知、`aoa answer`、`send --to`、`close` 之后的收尾。GitHub 模式：内存里的假 GitHub 加本地裸仓库，issue 进到 PR 出、经评论审批、外部内容标记、PR 关闭后收尾。

标为 `POLICY` 的条目（`PointerNotCopy`、I-CTX-2）没法机械验证，测试通过不等于符合规范。
