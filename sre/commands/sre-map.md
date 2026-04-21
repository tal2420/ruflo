---
name: sre-map
description: Refresh the component map and diagram for a business process. Read-only.
---

# /sre-map

Regenerates the knowledge-base page + Mermaid diagram for a business process by walking the canonical entity graph.

## Usage

```
/sre-map <process-name> [--hops N]
```

Calls the `map-business-process` skill. Returns the KB page URL and a short summary.

Read-only. Does not propose or execute any changes.
