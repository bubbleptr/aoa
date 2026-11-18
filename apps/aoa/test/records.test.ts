import { afterEach, expect, test } from "bun:test";
import { sqliteStore } from "@aoa/store-sqlite";
import { records } from "../src/records.ts";

const opened: { close(): void }[] = [];
afterEach(() => {
  for (const s of opened.splice(0)) s.close();
});

test("the app's own writes reach the store's watch, so the observation page sees a judgment as it lands", async () => {
  const store = sqliteStore(":memory:");
  opened.push(store);
  store.tx((t) => t.insertSession({ id: "s1", inboxId: "in", createdAt: 0 }));
  let seen = 0;
  store.watch(() => seen++);

  records(store).judgments.record({ callId: "c1", sessionId: "s1", model: "m", p: 0.9, latencyMs: 5, error: null, at: 1 });
  await Bun.sleep(0);
  expect(seen).toBe(1);
  records(store).pulls.set("s1", { number: 1, state: "open", checkedAt: 2 });
  await Bun.sleep(0);
  expect(seen).toBe(2);
});
