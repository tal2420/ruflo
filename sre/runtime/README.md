# `@sreflow/runtime`

Self-contained Node/TypeScript runtime modules used by SREFlow agents.

## Modules

| Module | Purpose |
|---|---|
| `entity-resolver` | Fuses source-system entities into canonical identities via a matcher chain (deterministic → probabilistic → embedding → consensus). Pure; no I/O. |

## Running tests

```bash
cd sre/runtime
npm install
npm test
```

## Design principles

- **Pure functions.** Every module should be unit-testable without a network, a database, or a clock.
- **No side effects in imports.** Import a module; nothing happens.
- **No deps at runtime** unless there's a strong reason. Keep the attack surface tight.
