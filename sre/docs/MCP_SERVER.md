# SREFlow MCP server — Claude Desktop integration

Conversational access to SREFlow from Claude Desktop (and any other MCP client) via a local stdio MCP server. Every SREFlow primitive — list agents, run the pipeline, curate a BP, render a diagram, propose a rename — is exposed as a tool the model can call.

## Why

Before this: "how do I interact with the agent" had two answers — a shell CLI (operator-only) or a Neo4j Browser tab (read-only queries). Neither lets you say:

> "Show me every business process in Portal Rofe without a human-set Hebrew name, propose renames for the top 5, and lock the ones I confirm."

The MCP server makes that one-prompt workflow routine. Credentials stay on the host; the conversation stays in Claude Desktop.

## Setup — one-time

### 1. Make sure SREFlow is running locally

```bash
cd /path/to/sreflow
docker compose -f docker-compose.phase0.yml up -d        # Neo4j + OPA
cd sre/runtime && npm install                            # SDK deps
```

Confirm with the CLI:

```bash
npx tsx bin/sreflow-agent.ts list
```

### 2. Configure Claude Desktop

Edit `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS):

```jsonc
{
  "mcpServers": {
    "sreflow": {
      "command": "npx",
      "args": [
        "tsx",
        "/Users/talgruenwald/projects/sre/sreflow/sre/runtime/bin/sreflow-mcp.ts"
      ],
      "env": {
        "NEO4J_URI":        "bolt://localhost:7687",
        "NEO4J_USER":       "neo4j",
        "NEO4J_PASSWORD":   "phase0-password-change-me",
        "OPA_URL":          "http://localhost:8181",
        "SREFLOW_USER":     "tal",
        "ANTHROPIC_API_KEY": "sk-ant-..."
      }
    }
  }
}
```

**Credential rules:**
- `ANTHROPIC_API_KEY` is only needed for `sreflow_propose_rename`. Omit it if you don't use LLM-assisted renaming; every other tool works without it.
- Never type any of these into the chat window. They live in the config only.
- The `SREFLOW_USER` value is stamped onto every `curatedBy` attribution and audit entry — set it to your identity.

### 3. Restart Claude Desktop

In the conversation, verify the connection:

> "Run sreflow_health."

You should see a JSON blob with `neo4j: "ok"`, `opa: "ok"`, audit + pause state paths, and whether the Anthropic key is present.

## What you can ask Claude Desktop to do

### Discovery

> "List the 5 tier-1 business processes in Maccabi Online, in English and Hebrew."

→ `sreflow_list_bps` with `scope: "feature"`, `tier: 1`, `name_contains: "..."` (Claude narrows as needed).

> "Show me the component map of תיק רפואי."

→ `sreflow_inspect_bp` with `bp: "תיק רפואי"`.

> "Render the 'Schedule Appointment' BP as a Hebrew Mermaid diagram."

→ `sreflow_render_bp` with `lang: "he"`, returned as a Mermaid string the client can render.

### Operate

> "Run the Phase-1 pipeline, dry-run first."

→ `sreflow_run_pipeline` with `dry_run: true`, then (after you confirm) again without.

> "Pause the dynatrace-collector while I'm investigating the last drift."

→ `sreflow_pause_agent`.

> "What's in the audit log for the last hour?"

→ `sreflow_audit_tail`.

### Curate

> "Rename bp-feature-maccabi-mdoc-components-phr to 'Personal Health Record' / 'תיק בריאות אישי', lock both names, and note the clinical PM approved it."

→ `sreflow_curate_bp` with `name`, `name_he`, `lock: ["name", "nameHe"]`, `note`, `user`.

> "Propose better names for the 10 BPs with the ugliest auto-discovered names. Use Sonnet for the first pass, Opus for the ones I reject."

→ Claude loops: `sreflow_list_bps` (locked_only=false, then filters client-side by heuristic) → `sreflow_propose_rename` (per BP) → `sreflow_curate_bp` on your approvals.

## Tool catalogue

**Reads** (no external mutation):

| Tool | Purpose |
|---|---|
| `sreflow_health` | Neo4j + OPA + audit reachability. Call first. |
| `sreflow_list_agents` | All agents, runnable / paused state, blast radius. |
| `sreflow_inspect_agent` | One agent in full: tools allowlist, envs, description. |
| `sreflow_list_bps` | Filter by scope, tier, name substring, locked-only. |
| `sreflow_inspect_bp` | Properties + components by role + host app + locked fields. |
| `sreflow_render_bp` | Mermaid (English or Hebrew with RTL). |
| `sreflow_audit_tail` | Last N audit entries. |
| `sreflow_report` | Kind = `changes` \| `stale` \| `locked` \| `curated`. |

**Writes** (every mutation audit-logged; agent runs OPA-gated):

| Tool | Purpose |
|---|---|
| `sreflow_run_agent` | One-shot a runnable agent. |
| `sreflow_run_pipeline` | Collector → resolver → analyst in one session. |
| `sreflow_pause_agent` / `sreflow_resume_agent` | Flag state. |
| `sreflow_curate_bp` | Human override: rename, tier, lock, add/remove components, note. |
| `sreflow_propose_rename` | LLM rename suggestion — preview only, does not apply. |

## Safety model

- **Write tools share the CLI's write paths.** Every BP edit via `sreflow_curate_bp` goes through the same reconciliation machinery the CLI uses — `lockedFields`, `addedBy`, `firstSeen`/`lastSeen` — so an MCP-driven rename is indistinguishable from a human-typed one in the audit trail (except the `detail` string carries `via=mcp`).
- **Agent runs are OPA-gated.** `sreflow_run_agent` wraps each tool call in a policy decision; a denial surfaces to the conversation as a structured error.
- **No destructive tools exposed.** The MCP surface is a strict subset of what the underlying agent runtime can do. There is no `delete_bp`, no `wipe_graph`, no raw Cypher write path.
- **Secrets never transit the chat.** Credentials are set once in `claude_desktop_config.json` env; the conversation never sees them.

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| `sreflow_health` reports `neo4j: unreachable` | Compose stack not up → `docker compose -f docker-compose.phase0.yml up -d` |
| `sreflow_health` reports `opa: unreachable` | OPA container not healthy → `docker restart sreflow-opa` |
| `sreflow_propose_rename` returns `ANTHROPIC_API_KEY not set` | Missing from the `env` block in `claude_desktop_config.json` |
| All tools return `server not connected` | Claude Desktop not restarted since config change |
| `sreflow_run_agent` returns `policy denied` | Expected — the denial reason is structured. Check the blast radius class of the tool the agent tried to call. |
