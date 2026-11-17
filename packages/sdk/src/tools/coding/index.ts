/**
 * Optional coding kit (design §15): the file and shell tools, and the policy rules that guard them. The kernel
 * carries no rules of its own; an agent that edits code adds these.
 */
export { BRANCH_LIST_FLAGS, codingRules, commandOf, gitInvocations, ownWorktreeRelative } from "./rules.ts";
export { outsideWorktree } from "./worktree.ts";
// Interim: lives in the pi runtime until step 3 of design §15 makes the built-in pi tool-free.
export { codingTools } from "@aoa/runtime-pi";
