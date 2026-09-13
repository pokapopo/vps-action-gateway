# VPS Action Gateway

[English](README.md) · [详细使用与接入指南](docs/open-source-usage-guide.md)

让 Chat 通过 MCP 在 VPS 上真正干活，并用一套稳定接口连接浏览器、内网服务和其他自定义设施。

## 它能做什么

- 查日志、搜索和修改文件、运行命令、管理任务、服务与软件包。
- 长任务返回 `job_id` 和可执行的 `next_action`，可以继续查询或取消。
- MCP 接入层与执行后端分离：公网服务可使用低权限账户，系统操作通过本机 Unix Socket 转交后端。
- 路径与命令策略、审批、SHA 冲突、幂等、输出限制和脱敏都在后端执行。
- 通过 YAML manifest 接入设施，不必为每个服务新增 MCP 顶层工具。

## 架构

```text
ChatGPT / Claude / MCP 客户端
              |
              | HTTPS + Streamable HTTP
              v
       MCP adapter（低权限）
              |
              | Unix Socket
              v
       执行后端（策略 + 状态）
              |
              +-- 文件 / 命令 / Job / systemd
              +-- 自定义设施（HTTP 或固定命令）
```

推荐使用 `mcp-v2/`。它是无状态 Streamable HTTP 服务，并保持 10 个稳定顶层工具：

`health`、`read`、`observe`、`edit`、`move_out`、`execute`、`manage`、`operation`、`facilities`、`discover`。

## 快速开始

需要 Linux 和 Node.js 22+。生产部署建议使用 systemd、HTTPS 反向代理及专用低权限账户。

```bash
git clone https://github.com/pokapopo/vps-action-gateway.git
cd vps-action-gateway
npm ci
npm test
```

安装并修改公开模板：

```bash
sudo useradd --system --home /nonexistent --shell /usr/sbin/nologin vpsagent
sudo install -d -m 0750 /etc/vps-action-gateway/interfaces.d
sudo install -o root -g vpsagent -m 0640 deploy/vps-action-gateway.env.example /etc/vps-action-gateway/gateway.env
sudo install -o root -g root -m 0644 deploy/policy.example.yaml /etc/vps-action-gateway/policy.yaml
sudo install -m 0644 deploy/vps-action-backend.service /etc/systemd/system/
sudo install -m 0644 deploy/vps-action-mcp-v2.service /etc/systemd/system/
```

如果系统中已经存在 `vpsagent`，跳过 `useradd`。

编辑 `gateway.env` 后启动：

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now vps-action-backend vps-action-mcp-v2
```

将 [Nginx 示例](deploy/nginx-mcp.conf.example)中的域名和证书换成自己的值，再将 MCP 地址添加到客户端：

```text
https://mcp.example.com/mcp-v2/
```

OAuth、环境变量和客户端接入细节见[详细指南](docs/open-source-usage-guide.md)。

## 自定义设施

未知设施先通过 `facilities` 发现，再由 `operation(action=invoke)` 调用。[浏览器示例](examples/interfaces/browser.yaml)假设你已部署一个仅监听本机的受控浏览器 API：

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

manifest 只引用环境变量名；不要提交 token、cookie、浏览器 profile 或真实登录信息。

## 安全提示

- 从最小读写目录开始，不要默认开放整个文件系统。
- 保持命令策略 `default: confirm`，只明确允许已验证的只读命令。
- 设施应使用固定 endpoint 或固定命令，并在设施服务自身再次校验输入。
- 变更操作使用 `idempotency_key`；不能把 `accepted` 当成最终成功。
- 浏览器自动化先使用测试账号和隔离 profile。

## License

[MIT](LICENSE) © 2026 pokapopo
