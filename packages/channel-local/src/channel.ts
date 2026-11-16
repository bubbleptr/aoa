import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Channel, OutMsg } from "@aoa/kernel";

/** Shows a message to the user outside the file, e.g. a desktop notification. */
export type Notifier = (title: string, body: string) => Promise<void>;

export type LocalChannel = Channel & {
  /** A new thread key for a task given on this machine. */
  openThread(): string;
};

export type LocalChannelOptions = {
  /** Where every message is appended: the source of truth. */
  file: string;
  notify?: Notifier;
  log?: (line: string) => void;
};

const NOTIFY_LIMIT = 200;

const markerOf = (dedupeKey: string) => `<!-- aoa:${dedupeKey} -->`;

/** Messages go to a Markdown file plus a best-effort notification; answers come from `aoa` commands, so poll finds nothing. */
export function localChannel(o: LocalChannelOptions): LocalChannel {
  return {
    async poll() {
      return { events: [], cursor: "local" };
    },

    async deliver(m: OutMsg) {
      const marker = markerOf(m.dedupeKey);
      // Redelivery after a failure finds its own entry and adds nothing (I-OUT-2).
      if (existsSync(o.file) && readFileSync(o.file, "utf8").includes(marker)) return;
      const lines = [`## ${new Date(m.createdAt).toISOString()} · ${m.thread ?? "-"} · ${m.kind}`, "", disarm(m.body)];
      if (m.kind === "approval_request" && m.callId !== null) {
        lines.push("", `Answer with \`aoa answer ${m.callId} approve\` or \`aoa answer ${m.callId} deny <reason>\`.`);
      }
      lines.push("", marker, "", "");
      mkdirSync(dirname(o.file), { recursive: true });
      appendFileSync(o.file, lines.join("\n"));

      if (!o.notify) return;
      const title = m.kind === "approval_request" ? `aoa needs your answer (${m.thread ?? "-"})` : `aoa (${m.thread ?? "-"})`;
      const body = m.body.length > NOTIFY_LIMIT ? `${m.body.slice(0, NOTIFY_LIMIT - 1)}…` : m.body;
      try {
        await o.notify(title, body);
      } catch (err) {
        o.log?.(`notification for ${m.kind} ${m.id} failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    },

    openThread() {
      const bytes = crypto.getRandomValues(new Uint8Array(4));
      return `local:${Buffer.from(bytes).toString("hex")}`;
    },
  };
}

/** The body is model-written; a marker inside it must not count as the marker of another message. */
const disarm = (body: string) => body.replaceAll("<!-- aoa:", "<!-- aoa\\:");

const NOTIFY_SCRIPT = ["on run argv", "display notification (item 1 of argv) with title (item 2 of argv)", "end run"].join("\n");

/** The command line of a macOS notification. The text goes in as arguments, so nothing in it is ever run as script. */
export function darwinNotifyArgv(title: string, body: string): string[] {
  return ["osascript", "-e", NOTIFY_SCRIPT, body, title];
}

/** The platform's notifier: a macOS notification on darwin, none elsewhere. */
export function defaultNotifier(platform: string = process.platform): Notifier | undefined {
  if (platform !== "darwin") return undefined;
  return async (title, body) => {
    const proc = Bun.spawn(darwinNotifyArgv(title, body), { stdout: "ignore", stderr: "pipe" });
    const code = await proc.exited;
    if (code !== 0) throw new Error(`osascript exited with ${code}: ${(await new Response(proc.stderr).text()).trim()}`);
  };
}
