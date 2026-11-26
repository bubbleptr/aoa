/**
 * Optional coding kit (design §15): the policy rules that guard file and shell tools. The kernel carries no rules
 * of its own; an agent that edits code adds these. The tools themselves are pi's, in `@aoa-dev/pi`.
 */
export { BRANCH_LIST_FLAGS, codingRules, commandOf, gitInvocations, ownWorktreeRelative } from "./rules.ts";
export { outsideWorktree } from "./worktree.ts";
