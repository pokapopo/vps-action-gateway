# VPS Action Gateway

Work-capable VPS gateway for ChatGPT Actions and MCP clients. Both public
adapters authenticate independently and forward to one privileged Unix-socket
backend. The backend alone owns path policy, command policy, SHA conflicts,
idempotency, job quotas, output limits, and redaction.

## Work contract

- Every operation returns one of `succeeded`, `accepted`,
  `waiting_confirmation`, `interrupted`, or `failed`.
- `next_action` is executable continuation data, not prose. Short commands wait
  up to `wait_seconds` (default 5) and return output inline; longer commands
  return `getJob` with the exact `job_id`.
- `applyPatch`, `writeFile`, `deletePath`, and service restarts accept a durable
  `idempotency_key`. Exact retries replay the original result; changed payloads
  fail with `IDEMPOTENCY_CONFLICT`; an unfinished persisted claim is reported as
  `IDEMPOTENCY_IN_DOUBT` and is never blindly replayed.
- `operationBatch` runs up to 16 independent calls concurrently across the full
  gateway catalog. Only recursive batches are rejected; each step still passes
  through the same backend policy.
- Normal responses omit `request_id` and `action_id`; pass `debug: true` when
  those correlation fields are needed.
- Command risk rules live in `/opt/vps-action-gateway/policy.yaml` and are
  evaluated in `deny -> confirm -> allow -> default` order. The default is
  confirmation, while the shell remains fully available after policy approval.
- Backend health and MCP `tools/list` load the same
  `/opt/vps-action-gateway/tool-catalog.js` source. `healthCheck` reports its
  live `tool_count`, ordered `tool_names`, and `tool_schema_revision`.
- Stateful Streamable HTTP sessions advertise `tools.listChanged`. The MCP
  adapter watches the shared catalog, reloads it in process after a real file
  change, and automatically sends `notifications/tools/list_changed` over the
  GET SSE stream. Clients can then refresh without reconnecting.

## Endpoints

- GPT Action REST: `http://127.0.0.1:8787/gpt/v1/...`
- MCP Streamable HTTP: `http://127.0.0.1:8788/mcp/`
- Public MCP: `https://action.uuhalo.xyz/mcp/`
- MCP v2 compatibility adapter: `http://127.0.0.1:8789/mcp-v2/`
- Public MCP v2: `https://action.uuhalo.xyz/mcp-v2/`
- OAuth authorization server: `https://action.uuhalo.xyz`
- OAuth v2 authorization server: `https://action.uuhalo.xyz/oauth-v2`
- Privileged backend: `/run/vps-action-gateway/backend.sock`

## Claude OAuth

Claude.ai uses a pre-registered confidential OAuth client, authorization code
flow, PKCE S256, audience binding to the public MCP URL, one-hour access tokens,
and rotating 30-day refresh tokens. Discovery is published through RFC 9728 and
RFC 8414 well-known endpoints. The only registered redirect URI is
`https://claude.ai/api/mcp/auth_callback`.

The client ID, client secret, signing secret, and the independent internal MCP
diagnostic key are stored only in `/etc/vps-action-gateway/keys.env`.

The current catalog covers workspace/system/log inspection, a purpose-built
root-backed read-only Cyberboss monitoring snapshot, file search/read/
patch/write/recoverable delete/restore, commands and jobs, systemd, Debian
packages, and concurrent batches. Writable/read roots and exceptional approval
behavior are configured only in the privileged backend service.

## MCP v2 compatibility layer

`/mcp-v2/` is additive and independently stoppable. It exposes exactly nine
stable top-level tools: `health`, `read`, `observe`, `edit`, `move_out`,
`execute`, `manage`, `operation`, and `discover`. Selectors are strings validated
against a server-side registry, not schema enums. Adding a backend capability
therefore changes `discover`, not `tools/list` or its fingerprint.

Every v2 call forwards to the existing Unix-socket backend. The adapter does not
implement file mutation, command execution, service/package operations, path
policy, SHA guards, idempotency, jobs, trash, or credential redaction.

### Custom VPS interfaces

The gateway keeps a stable ten-tool MCP surface while allowing local services
to be added through interface manifests. Copy a manifest into
`/etc/vps-action-gateway/interfaces.d/`; the first version supports `http` and
`command` transports. Credentials are referenced by environment variable and
are never placed in the manifest or returned to the model.

For example, an interface manifest can expose a local Milo service:

```yaml
name: milo
description: Milo conversation service
actions:
  chat:
    description: Send a message to Milo
    transport: http
    method: POST
    url: http://127.0.0.1:9000/chat
    bearer_env: MILO_API_TOKEN
    input_schema:
      type: object
      required: [message]
      properties:
        message:
          type: string
```

The MCP client calls one stable operation and the gateway resolves the
configured transport:

```json
{
  "action": "invoke",
  "arguments": {
    "interface": "milo",
    "method": "chat",
    "input": { "message": "你好" }
  }
}
```

`facilities` is the model-facing discovery entrypoint: call it before operating
an unknown local service, project, bot, or other custom facility. It returns
configured names, actions, input schemas, and the exact `operation(action=invoke)`
calling convention. Models must not guess facility/action names or bypass a
matching facility with `execute`. It is not required before every invocation,
so a client can call a known facility in one turn.

`discover` also includes the interface catalog for compatibility with existing
clients.

V2 Streamable HTTP is stateless: each POST handles `initialize`, `tools/list`,
or `tools/call` independently. It does not issue `Mcp-Session-Id`, keep SSE
streams, advertise `listChanged`, or depend on catalog notifications.

Model-critical payload appears in both bounded TextContent and bounded
`structuredContent`. File pages are kept below the text budget and continuations
are translated back to core-tool calls. A host which drops structured data can
still see file content, logs, search results, health catalog data, and the key
Cyberboss snapshot fields.

Gateway business approval is separate from Host tool confirmation. A backend
challenge becomes a short-lived `approval_id`; `operation` supports
`approval_prepare`, `approval_status`, and `approval_confirm`. The v2 server
stores the exact fingerprint and one-time backend challenge, injects backend
approval fields itself after semantic confirmation, persists consumption before
dispatch, and never logs token values or operation payloads. State is stored
mode `0600` under `/var/lib/vps-action-mcp-v2/`.

V2 can reuse the current OAuth registrations. If a separate ChatGPT connector
produces a different callback URL, configure the optional
`VPS_MCP_V2_CHATGPT_CLIENT_ID`, `VPS_MCP_V2_CHATGPT_CLIENT_SECRET`, and
`VPS_MCP_V2_CHATGPT_CALLBACK_URI` variables (and the analogous Claude variables
if desired); v2-specific values take precedence without changing v1.

Rollback requires only stopping `vps-action-mcp-v2.service` and removing or
disabling the additive Nginx v2 locations. `/mcp/` remains on its original
service and port throughout.
