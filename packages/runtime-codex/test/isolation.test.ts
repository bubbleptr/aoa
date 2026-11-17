import { expect, test } from "bun:test";
import { isolationArgs } from "../src/connection.ts";

const disabledServers = (args: string[]) =>
  args.flatMap((a, i) => (args[i - 1] === "-c" ? [/^mcp_servers\.(.+)\.enabled=false$/.exec(a)?.[1]] : [])).filter(Boolean);

test("every MCP server the user configured is turned off, along with plugins, apps and hooks", () => {
  const args = isolationArgs(["nowledge-mem", "node_repl", "openaiDeveloperDocs"]);
  expect(disabledServers(args)).toEqual(["nowledge-mem", "node_repl", "openaiDeveloperDocs"]);
  for (const feature of ["plugins", "apps", "hooks"]) expect(args.join(" ")).toContain(`--disable ${feature}`);
});

test("a server name the override cannot address fails the run instead of leaving that server on", () => {
  // Codex splits `-c` paths on dots and does not unquote, so such a name would create a new, broken entry.
  expect(() => isolationArgs(["my.server"])).toThrow(/my\.server/);
  expect(() => isolationArgs(['"quoted"'])).toThrow();
});
