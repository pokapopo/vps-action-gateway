# VPS Action Gateway：MCP 使用与设施接入指南

**项目地址：** https://github.com/pokapopo/vps-action-gateway

**作者 / 维护者：** pokapopo

**定位：** 让 Chat 通过 MCP 在 VPS 上真正执行任务，并用统一接口连接浏览器、内网服务和其他自定义设施。

## 1. 项目简介

VPS Action Gateway 是一个面向 ChatGPT、Claude 等 MCP 客户端的执行网关。模型负责理解需求和选择工具；网关负责在服务器上执行文件操作、命令、任务和设施调用。

它解决的不是“让 AI 生成一条命令”，而是让任务真正进入执行链路：短任务直接返回结果；耗时任务返回 `job_id`，客户端可以继续查询、取回输出或取消任务。

## 2. 为什么使用它

- **真正执行工作：** 查日志、读写文件、运行命令、管理任务和服务。
- **长任务可续接：** `accepted` 表示仍在运行，客户端根据 `job_id` 和 `next_action` 继续追踪。
- **权限分层：** MCP 服务以低权限账户运行，需要系统权限的操作经 Unix Socket 交给独立后端。
- **策略在后端生效：** 路径范围、命令规则、审批、输出限制和敏感信息脱敏不依赖提示词。
- **重试更安全：** 写入、补丁、删除和服务重启等操作支持 `idempotency_key`，避免网络重试造成重复变更。
- **设施可扩展：** 新服务通过 YAML manifest 注册，不需要为每个服务增加一组 MCP 顶层工具。

## 3. 架构

```text
Chat / MCP client
        |
        | HTTPS + MCP Streamable HTTP
        v
MCP adapter（低权限账户）
        |
        | Unix domain socket
        v
执行后端（策略、任务、文件与服务操作）
        |
        +-- VPS workspace / logs / services
        +-- 自定义设施（固定 HTTP 接口或固定命令）
```

公网只暴露 MCP endpoint。执行后端只监听本机 Unix Socket，不对公网开放。

## 4. 安装与启动

### 4.1 前置条件

- Linux VPS，建议使用 systemd。
- Node.js 22 或更高版本。
- 支持 HTTPS 的域名；仅在本地或私网测试时可以暂时省略。
- 一个低权限服务账户，例如 `vpsagent`。

### 4.2 安装代码

```bash
git clone https://github.com/pokapopo/vps-action-gateway.git
cd vps-action-gateway
npm ci
npm test
```

### 4.3 配置运行目录

在受限权限的环境文件中填写自己的路径。可以从 `deploy/vps-action-gateway.env.example` 复制；以下仅为示例，不要直接照搬生产目录：

```ini
VPS_ACTION_SOCKET=/run/vps-action-gateway/backend.sock
VPS_ACTION_WORKSPACE_ROOTS=/srv/ai-workspace
VPS_ACTION_READ_ROOTS=/srv/ai-workspace:/var/log
VPS_ACTION_JOB_ROOT=/var/lib/vps-action-gateway/jobs
VPS_ACTION_TRASH_ROOT=/var/lib/vps-action-gateway/trash
VPS_ACTION_POLICY_PATH=/etc/vps-action-gateway/policy.yaml
VPS_ACTION_IDEMPOTENCY_PATH=/var/lib/vps-action-gateway/idempotency.json
VPS_MCP_V2_HOST=127.0.0.1
VPS_MCP_V2_PORT=8789
```

写入目录应从最小范围开始，只加入确实需要由 Chat 修改的 workspace。密钥、SSH、浏览器 profile 和 `.env` 不应加入可读写目录。

### 4.4 运行服务

推荐拆成两个 systemd 服务：

- `vps-action-backend`：执行后端，按需要授予系统权限。
- `vps-action-mcp-v2`：低权限 MCP adapter，连接后端 Socket。

两个服务必须使用相同的 `VPS_ACTION_SOCKET`。启动后检查：

```bash
sudo systemctl enable --now vps-action-backend vps-action-mcp-v2
sudo systemctl status vps-action-backend vps-action-mcp-v2
```

环境文件建议设为 `root:vpsagent`、权限 `0640`，让 root 后端和低权限 MCP adapter 都能读取，但不对其他系统用户开放。

然后用 Nginx、Caddy 或其他反向代理将本机 MCP 地址发布为 HTTPS，例如：

```text
https://mcp.example.com/mcp-v2/
```

如需公网连接，应配置 OAuth、精确的回调 URL 白名单和 TLS；不要把内部诊断密钥或 Unix Socket 暴露到公网。

## 5. 连接 MCP 客户端

在 ChatGPT、Claude 或其他支持 Streamable HTTP 的 MCP 客户端中添加公开 endpoint。连接完成后：

1. 调用 `health`，确认后端、版本和工具目录可用。
2. 调用 `discover`，查看核心能力。
3. 操作未知本地设施前调用 `facilities`，获取准确的设施名、动作名和输入 schema。

不要让模型猜设施名称或参数；设施已存在时，也不应绕过它改用任意命令执行。

## 6. 基本调用

### 6.1 运行任务

```json
{
  "name": "execute",
  "arguments": {
    "action": "run",
    "command": "npm test",
    "cwd": "/srv/ai-workspace"
  }
}
```

若返回状态为 `accepted`，任务尚未结束。使用返回的 `job_id` 查询：

```json
{
  "name": "execute",
  "arguments": {
    "action": "status",
    "job_id": "<job_id>"
  }
}
```

最终状态以 `succeeded`、`failed` 或 `interrupted` 为准。

### 6.2 安全重试变更

```json
{
  "name": "edit",
  "arguments": {
    "action": "write",
    "path": "/srv/ai-workspace/README.md",
    "content": "# Updated documentation\n",
    "idempotency_key": "update-readme-001"
  }
}
```

同一次业务操作重试时复用原 key；新的内容或新的目标必须使用新 key。

## 7. 自定义设施：接入浏览器

假设你已有一个只监听 `127.0.0.1` 的浏览器控制服务。它保留登录态，并提供经过限制的 HTTP API，例如列出标签页、打开允许的站内页面。可以将它注册为 facility，让 Chat 调用能力，但不接触 cookie、浏览器 profile 或控制令牌。

### 7.1 安全前提

- 浏览器 API 仅监听回环地址或私网。
- 服务端限制可访问域名、动作和响应大小。
- 不提供任意 JavaScript、任意 shell 或任意 URL 代理。
- 使用专用浏览器 profile 和测试账号。
- 登录态与 token 不写入 manifest，也不返回给模型。

### 7.2 编写 manifest

保存为 `/etc/vps-action-gateway/interfaces.d/browser.yaml`：

```yaml
name: local_browser
description: 受控浏览器设施；用于查看标签页和打开允许的站内页面
actions:
  list_tabs:
    description: 列出当前标签页的标题和地址摘要
    transport: http
    method: GET
    url: http://127.0.0.1:9333/api/tabs
    bearer_env: BROWSER_CONTROL_TOKEN
    input_schema:
      type: object

  open_page:
    description: 打开服务端允许的站内相对路径
    transport: http
    method: POST
    url: http://127.0.0.1:9333/api/open
    bearer_env: BROWSER_CONTROL_TOKEN
    input_schema:
      type: object
      required: [path]
      properties:
        path:
          type: string
          description: 站内相对路径，例如 /notifications
```

在仅服务可读的环境文件中设置令牌：

```ini
BROWSER_CONTROL_TOKEN=<replace-with-a-secret>
```

manifest 只引用环境变量名，不保存真实 token。

### 7.3 发现与调用

先获取设施目录：

```json
{ "name": "facilities", "arguments": {} }
```

再使用统一入口调用浏览器：

```json
{
  "name": "operation",
  "arguments": {
    "action": "invoke",
    "interface": "local_browser",
    "method": "open_page",
    "input": { "path": "/notifications" }
  }
}
```

新增其他设施时沿用同一模式：定义名称、动作、固定 transport 和输入 schema，不需要修改 MCP 顶层工具列表。

## 8. 命令策略与上线检查

命令按 `deny -> confirm -> allow -> default` 匹配。建议保持 `default: confirm`，只明确允许已验证的只读命令，并拒绝会切断网关控制面的操作。

上线前至少确认：

- [ ] MCP adapter 使用低权限账户，执行后端不暴露公网。
- [ ] Unix Socket 只有所需服务账户组可访问。
- [ ] 读写根目录已最小化，不包含凭证或浏览器 profile。
- [ ] 命令默认需要确认，deny / allow 规则已经过真实样本测试。
- [ ] 变更操作使用幂等键，客户端正确处理 `accepted` 和 `job_id`。
- [ ] 设施只调用固定 endpoint 或固定命令，token 只存在于环境变量。
- [ ] 已运行 `npm test`，并通过 `health` 检查。

## 9. 常见问题

- **MCP 无法连接：** 检查 TLS、反向代理路径、OAuth 回调 URL 和 adapter 监听地址。
- **后端不可用：** 检查 Socket 是否存在、所属组是否正确，以及两个服务的 Socket 路径是否一致。
- **设施没有出现：** 检查 YAML、文件权限、transport 与输入 schema，然后重新调用 `facilities`。
- **操作被拒绝：** 检查 workspace 根目录、敏感路径审批和命令策略。
- **任务一直显示运行中：** 使用返回的 `job_id` 查询状态；`accepted` 不是最终成功。

VPS Action Gateway 的目标，是给 Chat 增加一层可控、可续接、可扩展的执行能力：模型理解意图，网关执行策略，设施连接真实工具。
