// English copies of the diagram pages. Strings are swapped longest-first within each board, so
// a phrase is replaced before any shorter phrase it contains. English is shortened where a literal
// translation would wrap inside its tile.

const common: Record<string, string> = {
  '<html lang="zh">': '<html lang="en">',
};

const boards: Record<string, Record<string, string>> = {
  sdk: {
    "在 Bun 上搭常驻 agent": "always-on agents on Bun",
    "你的应用": "Your app",
    "调用 host 和 agent": "calls host and agent",
    "五个原语；可以有多个，用 send_to 互发": "five primitives; several agents talk via send_to",
    "两档": "two tiers",
    "事件、审批答复": "events, answers",
    "定时器": "timers",
    "读消息": "reads messages",
    "收事件": "takes events",
    "认领事件，开 run": "claims, runs",
    "定时唤醒": "wakes on time",
    "指令 · 笔记 · 进度": "notes · progress",
    "消息和审批请求": "sends messages",
    "规则 · 风险 · 分类器": "decides each call",
    "你的 ToolDef · 内置工具 · send_to · 可选的编码工具": "your ToolDefs · built-ins · send_to · coding",
    "全部状态在一个文件里，所有 agent 共用": "all state in one file, shared by every agent",
    "第一档 · 内置": "TIER 1 · BUILT-IN",
    "第二档 · 外部 HARNESS": "TIER 2 · EXTERNAL HARNESS",
    "SDK 只给接口；这两个是 examples/ 里的适配器": "interface only; both adapters live in examples/",
    "审批请求": "approvals",
    "工具调用": "tool calls",
    "事件": "events",
    "定时": "timers",
    "消息": "messages",
    "到期": "due",
    "加载": "loads",
    "放行": "allowed",
  },
  architecture: {
    "认领事件，开 run": "claims, runs",
    "通过 MCP 接入": "via MCP",
    "收事件": "takes events",
    "定时唤醒": "wakes on time",
    "指令 · 笔记 · 进度": "notes · progress",
    "消息和审批请求": "sends messages",
    "裁决工具调用": "decides tool calls",
    "全部状态在一个文件里": "all state in one file",
    "工具调用都经过内核": "all calls via kernel",
    "一个常驻 agent 的内核": "an always-on agent kernel",
    "可接多种": "more kinds to come",
    "五个原语": "five primitives",
    "可接多个 Harness": "more harnesses can plug in",
    "外部 HARNESS": "EXTERNAL HARNESS",
    "用自己的工具和沙箱，审批经内核转给你": "own tools and sandbox; approvals reach you",
    "审批请求": "approvals",
    "工具调用": "tool calls",
    "入口": "Entry",
    "内核": "Kernel",
    "任务": "tasks",
    "消息": "messages",
    "到期": "due",
    "加载": "loads",
  },
  "tool-call": {
    "一次工具调用怎么走": "How a tool call goes",
    "Jev 影子判断": "Jev shadow judge",
    "先打分，再接管裁决": "scores, then decides",
    "agent 在 pi 里发起": "made by the agent in pi",
    "策略 + 分类器裁决": "rules + classifier decide",
    "执行，写进日志": "runs, and is logged",
    "把原因还给 agent": "the reason goes back",
    "保存会话，run 结束": "session saved, run ends",
    "发出审批请求": "sends the request",
    "批准或拒绝": "approve or deny",
    "答复变成一个事件": "the answer is an event",
    "恢复会话": "Resume session",
    "执行这次调用，只许一次": "runs the call once",
    "agent 调 git_push": "agent: git_push",
    "参数里没有凭据": "no credentials in args",
    "宿主进程": "Host process",
    "发请求时加上凭据": "adds the credentials",
    "推送、开 PR": "push, open PR",
    "要批准一个操作": "needs approval",
    "自动审查": "Auto review",
    "Codex 自己决定": "Codex decides",
    "Permissions 的三种结果": "Three outcomes of Permissions",
    "延后时 run 结束，答复回来再接着做": "on defer the run ends, and picks up when the answer comes back",
    "等答复时，Worker 照常处理别的事件": "while it waits, the Worker keeps handling other events",
    "凭据不进 agent": "Credentials stay out of the agent",
    "GitHub 模式": "GitHub mode",
    "模型的 API key 在 serve 读入后从环境变量里删掉；shell 命令提到 ~/.aoa 或凭据路径时延后，交给你。":
      "The model's API key is removed from the environment once serve has read it; shell commands that mention ~/.aoa or credential paths are deferred to you.",
    "Codex 上的审查 agent": "a review agent on Codex",
    "不经过内核，也不问你；其他 Codex agent 要问的审批，照常经 Permissions 转给你。":
      "Skips the kernel and doesn't ask you; approvals from other Codex agents still reach you through Permissions.",
    "工具调用": "Tool call",
    "允许": "Allow",
    "拦截": "Block",
    "延后": "Defer",
    "通知你": "notifies you",
    "新 run": "new run",
    "答复": "answer",
    "你": "You",
  },
  "multi-agent": {
    "多 agent：每个 agent 一个 inbox": "Multiple agents: one inbox each",
    "通过 MCP 接入": "via MCP",
    "只收自己的": "own events",
    "一次一个 run": "one at a time",
    "写代码、推分支": "writes code",
    "只读，给结论": "reads, reports",
    "两个 agent 共用一个库，每张表按 inbox_id 分": "both agents share one database; every table is keyed by inbox_id",
    "实现 agent": "Implementation agent",
    "审查 agent": "Review agent",
    "入口": "Entry",
    "派活": "task",
    "结论": "findings",
  },
};

// Arrow labels sit in narrow centered boxes; let longer English overflow evenly and never wrap.
const extraCss = `[style*="text-align: center"] { display: flex; justify-content: center; white-space: nowrap; }
[style*="line-height: 16px"] { white-space: nowrap; }
</style>`;

export function english(html: string, board: string): string {
  const table = { ...common, ...boards[board] };
  const keys = Object.keys(table).sort((a, b) => b.length - a.length);
  let s = html;
  for (const k of keys) s = s.split(k).join(table[k]!);
  s = s.replace("</style>", extraCss);
  const left = s.replace(/<style>[\s\S]*?<\/style>/, "").match(/[一-鿿]+/g);
  if (left) throw new Error(`${board}: untranslated ${[...new Set(left)].join(", ")}`);
  return s;
}
