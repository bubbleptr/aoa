import { afterEach, expect, test } from "bun:test";
import { sqliteStore } from "../../src/sqlite/index.ts";

const opened: { close(): void }[] = [];
afterEach(() => {
  for (const s of opened.splice(0)) s.close();
});

test("nested tx calls run in the outer transaction and notify watchers once on commit", async () => {
  const store = sqliteStore(":memory:");
  opened.push(store);
  let seen = 0;
  store.watch(() => seen++);

  store.tx((outer) => {
    outer.insertSession({ id: "s1", inboxId: "in", createdAt: 1 });
    store.tx((inner) => {
      expect(inner.getSession("s1")).not.toBeNull();
      inner.insertSession({ id: "s2", inboxId: "in", createdAt: 2 });
    });
  });

  await Bun.sleep(0);
  expect(seen).toBe(1);
  expect(store.tx((t) => t.listSessions("in").map((s) => s.id))).toEqual(["s1", "s2"]);

  expect(() =>
    store.tx(() => {
      store.tx((inner) => inner.insertSession({ id: "s3", inboxId: "in", createdAt: 3 }));
      throw new Error("rollback outer");
    }),
  ).toThrow(/rollback outer/);
  await Bun.sleep(0);
  expect(seen).toBe(1);
  expect(store.tx((t) => t.listSessions("in").map((s) => s.id))).toEqual(["s1", "s2"]);
});

test("store.app migrates an application's own tables by namespace, refuses newer app schemas, and notifies watch on write", async () => {
  const store = sqliteStore(":memory:");
  opened.push(store);
  let seen = 0;
  store.watch(() => seen++);

  const v1 = store.app({
    namespace: "desk",
    migrations: ["CREATE TABLE desk_notes (id TEXT PRIMARY KEY, body TEXT NOT NULL)"],
  });
  const insert = v1.db.query("INSERT INTO desk_notes (id, body) VALUES (?, ?)");
  v1.write(() => insert.run("n1", "hello"));
  await Bun.sleep(0);
  expect(seen).toBe(1);

  const v2 = store.app({
    namespace: "desk",
    migrations: [
      "CREATE TABLE desk_notes (id TEXT PRIMARY KEY, body TEXT NOT NULL)",
      "ALTER TABLE desk_notes ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0",
    ],
  });
  const row = v2.db.query<{ id: string; body: string; pinned: number }, [string]>("SELECT id, body, pinned FROM desk_notes WHERE id = ?").get("n1");
  expect(row).toEqual({ id: "n1", body: "hello", pinned: 0 });

  expect(() =>
    store.app({
      namespace: "desk",
      migrations: ["CREATE TABLE desk_notes (id TEXT PRIMARY KEY, body TEXT NOT NULL)"],
    }),
  ).toThrow(/newer.*desk/);
});
