import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { LEASE_MS } from "../src/kernel.ts";
import { Harness, storeFactories } from "../src/index.ts";

for (const [name, factory] of storeFactories) {
  describe(`store [${name}]`, () => {
    let h: Harness;
    beforeEach(() => {
      h = new Harness(factory());
    });
    afterEach(() => h.dispose());

    test("a claim is refused while another run holds an unexpired lease in the inbox", () => {
      const a = h.append({ thread: "a" });
      const b = h.append({ thread: "b" });
      const now = h.clock.now();
      const claim = (id: string, run: string) =>
        h.connect().tx((t) => {
          t.insertSession({ id: `session-${run}`, inboxId: h.inboxId, createdAt: now });
          return t.claimEvents(h.inboxId, [id], run, `session-${run}`, now, now + LEASE_MS);
        });

      expect(claim(a.id, "run-a")).toBe(true);
      expect(claim(b.id, "run-b")).toBe(false);
      expect(h.store.tx((t) => t.getEvent(b.id))?.status).toBe("pending");
    });
  });
}
