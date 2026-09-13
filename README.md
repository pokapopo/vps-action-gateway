# VPS Action Gateway

[简体中文](README.zh-CN.md) · [Full setup guide](docs/open-source-usage-guide.md)

Give Chat a controlled execution layer over MCP: operate a VPS, continue long-running jobs, and connect browsers or internal services through a stable facility interface.

## Highlights

- Read logs, search and edit files, run commands, and manage jobs, services, and packages.
- Continue long work with a durable `job_id` and executable `next_action`.
- Separate the low-privilege MCP adapter from the execution backend over a local Unix socket.
- Enforce path and command policy, approvals, SHA guards, idempotency, output bounds, and redaction in the backend.
- Add facilities with YAML manifests instead of growing the top-level MCP tool list.

## Architecture

```text
ChatGPT / Claude / MCP client
              |
              | HTTPS + Streamable HTTP
              v
      MCP adapter (low privilege)
              |
              | Unix socket
              v
      execution backend (policy + state)
              |
              +-- files / commands / jobs / systemd
              +-- custom facilities (HTTP or fixed commands)
```

The recommended `mcp-v2/` endpoint is stateless and exposes ten stable tools:

`health`, `read`, `observe`, `edit`, `move_out`, `execute`, `manage`, `operation`, `facilities`, and `discover`.

## Quick start

Requires Linux and Node.js 22+. Production deployments should use systemd, HTTPS, and a dedicated low-privilege account.

```bash
git clone https://github.com/pokapopo/vps-action-gateway.git
cd vps-action-gateway
npm ci
npm test
```

Install and customize the templates:

```bash
sudo useradd --system --home /nonexistent --shell /usr/sbin/nologin vpsagent
sudo install -d -m 0750 /etc/vps-action-gateway/interfaces.d
sudo install -o root -g vpsagent -m 0640 deploy/vps-action-gateway.env.example /etc/vps-action-gateway/gateway.env
sudo install -o root -g root -m 0644 deploy/policy.example.yaml /etc/vps-action-gateway/policy.yaml
sudo install -m 0644 deploy/vps-action-backend.service /etc/systemd/system/
sudo install -m 0644 deploy/vps-action-mcp-v2.service /etc/systemd/system/
```

If `vpsagent` already exists, skip the `useradd` command.

After editing `gateway.env`:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now vps-action-backend vps-action-mcp-v2
```

Customize the [Nginx example](deploy/nginx-mcp.conf.example), then add this URL to an MCP client:

```text
https://mcp.example.com/mcp-v2/
```

See the [full guide](docs/open-source-usage-guide.md) for OAuth, configuration, and client setup.

## Custom facilities

Unknown facilities are discovered through `facilities` and invoked through `operation(action=invoke)`. The [browser example](examples/interfaces/browser.yaml) assumes a separately deployed, loopback-only browser API:

```yaml
name: local_browser
actions:
  open_page:
    transport: http
    method: POST
    url: http://127.0.0.1:9333/api/open
    bearer_env: BROWSER_CONTROL_TOKEN
    input_schema:
      type: object
      required: [path]
```

Keep tokens, cookies, browser profiles, and deployment-specific endpoints out of source control.

## Security notes

- Start with the smallest possible read/write roots.
- Keep command policy at `default: confirm` and explicitly allow safe reads.
- Restrict facilities to fixed endpoints or commands; validate inputs again in the facility service.
- Use `idempotency_key` for mutations. Never interpret `accepted` as final success.
- Test browser automation with a dedicated account and isolated profile.

## License

[MIT](LICENSE) © 2026 pokapopo
