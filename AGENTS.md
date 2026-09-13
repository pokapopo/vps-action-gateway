# Workspace Memory

## Public repository and private local configuration

- Treat `/opt/vps-action-gateway/` as the public open-source repository.
- Files under `/opt/vps-action-gateway/interfaces.d/*.yaml` are deployment-specific local facility manifests. They are intentionally ignored by Git. Do not stage, commit, delete, overwrite, or sanitize them unless the user explicitly asks.
- Treat `/etc/vps-action-gateway/` as private deployment state. It may contain real environment values, credentials, policy, OAuth configuration, and facility manifests. Never commit its contents or copy real values into repository documentation or examples.
- Put reusable, sanitized facility samples in `examples/interfaces/` and deployment templates in `deploy/` using placeholder domains, paths, accounts, and secrets.
- Normal repository work may use `git add -A`, but never use `git add -f` to include ignored local configuration.
- Before every public commit or push, inspect the staged diff and scan it for secrets, real domains, private paths, account identifiers, session/thread IDs, and deployment-specific facility data.
- Preserve ignored local facility files across pulls, refactors, and repository cleanup.
