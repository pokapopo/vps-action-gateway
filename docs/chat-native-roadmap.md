# 官端丝滑操作 VPS：后续计划

## 目标

让用户在官方 ChatGPT、Claude 等客户端里，通过一个 MCP 连续操作 VPS，尽量减少“推一步走一步”。未来接入 Milo 等自定义设施时，不为每个设施新增一套 MCP 工具。

## 当前基础

- MCP v2 保持 9 个稳定顶层工具。
- 文件、命令、服务、包、日志、进程和批处理已经由同一个特权后端执行。
- 普通调用不再经过二次业务审批；后端挑战会在同一次 MCP 调用内完成。
- 长命令超过默认等待时间后进入后台，返回 `job_id` 和 `next_action`。
- `discover` 和服务端 registry 已经可以在不改变顶层工具 schema 的情况下扩展能力。

## 第一阶段：减少后台任务导致的中断

### 问题

命令当前默认只等待 5 秒。超过 5 秒后返回 `accepted`，需要 Chat 再调用 `execute(action=status)`。Chat 有时会提前总结或等待用户继续推动。

### 实现

1. 只在 MCP v2 的 `execute(action=run)` 中，将未显式设置的 `wait_seconds` 默认值提高到 20 秒。
2. 用户显式传入 `wait_seconds` 时尊重原值；`0` 仍表示立即转后台。
3. 保持后端上限 30 秒和 IPC 超时 35 秒不变。
4. 命令超过 20 秒仍未完成时，返回简洁的运行状态、`job_id` 和标准化的下一步调用。
5. 优化 `accepted` 的文本结果，明确告诉模型任务尚未完成，应立即查询状态，不能当作成功总结。
6. 不在 MCP HTTP 请求中无限轮询，避免触发官方客户端超时。

### 验证

- 5～20 秒内完成的命令只产生一次 MCP 工具调用，并直接返回最终输出。
- 显式 `wait_seconds: 0` 仍立即返回后台任务。
- 超过 20 秒的任务仍可通过现有 `execute(action=status)` 查询和取消。
- 失败、超时、取消、输出截断和脱敏行为保持不变。
- 增加测试，并通过完整 `npm test`。

### 局限

这只能减少“后台 job 查询”造成的中断。需要读取结果后再决定下一步的任务，仍由 Chat 自己推理，不在此阶段引入内部 Agent。

## 第二阶段：自定义设施统一接口

### 目标

让 Milo、机器人、面板、家庭设施和自建服务通过配置接入，不为每个设施新增 MCP 顶层工具。

### 对外调用

复用现有 `operation`，新增一个稳定动作：

```json
{
  "action": "invoke",
  "arguments": {
    "interface": "milo",
    "method": "chat",
    "input": {
      "message": "你好"
    }
  }
}
```

一次调用完成一次设施操作。正常使用不强制先调用 `discover`，避免 Chat 被拆成两步；只有模型不知道能力或用户询问可用功能时才使用 `discover`。

### 配置方式

每个设施提供一份 YAML，例如：

```yaml
name: milo
description: Milo 对话服务
actions:
  chat:
    description: 与 Milo 对话
    transport: http
    method: POST
    url: http://127.0.0.1:9000/chat
    auth_env: MILO_API_TOKEN
```

第一版只支持两种传输：

- `http`：调用本机或内网 HTTP API。
- `command`：调用固定的可执行文件及参数模板。

### 内部改动

1. 新增 `interface-registry.js`，加载 `/etc/vps-action-gateway/interfaces.d/*.yaml`。
2. registry 校验设施名称、动作、输入 schema、传输方式和超时。
3. 特权后端新增一个通用 `invokeInterface` 动作。
4. `mcp-v2/router.js` 将 `operation(action=invoke)` 映射到该动作。
5. `discover` 可返回设施及动作的简短描述，但限制数量和响应大小。
6. 密钥只能引用环境变量，不能直接写入 YAML，也不能出现在日志和返回值中。
7. 复用现有超时、输出截断、脱敏、幂等和 job 机制。

### 决策难度控制

- 不为每个设施增加顶层工具。
- `operation.invoke` 的语义保持唯一，不和 `execute`、`manage` 重叠。
- 接口描述使用用户语言，例如“与 Milo 对话”，不暴露 URL 等实现细节。
- 默认直接调用已知设施，不把 `discover` 设计为必经步骤。
- 一次只返回与当前设施相关的少量能力，避免把完整接口库塞给模型。

### 验证

- 新增设施只需要添加 YAML 和密钥配置，不修改 MCP tool schema。
- Chat 能用一次工具调用完成一次 Milo HTTP 请求。
- 未知设施、未知动作和错误参数返回清晰错误，不执行任何请求。
- HTTP 超时、非 2xx、命令失败和大输出能正确归一化。
- 日志不出现认证信息和完整敏感输入。
- 接入第二个测试设施，证明实现没有写死 Milo。

## 暂不实施

- 不在 MCP 内部加入另一个大模型。
- 不让 MCP 自主拆解任意多步骤目标。
- 不开放任意 URL、任意命令或直接携带密钥的配置。
- 第一版不支持 WebSocket、数据库直连和第三方插件市场。

## 推荐顺序

1. 先完成第一阶段，直接改善官端连续执行体验。
2. 用一个本地 mock HTTP 服务实现第二阶段最小版本。
3. 接入 Milo 作为第一个真实案例。
4. 接入第二种不同设施，验证通用性。
5. 最后更新 README、安装方式和开源示例配置。
