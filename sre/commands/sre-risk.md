---
name: sre-risk
description: Run the risk scorer on demand and return the ranked findings for a business process. Does not file tickets automatically.
---

# /sre-risk

Invokes the `sre-risk-scorer` agent against a business process (or the whole portfolio if no argument is given) and returns a ranked list of findings with evidence.

## Usage

```
/sre-risk [<process-name>]
```

Findings are drafts only. Use `/sre-approve` to promote selected findings into ticket creation via the `improvement-proposer` agent.

Read-only at invocation time. Ticket creation (if you opt to promote findings) is policy-gated `write-low`.
