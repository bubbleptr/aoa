import type { OutMsg } from "./channel.ts";
import type { Memory } from "./memory.ts";
import type { SessionId } from "./types.ts";

/** How many delivered messages the resident context repeats as "already told the user" (D-MEM-3, design §7). */
export const RESIDENT_RECENT_MESSAGES = 5;
/** The cap on instructions.md and index.md in the resident context, in characters (I-CTX-3). */
export const RESIDENT_FILE_LIMIT = 16_000;

const DONT_REPEAT = `The messages under "Already told the user" were delivered; do not repeat them.`;

/** How an agent with or without memory speaks to the user when silence is the default. */
const QUIET = `Stay quiet unless the user needs to know or decide something. Ending a run without a message is normal. ${DONT_REPEAT}`;

const MEMORY_LAYOUT = `You work in many separate runs. This context is rebuilt at the start of each one from your memory, a directory of files that outlives every run:

- instructions.md: the user's instructions to you. Follow them. Only the user changes this file.
- index.md: the index of notes/ and progress/. Keep it current when you add, rename or remove a file.
- notes/: what you have learned about the user and the project, in small files. Read them with memory_read when you need them.
- progress/<session id>.md: one file per task, with what is done and what is left. Your own file is named below.

Store only what cannot be looked up again. For anything you can look up again, store a pointer (a number, URL or hash), not a copy: a copy goes stale.

Keep your progress file up to date as you work, not only at the end. Older parts of this conversation may be compacted away, and the progress file is how a later run picks up where you left off.`;

/**
 * The preamble of an agent with memory. Fixed, so the prefix of every run's context is byte-identical and stays in
 * the prompt cache. An agent without memory gets only the last paragraph (design §15).
 */
export const RESIDENT_PREAMBLE = `${MEMORY_LAYOUT}

${QUIET}`;

function capped(path: string, content: string): string {
  if (content.length <= RESIDENT_FILE_LIMIT) return content;
  return (
    content.slice(0, RESIDENT_FILE_LIMIT) +
    `\n\n[truncated: ${path} has ${content.length} characters; only the first ${RESIDENT_FILE_LIMIT} are shown. Read the rest with memory_read.]`
  );
}

/**
 * The resident context of a run (spec §5.2, design §7), in this order: the preamble, instructions.md, index.md,
 * this session's progress file, and what was already told to the user. Everything up to the progress file
 * is the same for every session of the inbox. With `quiet: false` (conversational mode), the "Stay quiet" directive is
 * omitted so an agent without memory or prior deliveries gets no English boilerplate at all.
 */
export async function buildResident(
  memory: Memory | undefined,
  sessionId: SessionId,
  sent: OutMsg[],
  o: { quiet?: boolean } = {},
): Promise<string> {
  const quiet = o.quiet ?? true;
  const sections: string[] = [];
  if (memory) {
    sections.push(quiet ? RESIDENT_PREAMBLE : MEMORY_LAYOUT);
    for (const path of ["instructions.md", "index.md"]) {
      if (await memory.exists(path)) sections.push(`## ${path}\n\n${capped(path, await memory.read(path))}`);
    }
    const progress = `progress/${sessionId}.md`;
    // Named even when it does not exist yet: it is how the agent learns where its progress goes.
    const body = (await memory.exists(progress)) ? await memory.read(progress) : "(not written yet)";
    sections.push(`## ${progress} (your progress file)\n\n${body}`);
  } else if (quiet) {
    sections.push(QUIET);
  }
  if (sent.length > 0) {
    if (!quiet) sections.push(DONT_REPEAT);
    const lines = sent.map((m) => `- ${new Date(m.createdAt).toISOString()}${m.thread ? ` on ${m.thread}` : ""}: ${m.body}`);
    sections.push(`## Already told the user\n\n${lines.join("\n")}`);
  }
  return sections.join("\n\n");
}
