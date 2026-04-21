---
name: sre-incident
description: Spawn the incident response swarm in diagnostics-only mode. No remediation without human approval.
---

# /sre-incident

Spawns the incident response swarm. The `incident-commander` agent owns the incident; read-only diagnostics agents execute in parallel; a remediation proposal is composed and presented to the on-call human.

## Usage

```
/sre-incident --page <page-id>
/sre-incident --service <service> --window "last 30m"
```

All diagnostic tool calls are `read` class. Any remediation requires the human-approvals specified by `sre/policies/approvals.rego` for the affected business process's criticality tier.
