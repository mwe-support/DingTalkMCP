export const APPROVAL_TOOL_ACTIONS = [
  "view",
  "approve",
  "reject",
  "prepare",
  "submit",
  "comment",
  "revoke",
  "list_pending",
] as const;

export type ApprovalToolAction = (typeof APPROVAL_TOOL_ACTIONS)[number];

const APPROVAL_TOOL_ACTION_SET: ReadonlySet<string> = new Set(APPROVAL_TOOL_ACTIONS);

export function approvalToolAction(value: unknown): ApprovalToolAction | undefined {
  return typeof value === "string" && APPROVAL_TOOL_ACTION_SET.has(value)
    ? value as ApprovalToolAction
    : undefined;
}
