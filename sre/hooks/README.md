# `sre/hooks/` — guardrail hooks

Hooks are the last line of defense. Before any tool call leaves the agent, `pre-tool-policy-check.sh` runs. After every tool call, `post-tool-audit.sh` records the call to the immutable audit log.

## Files

| File | When | Purpose |
|---|---|---|
| [`hooks.json`](hooks.json) | — | Claude Code hook registrations. |
| [`pre-tool-policy-check.sh`](pre-tool-policy-check.sh) | PreToolUse | Calls OPA with the proposed tool invocation; exits non-zero if denied. |
| [`post-tool-audit.sh`](post-tool-audit.sh) | PostToolUse | Appends a signed record to the WORM audit stream. |

## How enforcement works

1. Agent attempts to call a tool (e.g., `mcp__k8s__restart_pod`).
2. Claude Code fires `PreToolUse` — our hook runs.
3. The hook reads the pending tool call + agent context from stdin, composes an OPA input, and calls `opa eval -d sre/policies/ 'data.sreflow.allow'`.
4. If `allow == false`, the hook exits non-zero and the tool call is blocked. The denial reason is surfaced to the agent AND written to the audit log.
5. If allowed, the tool call proceeds; `PostToolUse` writes a post-call record.

## Why a shell hook

The hook is intentionally minimal (jq + opa) so it can be inspected and reasoned about. The real complexity lives in Rego (auditable, testable). If the OPA binary is unavailable, the hook fails closed — the tool call is denied.
