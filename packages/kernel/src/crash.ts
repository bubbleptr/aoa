/** Commit points where conformance tests kill the process (design §5). */
export type CrashPoint = "after_append" | "after_claim" | "after_tool_exec" | "after_tool_result" | "before_complete";

export type CrashHook = (point: CrashPoint) => void;

/**
 * Thrown by a test crash hook in place of the process dying.
 * The kernel lets it propagate and writes nothing to the store on the way out.
 */
export class SimulatedCrash extends Error {
  constructor(readonly point: CrashPoint) {
    super(`simulated crash at ${point}`);
    this.name = "SimulatedCrash";
  }
}
