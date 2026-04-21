# `sre/connectors/` — connector configuration templates

These are **templates**. They declare connection shape, scopes, rate limits, and refresh cadences. Secrets never live in this tree.

## Secret resolution

At runtime, SREFlow loads the equivalent of each `*.yaml.example` from your secret store (Vault / AWS Secrets Manager / Azure Key Vault) and overlays it onto the template. The loader fails closed if any required secret is missing.

## Workflow

1. Copy `x.yaml.example` → `x.yaml.local` (gitignored) for local-only testing.
2. In production, create the secret in the secrets manager with the same key layout.
3. Register the secret path in `sreflow` config (`config/secrets.yaml`).
4. Restart the daemon; `doctor` validates all connectors.

## Per-source scopes (least-privilege reminder)

| Source | Scope | Write? |
|---|---|---|
| Dynatrace | Token scoped to entities.read, problems.read, slo.read, metrics.read, logs.read | never |
| SolarWinds | SWIS user with read-only NPM/SAM/NCM/IPAM | never |
| BMC Helix | API user with read on CMDB, Incidents, Changes, Problems, Business Services | never |
| BMC Discovery | Read-only API token on the ADDM appliance | never |
| Confluence | Service account scoped to in-scope spaces only | never |
| SharePoint | Site-scoped AppOnly token | never |
| Notion | Integration with read access to selected workspaces | never |
| GDrive | Service account with drive.readonly on a specific shared drive | never |
| Jira | Read attachments + watch tickets; no edit | never |

## Gitignore

Add to repo `.gitignore`:

```
sre/connectors/*.local.yaml
sre/connectors/*.yaml
!sre/connectors/*.yaml.example
```
