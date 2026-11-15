import { mkdirSync } from "node:fs";
import { mkdir, readFile, readdir, realpath, rename, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import type { ToolDef } from "./types.ts";

/** The agent's memory (spec §5): a directory of files that outlives every run. Paths are relative to its root. */
export interface Memory {
  /** Throws if the file does not exist. */
  read(path: string): Promise<string>;
  /** Replaces the file in one step, creating its directories. */
  write(path: string, content: string): Promise<void>;
  /** The entries directly in `dir` (default: the root) as root-relative paths, directories ending in `/`. Empty if `dir` does not exist. */
  list(dir?: string): Promise<string[]>;
  exists(path: string): Promise<boolean>;
}

const isMissing = (err: unknown): boolean => (err as NodeJS.ErrnoException).code === "ENOENT";

const partsOf = (path: string): string[] => path.split(/[\\/]+/).filter((p) => p !== "" && p !== ".");

/** Memory on the local disk under `root`, which is created if needed. Nothing outside the root is reachable, symlinks included. */
export function dirMemory(root: string): Memory {
  mkdirSync(root, { recursive: true });
  const realRoot = realpath(root);

  /** The absolute path for `path`, after checking that it and whatever part of it exists stay inside the root. */
  async function resolve(path: string): Promise<string> {
    if (typeof path !== "string") throw new Error("memory path must be a string");
    if (isAbsolute(path) || path.startsWith("~")) throw new Error(`memory paths are relative to the memory root: ${path}`);
    const parts = partsOf(path);
    if (parts.includes("..")) throw new Error(`memory paths may not contain "..": ${path}`);
    const base = await realRoot;
    const full = join(base, ...parts);
    for (let probe = full; ; probe = dirname(probe)) {
      try {
        const real = await realpath(probe);
        const rel = relative(base, real);
        if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
          throw new Error(`memory path leads outside the memory root: ${path}`);
        }
        return full;
      } catch (err) {
        if (!isMissing(err)) throw err;
      }
    }
  }

  return {
    async read(path) {
      return readFile(await resolve(path), "utf8");
    },
    async write(path, content) {
      const full = await resolve(path);
      await mkdir(dirname(full), { recursive: true });
      // A reader sees the old file or the new one, never half of it.
      const temp = `${full}.${crypto.randomUUID()}.tmp`;
      await writeFile(temp, content, "utf8");
      await rename(temp, full);
    },
    async list(dir = "") {
      const full = await resolve(dir);
      let entries;
      try {
        entries = await readdir(full, { withFileTypes: true });
      } catch (err) {
        if (isMissing(err)) return [];
        throw err;
      }
      const prefix = partsOf(dir).map((p) => `${p}/`).join("");
      return entries.map((e) => prefix + e.name + (e.isDirectory() ? "/" : "")).sort();
    },
    async exists(path) {
      try {
        await stat(await resolve(path));
        return true;
      } catch (err) {
        if (isMissing(err)) return false;
        throw err;
      }
    },
  };
}

/** The user's file: loaded on every run, never changed by the agent (spec §5.2). */
const isInstructions = (path: string): boolean => {
  const parts = partsOf(path);
  return parts.length === 1 && parts[0]!.toLowerCase() === "instructions.md";
};

/** Agent tools over the memory directory: `memory_read`, `memory_write`, `memory_list`. */
export function memoryTools(memory: Memory): ToolDef[] {
  const pathSchema = { type: "string", description: "Path relative to the memory root, e.g. notes/user.md." };
  return [
    {
      name: "memory_read",
      description: "Read a file from your memory directory.",
      schema: { type: "object", properties: { path: pathSchema }, required: ["path"], additionalProperties: false },
      idempotent: true,
      async execute(args) {
        return memory.read((args as { path: string }).path);
      },
    },
    {
      name: "memory_write",
      description:
        "Create or replace a file in your memory directory. Keep only what cannot be looked up again; " +
        "for issues, PRs and commits store a pointer, not a copy. Update index.md when you add or remove a file. " +
        "instructions.md belongs to the user and cannot be written.",
      schema: {
        type: "object",
        properties: { path: pathSchema, content: { type: "string", description: "The whole new content of the file." } },
        required: ["path", "content"],
        additionalProperties: false,
      },
      async execute(args) {
        const { path, content } = args as { path: string; content: string };
        if (typeof content !== "string") throw new Error("content must be a string");
        if (isInstructions(path)) throw new Error("instructions.md is the user's file; you cannot change it");
        await memory.write(path, content);
        return { written: path };
      },
    },
    {
      name: "memory_list",
      description: "List the entries of a directory in your memory (default: the root). Directories end in /.",
      schema: {
        type: "object",
        properties: { dir: { type: "string", description: "Directory relative to the memory root." } },
        additionalProperties: false,
      },
      idempotent: true,
      async execute(args) {
        return memory.list((args as { dir?: string }).dir);
      },
    },
  ];
}
