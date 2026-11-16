import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { migrate } from "../src/schema.ts";

const version = (db: Database) => (db.query("PRAGMA user_version").get() as { user_version: number }).user_version;

test("a database written by a newer aoa is refused and left as it was", () => {
  const db = new Database(":memory:");
  migrate(db);
  const latest = version(db);
  db.exec(`PRAGMA user_version = ${latest + 1}`);

  expect(() => migrate(db)).toThrow(new RegExp(`newer aoa.*${latest + 1}.*${latest}`));
  expect(version(db)).toBe(latest + 1);
  db.close();
});
