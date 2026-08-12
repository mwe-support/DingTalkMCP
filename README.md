# MWE 审批 MCP

`MWE审批MCP` 是一个独立的钉钉 OA 审批 MCP Server。它只使用新建企业内部应用的身份访问钉钉官方 OpenAPI，不复用、也不会修改“金蝶对接”应用。

当前版本：`0.2.0`。

当前发布状态：钉钉官方网关中的版本 1 仍是“详情 + 附件元数据”实现；本仓库 `0.2.0` 已完成“详情 + 统一附件清单 + 所选附件内容读取”的组合工具实现，待取得正式 HTTPS 工具后端域名后替换平台动作。2026-08-12 已使用同一应用凭证对近期真实审批记录附件完成接口链路验收：临时下载地址获取成功，PDF 下载 HTTP 200、122,165 字节、1 页且可提取文本；临时调试工具与文件已删除。

## 已实现能力

- 审批实例详情：同时返回容错后的 `normalized` 和不丢字段的 `raw`。
- 组合审批详情工具 `get_approval_instance`：一次调用返回详情、统一附件清单，并可通过可选参数读取所选附件正文；不要求 Agent 在多个小工具之间搬运完整附件对象。
- 实例 ID 查询、操作记录、实例内待处理任务。
- 用户可见模板、标准表单 Schema、流程预测。
- 发起、同意、拒绝、撤销；全部写操作绑定服务端固定调用人，并要求显式确认和本地 userId allowlist。
- 表单附件、评论/操作记录附件、图片元数据的统一识别。
- 表单与评论附件安全下载：下载授权、临时 URL 换取、HTTPS/Host/重定向校验、大小上限、SHA-256 和 Base64 返回。
- MCP 客户端只使用钉钉官方生成的 Streamable HTTP 配置，MCP 域名必须为 `mcp-gw.dingtalk.com`。
- 本项目不暴露 MCP 传输端点，也不包含 stdio；只提供钉钉 MCP 开发平台调用的 HTTPS 工具后端。

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

主要组合工具：

```text
get_approval_instance
```

默认传 `processInstanceId` 即返回审批详情以及表单附件、操作记录附件和图片的统一清单。需要正文时仍调用同一工具：

```json
{
  "processInstanceId": "审批实例ID",
  "attachmentAction": "read",
  "attachmentIds": ["从附件清单取得的fileId"],
  "maxAttachments": 3
}
```

每次最多读取 5 个附件，默认上限 3 个；超出上限直接报错，不静默截断。批量读取按附件返回 ledger：一个附件失败不会抹掉其他成功结果。内容同时受单文件大小、批次总字节数、HTTPS 主机和重定向校验约束。只有 URL、没有 `fileId` 的图片目前列入元数据清单，但不进入 `attachmentIds` 内容读取链路。

兼容/管理工具：

```text
query_process_instance_ids
list_approval_attachments
download_approval_attachment
get_approval_capabilities
```

读取工具可直接使用现有参数；`forecast_process` 同时接受 DWS 的 `ProcessForecastPopRequest` 包装，`start_process_instance` 同时接受 `ProcessInstanceCreationPopRequest`。写工具刻意增加 `confirm`、发起请求增加 `requestId`，因此是“DWS 契约适配 + 更严格安全扩展”，不是对钉钉官方 OA MCP 的无保护替身。

官方公开 OpenAPI 没有与 DWS 私有 `list_pending_approvals` 完全等价的个人收件箱接口，因此当前版本没有伪造这个工具。后续通过 `bpms_instance_change` / `bpms_task_change` 事件建立本地投影后再补齐。

## 应用与权限

本服务对应独立应用 `MWE审批MCP`，最小权限是：

- `Workflow.Instance.Read`
- `Workflow.Instance.Write`
- `Workflow.Form.Read`

当前版本不需要 `Workflow.Form.Write`。附件上传尚未开放，因此也不要求存储上传权限。

真实审批记录附件下载未返回 401/403 或缺权错误，说明当前 `Workflow.Instance.Read` 与 `Workflow.Instance.Write` 已满足本轮详情、审批记录附件换取下载地址的需要；未额外申请权限。

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

附件下载授权和写操作还需要把本服务固定绑定到一个钉钉用户：

```text
DINGTALK_CALLER_USER_ID=测试人员userId
```

写操作默认关闭。固定调用人还必须出现在下面的逗号分隔列表中：

```text
DINGTALK_WRITE_USER_IDS=userId-1,userId-2
```

建议在正式联调前限制允许使用的审批模板：

```text
APPROVAL_ALLOWED_PROCESS_CODES=PROC-xxxx,PROC-yyyy
```

不要把 Client Secret、access token、平台后端 API Key、官方 MCP 配置中的 `key` 或附件临时 URL 提交到 Git。

## 启动平台工具后端

默认只监听 `127.0.0.1:3000`：

```powershell
$env:DINGTALK_CLIENT_ID = "dingxxxxxxxx"
$env:DINGTALK_CLIENT_SECRET = "从密钥存储注入"
$env:MCP_PLATFORM_API_KEY = "至少32字节的随机密钥"
node .\dist\transports\http.js
```

端点：

- 钉钉 MCP 开发平台工具后端：`POST /platform/tools/<toolName>`
- 健康检查：`GET /healthz`

本服务不是 MCP Server，客户端不得把它配置为 MCP URL。它只接受钉钉平台到后端的普通 HTTP 调用。非 loopback 监听时，服务强制要求：

- `MCP_PLATFORM_API_KEY`：至少 32 UTF-8 字节，由钉钉平台使用 `Authorization: Bearer ...`。
- `APPROVAL_BACKEND_ALLOWED_HOSTS`：后端允许的 Host，逗号分隔。

远程部署必须放在 TLS 反向代理之后，不应把 Node.js 明文端口直接暴露到公网。

未配置 `MCP_PLATFORM_API_KEY` 时，整个 `/platform/tools/*` 路由返回 404。平台后端请求体就是该工具的参数对象，成功响应保持 `{ "result": ... }`，工具校验或业务错误返回 HTTP 422 和 `{ "error": ... }`。

## 唯一 MCP 发布路径：钉钉官方托管

生产唯一链路是：

```text
MCP 客户端
  -> 钉钉官方 Streamable HTTP 网关（mcp-gw.dingtalk.com）
  -> 本项目 /platform/tools/<toolName> HTTPS 动作
  -> 钉钉官方 OpenAPI（api.dingtalk.com）
```

在开发者平台中，每个工具选择 `HTTP` 创建方式，方法为 `POST`，URL 指向本项目对应的 `/platform/tools/<toolName>`，请求头设置后端专用 Bearer Key，请求体参数与工具 Schema 保持一致。钉钉 MCP 开发平台负责生成和维护外部 Streamable HTTP MCP 地址；本项目的 HTTPS 动作地址仍需由我们部署和维护，但它不是 MCP 域名。

2026-08-12 在已登录的钉钉官方 MCP 市场实测，“获取 MCP Server 配置”返回 `type: streamable-http`，URL 主机为钉钉官方域名 `mcp-gw.dingtalk.com`；官方文档同时说明 MCP 服务通过钉钉统一网关。由此可确认当前 `MWE审批MCP` 版本 1 的 MCP 网关由钉钉托管。URL 中的 `key` 是敏感凭据，禁止写入代码、文档、日志或 Git。

不使用 Deap 自定义 MCP URL，也不提供任何自托管 MCP 回退。完整设置步骤和工具端点表见 [`docs/dingtalk-mcp-platform.md`](docs/dingtalk-mcp-platform.md)。

## 写操作安全语义

发起、同意、拒绝和撤销必须同时满足：

1. MCP 参数 `confirm=true`，代表宿主已获得用户明确确认。
2. 操作者由服务端 `DINGTALK_CALLER_USER_ID` 固定绑定；客户端即使传 userId，也只能与它相同。
3. 固定调用人在 `DINGTALK_WRITE_USER_IDS` 中。
4. `processCode` 在可选 allowlist 中；同意、拒绝、撤销也会从最新实例详情反查并校验。
5. 同意/拒绝前重新读取实例，确认 taskId 仍可处理且属于固定调用人。
6. 撤销前重新读取实例，确认状态仍为 `RUNNING` 且固定调用人仍是发起人；公共工具不能发起系统撤销。

写工具支持 `dryRun=true`：执行本地权限和最新状态校验，但不调用写接口，也不要求 `confirm=true`。

`start_process_instance.requestId` 是 MCP 侧持久化幂等键，不会作为未知字段传给钉钉 OpenAPI。成功结果写入 `APPROVAL_IDEMPOTENCY_LEDGER_PATH`，重启后仍会复用；同一个 UUID 配不同请求返回 `IDEMPOTENCY_CONFLICT`。若超时或崩溃导致结果不确定，服务返回 `IDEMPOTENCY_OUTCOME_UNKNOWN` 并停止自动重试，要求先在钉钉中核对，避免重复发起。

目录账本为每个 requestId 建立 SHA-256 命名目录，并以原子 `mkdir` 完成“检查并预留”，支持共享同一文件系统的多个 HTTP 并发实例。崩溃留下的 `pending` 记录不会被回收，而是持续失败关闭，要求人工核对钉钉实例后处理；跨主机多副本若不共享该目录，应改用带唯一约束事务的共享数据库。

每个实际写操作会向 stderr 输出一行脱敏 JSON 审计事件，包含动作、固定调用人、实例/task/request 标识和结果，不记录 Client Secret、access token、表单内容、备注或附件正文。

## 附件边界

`get_approval_instance` 与兼容工具 `list_approval_attachments` 会容错解析：

- 表单 `DDAttachment` 数据。
- `operationRecords[].attachments[]`。
- `operationRecords[].images[]`。

组合工具在 `attachmentAction=read` 时自动根据附件来源选择下载链路。表单附件先以详情返回的 `spaceId + fileId` 为固定调用人授权，再以 `processInstanceId + fileId` 换取临时地址；评论附件自动使用官方 SDK 当前使用的 `withCommentAttatchment` 字段。固定调用人不能由 MCP 参数伪造。`download_approval_attachment` 仅作为兼容底层能力保留，不建议优先发布为独立 Agent 工具。

默认单文件最多下载 10 MiB 解码后字节，组合调用中的 Base64 正文默认总计最多 15 MiB，内容附带 SHA-256。可分别通过 `APPROVAL_DOWNLOAD_MAX_BYTES` 与 `APPROVAL_ATTACHMENT_BATCH_MAX_BYTES` 调整；批次按请求顺序串行下载，超过 Base64 正文预算的文件返回独立 ledger 错误，避免并发大响应造成内存峰值。审批详情与 JSON 字段开销不计入该正文预算。

## 目录结构

```text
src/
  approval/       审批服务、容错规范化、附件解析与下载
  core/           错误模型、审计与持久化幂等账本
  dingtalk/       accessToken 缓存和 OpenAPI client
  mcp/            MCP 工具注册
  transports/     钉钉平台普通 HTTP 工具后端
tests/             OpenAPI、MCP、HTTP 和附件安全测试
```

## 后续路线

- P1：使用 Stream 订阅 `bpms_instance_change`、`bpms_task_change`，实现待办投影与事件幂等。
- P1：取得并验证存储上传权限后，实现本机文件到审批钉盘的完整上传链路。
- 已完成：在真实审批记录附件上验收 `withCommentAttatchment` 下载地址链路，并验证 PDF 字节、文本与渲染均可读取。
- 部署前：为钉钉 MCP 平台提供正式 HTTPS 工具后端域名和平台到后端的 Bearer Key，再把已发布的元数据版 `get_approval_instance` 升级为本仓库组合实现。
- 部署前：使用测试模板和测试人员完成真实的详情、表单附件下载、发起、同意、拒绝、撤销验收。

官方能力与开发者平台设置证据见：

[`../artifacts/dingtalk-mcp-research-2026-08-12/自建审批MCP-官方能力与开发者平台设置.md`](../artifacts/dingtalk-mcp-research-2026-08-12/自建审批MCP-官方能力与开发者平台设置.md)
