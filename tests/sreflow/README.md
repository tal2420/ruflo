# `tests/sreflow/` — SREFlow test suite

## Policy tests

Rego tests live under [`policies/`](policies). They mock `input` and `data` inline so each test is self-contained.

```bash
# Local
opa test sre/policies/ tests/sreflow/policies/ -v

# Just the SREFlow tests
opa test tests/sreflow/policies/ -v
```

Tests cover:

- `blast_radius_test.rego` — allow/deny across read / write-low / write-high / destructive, approvals, unknown tools, cross-env.
- `approvals_test.rego` — HITL matrix for each (class, tier) combination + two-person rule.
- `environment_isolation_test.rego` — same-env, cross-env, corp-read exception.
- `freeze_windows_test.rego` — outside/inside windows, tier + env scoping, `allow_classes` exception.

## Adding a policy test

1. Add a `_test.rego` file in the same or adjacent package.
2. Use `with input as {...}` and `with data as {...}` (or `with data.x.y as ...`) to mock.
3. A failing test appears as `FAIL` in `opa test -v` output.

## Fixtures for manual inspection

[`fixtures/`](fixtures) contains JSON inputs useful for manually reproducing a case:

```bash
opa eval -d sre/policies/ --input tests/sreflow/fixtures/deny_prod_restart_no_approvals.json \
  'data.sreflow.blast_radius.allow'
opa eval -d sre/policies/ --input tests/sreflow/fixtures/deny_prod_restart_no_approvals.json \
  'data.sreflow.blast_radius.deny_reason'
```
