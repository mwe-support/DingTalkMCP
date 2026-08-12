# MWE 审批 MCP

`MWE审批MCP` 是一个独立的钉钉 OA 审批 MCP Server。它只使用新建企业内部应用的身份访问钉钉官方 OpenAPI，不复用、也不会修改“金蝶对接”应用。

当前版本：`0.1.0`。

## 已实现能力

- 审批实例详情：同时返回容错后的 `normalized` 和不丢字段的 `raw`。
- 实例 ID 查询、操作记录、实例内待处理任务。
- 用户可见模板、标准表单 Schema、流程预测。
- 发起、同意、拒绝、撤销；全部写操作要求显式确认和本地 userId allowlist。
- 表单附件、评论/操作记录附件、图片元数据的统一识别。
- 表单附件安全下载：临时 URL 换取、HTTPS/Host/重定向校验、大小上限、SHA-256 和 Base64 返回。
- stdio 与无会话 Streamable HTTP 两种 MCP 传输。

保留了 DWS 中已经形成用户习惯的工具名：

```text
get_processInstance_detail
get_processInstance_records
list_pending_tasks
list_user_visible_process
get_process_schema
forecast_process
start_process_instance
approve_processInstance
reject_processInstance
revoke_processInstance
```

新增工具：

```text
query_process_instance_ids
list_approval_attachments
download_approval_attachment
get_approval_capabilities
```

官方公开 OpenAPI 没有与 DWS 私有 `list_pending_approvals` 完全等价的个人收件箱接口，因此当前版本没有伪造这个工具。后续通过 `bpms_instance_change` / `bpms_task_change` 事件建立本地投影后再补齐。

## 应用与权限

本服务对应独立应用 `MWE审批MCP`，最小权限是：

- `Workflow.Instance.Read`
- `Workflow.Instance.Write`
- `Workflow.Form.Read`

当前版本不需要 `Workflow.Form.Write`。附件上传尚未开放，因此也不要求存储上传权限。

## 安装与验证

需要 Node.js 20 或更高版本。

```powershell
cd "D:\codex项目\金蝶领星钉钉三端数据同步开发\approval-mcp"
npm ci
npm test
npm run typecheck
npm run build
```

`npm audit` 在当前锁文件上应返回零已知漏洞。

## 配置

复制 `.env.example` 了解完整配置，但服务不会自动读取 `.env`。生产环境应通过 Windows 服务、容器 Secret、CI/CD Secret 或密钥管理服务注入环境变量。

必填：

```text
DINGTALK_CLIENT_ID
DINGTALK_CLIENT_SECRET
```

写操作默认关闭。只有把受控的钉钉 userId 加入下面的逗号分隔列表，写工具才会执行：

```text
DINGTALK_WRITE_USER_IDS=userId-1,userId-2
```

建议在正式联调前限制允许使用的审批模板：

```text
APPROVAL_ALLOWED_PROCESS_CODES=PROC-xxxx,PROC-yyyy
```

不要把 Client Secret、access token、HTTP API Key 或附件临时 URL 提交到 Git。

## 启动 stdio MCP

PowerShell 示例：

```powershell
$env:DINGTALK_CLIENT_ID = "dingxxxxxxxx"
$env:DINGTALK_CLIENT_SECRET = "从密钥存储注入"
$env:DINGTALK_WRITE_USER_IDS = "测试人员userId"
node .\dist\transports\stdio.js
```

stdio 进程的 stdout 只用于 MCP 协议；启动错误写到 stderr。

## 启动 Streamable HTTP MCP

默认只监听 `127.0.0.1:3000`：

```powershell
$env:DINGTALK_CLIENT_ID = "dingxxxxxxxx"
$env:DINGTALK_CLIENT_SECRET = "从密钥存储注入"
$env:MCP_HTTP_API_KEY = "至少32字节的随机密钥"
node .\dist\transports\http.js
```

端点：

- MCP：`POST /mcp`
- 健康检查：`GET /healthz`

HTTP 传输每个请求创建独立的 MCP server/transport，禁用会话共享，以规避跨客户端状态泄漏。非 loopback 监听时，服务强制要求：

- `MCP_HTTP_API_KEY`：至少 32 UTF-8 字节，客户端使用 `Authorization: Bearer ...`。
- `MCP_HTTP_ALLOWED_HOSTS`：允许的 Host，逗号分隔。

服务自身只提供 HTTP。远程部署必须放在 TLS 反向代理或受控隧道之后，不应把明文端口直接暴露到公网。

## 写操作安全语义

发起、同意、拒绝和撤销必须同时满足：

1. MCP 参数 `confirm=true`，代表宿主已获得用户明确确认。
2. 操作者 userId 在 `DINGTALK_WRITE_USER_IDS` 中。
3. `processCode` 在可选 allowlist 中。
4. 同意/拒绝前重新读取实例，确认 taskId 仍可处理且属于该操作者。
5. 撤销前重新读取实例，确认状态仍为 `RUNNING`，非系统撤销时操作者仍是发起人。

`start_process_instance.requestId` 是 MCP 侧本地幂等键，不会作为未知字段传给钉钉 OpenAPI。同一进程内重复使用相同 UUID 和相同请求会复用结果；同一个 UUID 配不同请求会返回 `IDEMPOTENCY_CONFLICT`。

## 附件边界

`list_approval_attachments` 会容错解析：

- 表单 `DDAttachment` 数据。
- `operationRecords[].attachments[]`。
- `operationRecords[].images[]`。

`download_approval_attachment` 使用钉钉官方 `processInstanceId + fileId` 下载接口。官方明确该接口支持审批附件钉盘空间文件，但不支持审批评论附件。因此当前版本会列出评论附件元数据，却不会宣称评论附件可下载；这一能力需后续通过另一条已验证的钉盘授权链路实现。

默认单文件最大 10 MiB，下载内容以 Base64 返回并附带 SHA-256。可通过 `APPROVAL_DOWNLOAD_MAX_BYTES` 调整。

## 目录结构

```text
src/
  approval/       审批服务、容错规范化、附件解析与下载
  core/           错误模型
  dingtalk/       accessToken 缓存和 OpenAPI client
  mcp/            MCP 工具注册
  transports/     stdio 与 Streamable HTTP
tests/             OpenAPI、MCP、HTTP 和附件安全测试
```

## 后续路线

- P1：使用 Stream 订阅 `bpms_instance_change`、`bpms_task_change`，实现待办投影与事件幂等。
- P1：取得并验证存储上传权限后，实现本机文件到审批钉盘的完整上传链路。
- P1：研究并实测评论附件的独立授权下载链路。
- 部署前：使用测试模板和测试人员完成真实的详情、表单附件下载、发起、同意、拒绝、撤销验收。

官方能力与开发者平台设置证据见：

[`../artifacts/dingtalk-mcp-research-2026-08-12/自建审批MCP-官方能力与开发者平台设置.md`](../artifacts/dingtalk-mcp-research-2026-08-12/自建审批MCP-官方能力与开发者平台设置.md)
