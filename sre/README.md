# `sre/` — SREFlow overlay

Everything that makes this fork an SRE platform lives under this directory. See [../SREFLOW.md](../SREFLOW.md) for the top-level vision.

## Conventions

- **Additive only.** No files outside `sre/` are modified by SREFlow work, so upstream merges from `ruvnet/ruflo` stay clean.
- **No secrets in this tree.** Connector configs are templates (`*.yaml.example`). Real secrets live in Vault/Secrets Manager and are loaded at runtime.
- **Every agent is scoped.** Each agent YAML declares the exact tools it may call. The control plane enforces this; it is not advisory.
- **Writes are proposals.** Agents in Layers 1 and 2 never mutate external systems. Layer 3 writes go through the approval pipeline in [`policies/`](policies).

## Directory map

```
sre/
├── agents/
│   ├── collectors/     ← Dynatrace, SolarWinds, BMC Discovery, BMC Helix, docs
│   ├── graph/          ← entity resolver, business-process analyst
│   ├── sre/            ← risk scorer, SLO analyst, improvement proposer
│   └── incident/       ← commander + diagnostic specialists + remediator
├── policies/           ← Rego rules + tool allowlist (control plane)
├── schema/             ← Neo4j KG schema + canonical entity JSON Schema
├── skills/             ← SKILL.md packs loaded by agents
├── hooks/              ← PreToolUse / PostToolUse enforcement + audit
├── connectors/         ← per-source config templates (no secrets)
├── commands/           ← slash commands
├── runtime/            ← @sreflow/runtime TS modules (entity resolver, tests)
├── docs/               ← operator runbooks (Phase 0 bring-up, etc.)
└── CLAUDE.md           ← behavioral guidance when operating on SRE tasks
```

## Getting started (developer)

1. Install plugin dependencies (ruflo base already installed).
2. Copy `connectors/*.yaml.example` to `connectors/*.yaml` and fill in via your secret store.
3. Load OPA policies: `opa eval -d sre/policies/ 'data.sreflow.allow'`.
4. Apply the KG schema: `cypher-shell < sre/schema/kg_schema.cypher`.
5. Start with Phase 0 — only collectors + graph + diagrams. No write agents should be enabled.

## Adding a new connector

1. Add a collector agent under `sre/agents/collectors/`.
2. Add a template under `sre/connectors/<source>.yaml.example`.
3. Register the tools in `sre/policies/tool_allowlist.yaml` with the correct blast-radius class — default is `read`.
4. Extend `sre/schema/entity_schema.json` with any new `SAME_AS` source identifier.
5. Add integration tests under `tests/sreflow/connectors/`.
