import { afterEach, expect, test } from "bun:test";
import { main } from "../src/main.ts";
import { KEY_ENV, World } from "./world.ts";

let worlds: World[] = [];
afterEach(() => {
  for (const w of worlds) w.dispose();
  worlds = [];
});

/** Runs `aoa serve` through `main` until the returned `stop` is called. */
async function serving(w: World, ...flags: string[]) {
  let out = "";
  let err = "";
  let printed: (text: string) => void = () => {};
  const firstLine = new Promise<string>((resolve) => (printed = resolve));
  let stop: () => void = () => {};
  const stopped = new Promise<void>((resolve) => (stop = resolve));
  const done = main(["serve", "--config", w.configPath, ...flags], {
    cwd: w.root,
    out: (t) => {
      out += `${t}\n`;
      printed(t);
    },
    err: (t) => {
      err += `${t}\n`;
      printed(t);
    },
    seams: { ...w.seams, env: { ...w.seams.env, [KEY_ENV]: "test-key" } },
    stopSignal: () => stopped,
  });
  const first = await Promise.race([firstLine, done.then((code) => `exited ${code}: ${err}`)]);
  return { first, out: () => out, err: () => err, stop: () => (stop(), done) };
}

test("serve also serves the page and prints its address", async () => {
  const w = await new World({ local: true }).start();
  worlds.push(w);
  const s = await serving(w, "--port", "0");

  const url = s.first.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0];
  expect(url).toBeDefined();
  expect((await fetch(`${url}/snapshot`)).status).toBe(200);

  expect(await s.stop()).toBe(0);
  await expect(fetch(`${url}/snapshot`)).rejects.toThrow();
});

test("a port in use leaves serve running without the page", async () => {
  const w = await new World({ local: true }).start();
  worlds.push(w);
  const taken = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("taken") });
  try {
    const s = await serving(w, "--port", String(taken.port));
    expect(s.first).not.toStartWith("exited");
    expect(s.err()).toContain(String(taken.port));
    expect(await s.stop()).toBe(0);
  } finally {
    taken.stop(true);
  }
});
