# 钉钉 MCP 开发平台部署方案

## 架构结论

`MWE审批MCP` 只使用钉钉 MCP 开发平台托管的对外 MCP 网关：

```text
客户端 --Streamable HTTP--> mcp-gw.dingtalk.com
       --平台内部转发--> 我们部署的 HTTPS 工具动作
       --OpenAPI--> api.dingtalk.com
```

- 对外 MCP Server URL：官方文档说明服务通过钉钉统一网关；2026-08-12 从钉钉官方 MCP 市场实际取得的配置使用 `streamable-http`，主机为 `mcp-gw.dingtalk.com`。这可确认网关由钉钉托管，但 `MWE审批MCP` 尚未发布，其最终具体 URL 仍需在首次发布后核验。
- 工具动作 URL：由我们托管。钉钉 MCP 开发平台的 `HTTP` 创建方式要求为每个工具配置普通 HTTP API；该 URL 不是 MCP Server URL，也不会提供给 MCP 客户端。
- 本项目不暴露 `/mcp`，不使用 Deap 自定义 MCP URL，也没有自托管 MCP 回退。
- 不提供 stdio。

官方说明：

- [钉钉 MCP 广场介绍](https://open.dingtalk.com/document/development/mcp-square-introduction)：服务经钉钉统一网关，平台负责升级、替换、监控和 SLA 等治理。
- [阿里云百炼使用钉钉 MCP 服务](https://open.dingtalk.com/document/development/alibaba-cloud-uses-dingtalk-mcp-services)：客户端配置类型为 Streamable HTTP。

## 本项目后端配置

部署时注入平台到后端的随机密钥，至少 32 UTF-8 字节：

```text
MCP_PLATFORM_API_KEY=<仅供钉钉平台调用工具动作的密钥>
```

反向代理必须提供 HTTPS，并把实际后端域名加入 `APPROVAL_BACKEND_ALLOWED_HOSTS`。不要把 Node.js 明文端口直接暴露到公网。

钉钉平台中每个工具的 HTTP 设置相同：

```text
方法: POST
URL: https://<后端域名>/platform/tools/<toolName>
Header: Authorization: Bearer <MCP_PLATFORM_API_KEY>
Content-Type: application/json
Body: 工具参数对象
```

`MCP_PLATFORM_API_KEY` 是平台到我们后端的鉴权；它与 MCP 客户端访问钉钉网关时使用的凭据不是同一个概念。

## 工具端点

| 工具 | 后端路径 |
|---|---|
| `get_approval_capabilities` | `/platform/tools/get_approval_capabilities` |
| `get_processInstance_detail` | `/platform/tools/get_processInstance_detail` |
| `query_process_instance_ids` | `/platform/tools/query_process_instance_ids` |
| `get_processInstance_records` | `/platform/tools/get_processInstance_records` |
| `list_pending_tasks` | `/platform/tools/list_pending_tasks` |
| `list_user_visible_process` | `/platform/tools/list_user_visible_process` |
| `get_process_schema` | `/platform/tools/get_process_schema` |
| `forecast_process` | `/platform/tools/forecast_process` |
| `start_process_instance` | `/platform/tools/start_process_instance` |
| `approve_processInstance` | `/platform/tools/approve_processInstance` |
| `reject_processInstance` | `/platform/tools/reject_processInstance` |
| `revoke_processInstance` | `/platform/tools/revoke_processInstance` |
| `list_approval_attachments` | `/platform/tools/list_approval_attachments` |
| `download_approval_attachment` | `/platform/tools/download_approval_attachment` |

参数 Schema、说明、读写标注以 `src/mcp/create-server.ts` 为唯一代码事实源。平台动作通过进程内 MCP 调用复用这套 Schema 和处理器，不另写业务分支。

## 开发者平台操作顺序

1. 部署本项目的 HTTPS 后端，先验证 `GET /healthz`。
2. 使用后端专用 Bearer Key，逐个验证只读工具动作。
3. 在钉钉 MCP 开发平台创建或选择 `MWE审批MCP` 服务；不要使用现有“测试MCP”作为生产服务。
4. 工具创建方式选 `HTTP`，按上表配置 URL、Header、输入参数和输出字段。
5. 先发布只读工具并执行 MCP 检测；只接受平台生成的 `streamable-http` 配置，并确认 URL 主机严格为 `mcp-gw.dingtalk.com`，否则停止接入。
6. 再加入写工具。保留 `confirm`、`dryRun`、调用人绑定、userId allowlist、processCode allowlist 和持久化幂等键。
7. MCP 客户端只保存钉钉平台生成的完整配置；URL 中的 `key` 只放入调用端密钥存储，不复制到工单、截图、日志或 Git。

当前还没有可供平台访问的正式 HTTPS 后端域名，因此本轮没有在开发者平台保存任何工具或发布版本。待域名与密钥就绪后再完成第 3 至第 7 步。
