# `sre/policies/` — SREFlow control plane

Deny-by-default policies that bind every SRE agent. Evaluated by OPA (preferred) or the ruflo WASM policy engine. Agents *ask*; the engine *decides*. There is no bypass.

## Files

| File | Purpose |
|---|---|
| [`tool_allowlist.yaml`](tool_allowlist.yaml) | Authoritative registry: every tool an SRE agent may request, its blast-radius class, environments, and required approvals. |
| [`blast_radius.rego`](blast_radius.rego) | Rules that evaluate a proposed tool call against the allowlist. |
| [`approvals.rego`](approvals.rego) | HITL matrix: how many human approvals are required as a function of (criticality tier, blast-radius class, environment). |
| [`environment_isolation.rego`](environment_isolation.rego) | Denies cross-environment calls (a `prod` agent invoking a `stage` tool, etc.). |
| [`freeze_windows.rego`](freeze_windows.rego) | Denies writes during declared change freeze windows. |

## Decision flow

```
tool call →
  blast_radius.allow    (is the tool in the allowlist? matches declared class?)
  environment_isolation.allow   (is the agent's env allowed to call this env's tool?)
  freeze_windows.allow  (is the window open for this class?)
  approvals.allow   (does the proposal carry the required human approvals?)
→ allow iff all four allow
```

## Break-glass

Destructive-class tools are never bound to any agent role in phases 0–3. The only path is a documented break-glass procedure requiring two humans + signed approval + explicit policy exception with a TTL. That procedure lives outside this tree (SSO-backed operator console), not in code agents can see.

## Testing

```bash
opa test sre/policies
opa eval -d sre/policies/ \
  --input tests/fixtures/policy/denied_prod_restart.json \
  'data.sreflow.allow'
```
