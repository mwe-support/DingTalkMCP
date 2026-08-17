# MWE审批MCP

`MWE审批MCP` 是部署在 `https://dingtalk.mwexk.com/mcp` 的自托管钉钉 OA 审批 MCP Server。

当前版本：`0.9.1`。

## 当前架构

```text
WorkBuddy / Codex
  -> 本服务 OAuth 2.1 + PKCE
  -> 钉钉 OAuth 验证真实企业用户
  -> 本服务签发限 audience/scope 的短期 MCP token
  -> Streamable HTTP /mcp
  -> MWE审批MCP 企业内部应用 access token
  -> 钉钉 OA OpenAPI

钉钉 bpms_task_change
  -> 官方 Stream 长连接（仅上游事件摄取）
  -> 本地待审批索引
```

- 只提供自托管 Streamable HTTP；不提供 stdio。
- 已删除 AIHub 版本，不使用 `mcp-gw.dingtalk.com`。
- 不提供或兼容 `/platform/tools/*` 旧路由。
- 钉钉 `userAccessToken` 只用于登录身份验证，不作为 MCP Bearer、不持久化。
- OA OpenAPI 仍使用 `MWE审批MCP` 企业内部应用的 App ID/App Secret。
- MCP token 中的 `corpId + unionId + userId` 按请求绑定审批调用者，模型输入不能覆盖身份。
- 钉钉 Stream 是服务端使用应用凭证建立的出站事件通道，不是 MCP 传输，不新增公网工具端点。

## 公共工具

正常 `tools/list` 只有三个按业务角色/主对象聚合的工具：

```text
approval_inbox    # 当前审批人：发现单个或批量待审批任务
approval_task     # 审批人：查看、同意、拒绝
approval_request  # 申请人：准备附件、提交、评论、撤销
```

发现当前 OAuth 用户的待审批（`limit=1` 为单条，最多 20 条）：

```json
{
  "page": 1,
  "limit": 20
}
```

`approval_inbox` 从 `bpms_task_change` 事件索引取候选项，然后逐项调用审批详情确认任务仍处于可操作状态且属于登录用户，才返回 `processInstanceId` 和可用的 `taskId`；若源事件缺少任务 ID，则仅返回实例 ID 并标记 `taskIdUnavailable=true`。普通 OA 没有免费的全量回填 API，因此响应固定声明 `coverage=partial` 和 `resyncRequired=true`：它覆盖事件连接激活后的任务，不冒充钉钉官方 DWS 的全历史收件箱。

读取审批：

```json
{
  "action": "view",
  "processInstanceId": "审批实例ID"
}
```

换取选定附件的临时下载链接：

```json
{
  "action": "view",
  "processInstanceId": "审批实例ID",
  "attachmentAction": "download",
  "attachmentIds": ["详情中的fileId"],
  "maxAttachments": 3
}
```

服务端不下载、解析或 OCR 附件。Agent 客户端必须立即下载临时链接，并自行执行大小限制、重定向 Host 校验、文件识别、解析和 OCR。

同意审批：

```json
{
  "action": "approve",
  "processInstanceId": "审批实例ID",
  "taskId": "view返回的当前任务ID",
  "requestId": "每次业务决定稳定复用的UUID",
  "confirm": true,
  "remark": "符合要求"
}
```

拒绝时把 `action` 改为 `reject`，并提供非空 `remark`。写操作会重新读取当前任务，确认任务仍属于 OAuth 登录用户，并使用持久幂等账本阻止重复决定。

### 发起审批

`approval_request` 使用“默认拒绝 + 精确允许列表”。首版只接受：

- `expense_reimbursement`：费用报销，固定 `processCode=PROC-2DB91B79-3CDD-421D-A223-0489A7BAB2C0`。
- `payment_request`：付款申请，固定 `processCode=PROC-5E238117-7121-4CB3-8219-9F11A2E42BE4`。

加班审批及所有其他模板均拒绝。公开 Schema 不接受 `processCode`、申请人、审批人、抄送人或流程节点；申请人来自 OAuth 绑定的钉钉用户，审批流完全沿用 OA 后台模板。每次准备或提交前都会读取线上模板 Schema，并精确核对已审查的控件 ID、名称和类型，模板发生变化时失败关闭。

先用 `dryRun` 验证付款申请：

```json
{
  "action": "submit",
  "template": "payment_request",
  "fields": {
    "documentNumber": "FK-20260817-001",
    "payee": "收款单位",
    "currency": "CNY",
    "applicationDate": "2026-08-17",
    "lines": [{
      "purpose": "项目采购",
      "amount": 880,
      "reason": "合同付款",
      "expenseDepartment": "研发部"
    }]
  },
  "confirm": false,
  "dryRun": true,
  "requestId": "稳定复用的UUID"
}
```

`deptId` 为可选部门提示，不是客户端提供的身份或权限依据。服务端始终查询 OAuth 申请人的实时通讯录：账号只属于一个部门时自动使用该部门，并规范化客户端遗留的根部门 `1`；账号属于多个部门且无法唯一确定时返回 `DEPARTMENT_SELECTION_REQUIRED` 及安全的部门 ID/名称候选，Agent 再用候选中的 `deptId` 重试。

`action=comment` 可对当前 OAuth 用户本人发起且属于精确模板允许列表的审批实例添加文本评论。评论内容为 1–1024 字符，评论人始终由服务端注入；真实写入要求 `confirm=true` 和稳定 UUID `requestId`，重复调用由持久幂等账本去重。首版不接受评论附件元数据，避免客户端伪造钉盘文件身份。

钉钉当前公开的官方 OA 服务端 API 没有“保存到钉钉草稿箱”接口，发起审批接口也没有草稿标志。`prepare` 与 `submit + dryRun=true` 会读取实时模板、校验完整表单并构建最终请求，但不会创建审批实例，也不会在钉钉客户端草稿箱生成条目；项目不会用本地记录冒充钉钉草稿。

费用报销字段为 `date`、`reason`、`counterparty` 和至少一条 `items`；每条明细包含 `amount`、`category`（仅 `AI费用` 或 `其它`）、`expenseDepartment`、`remark`。

附件采用两阶段直传：

1. Agent 调用 `action=prepare`，传文件名、大小和模板允许的附件字段。
2. MCP 返回钉钉签名的 HTTPS `PUT` 地址和请求头；Agent 直接把文件上传到钉钉，文件字节不经过 MCP。
3. Agent 调用 `action=submit`，提交 `uploadKey`、`spaceId`、文件名和大小；MCP 提交文件元数据并发起审批。

单文件最大 20 MiB、每单最多 10 个、合计最大 50 MiB。费用报销仅允许附件字段 `invoice`/`other`，付款申请仅允许 `attachment`。实际提交和撤销必须 `confirm=true` 且提供稳定 UUID `requestId`；幂等命名空间绑定 OAuth 申请人。附件提交、审批创建或撤销结果不确定时会失败关闭，禁止自动换 UUID 重试。

## OAuth 端点

|端点|用途|
|---|---|
|`/.well-known/oauth-protected-resource/mcp`|MCP Protected Resource Metadata|
|`/.well-known/oauth-authorization-server`|本站 Authorization Server Metadata|
|`/authorize`|MCP 客户端授权入口|
|`/oauth/dingtalk/callback`|钉钉 OAuth 回调|
|`/token`|授权码或 refresh token 换 MCP token|
|`/register`|受限公共客户端动态注册|
|`/revoke`|撤销 refresh token family|
|`/mcp`|OAuth 保护的 Streamable HTTP MCP|
|`/healthz`|存活检查|

Access token 默认 10 分钟；refresh token 默认 7 天、每次使用都在 Store 内原子轮换，并从本次刷新重新计算 7 天窗口。服务端仅保留当前 token 与最近一代重放墓碑：重放最近一代会撤销当前 family，更早 token 直接按无效凭证拒绝，因此持续刷新时每个 family 状态保持 O(1)。授权事务、客户端注册和 refresh 哈希保存在 `MCP_AUTH_STORE_PATH`，原始 token 不落盘；成功签发 token 后动态客户端注册会滑动续期，停止使用 30 天后自动清理。升级到本版本时，仍未过期的旧 8 小时 refresh token 会在启动阶段一次性迁移到新窗口，已过期 token 不复活。

服务端在 OAuth scope 不变时更新，不要求用户重新登录钉钉：客户端应沿用现有 refresh token 静默换取 access token，重新执行 `initialize` 与 `tools/list`。`initialize.serverInfo.version`、`/healthz` 的 `version/toolsRevision` 以及 `/mcp` 的 `x-mcp-server-version`/`x-mcp-tools-revision` 可用于检测工具版本；MCP 响应要求重新验证缓存。只有新增 scope、refresh token 超过 7 天滚动窗口、用户主动撤销或检测到 token 重放时，才需要交互式重新授权。服务端不能强制不支持刷新机制的客户端主动清除其本地工具缓存。

## 开发者后台

在 `MWE审批MCP` 企业内部应用中配置精确 OAuth 回调：

```text
https://dingtalk.mwexk.com/oauth/dingtalk/callback
```

并确认应用具备：

- 登录用户身份/个人信息权限。
- 根据 unionId 映射企业 userId 的通讯录权限 `qyapi_get_member`。
- 审批实例读写和审批表单读取权限。
- 附件直传所需的 `Storage.UploadInfo.Read` 与 `Storage.File.Write` 权限。
- H5 微应用能力及其 AgentId；将正整数配置为 `DINGTALK_AGENT_ID`。未配置时，无附件审批仍可使用，附件 `prepare` 会明确失败。
- 事件订阅的推送方式选择 `Stream模式推送`，并订阅“审批任务开始、结束、取消/转交”（`bpms_task_change`）。生产配置 `DINGTALK_APPROVAL_EVENTS_ENABLED=true`，索引保存到 `APPROVAL_INBOX_PATH`。

`Premium.Workflow.ReadWrite.All` 及 OA 高级版待审批列表不是生产依赖。`Todo.Todo.Read` 只在 2026-08-17 做过可行性探测：当前企业的未完成和已完成企业待办都返回 0，不能用它冒充 OA 收件箱；服务代码不调用该接口。

附件上传 URL 必须经过 HTTPS 主机白名单校验。2026-08-17 的企业实测返回
`sh-dualstack.trans.dingtalk.com`，因此默认精确允许 `.trans.dingtalk.com`；同时保留
钉钉可能返回的 `.aliyuncs.com` 存储域。不要把白名单放宽为任意 `.dingtalk.com`。

OAuth 授权范围包含 `approval:read`、`approval:decide` 与 `approval:create`。未认证请求的 HTTP 401 challenge 只声明 `resource_metadata`，由客户端从 metadata 的 `scopes_supported` 选择授权范围；服务端不再用 `scope=approval:read` 覆盖 metadata。本站 `/authorize` 只校验并保存 MCP 授权事务，然后立即跳转到钉钉官方 OAuth 页面，不展示自建权限确认页。客户端以较小 scope 连接后，调用发起审批或审批决定动作时，服务端仍会按 MCP Authorization 规范返回 HTTP 403 `insufficient_scope` challenge；不要把缺 scope 仅包装成 HTTP 200 的工具业务错误。所有实际写操作仍要求工具层 `confirm=true`。

## 本地验证

```powershell
cd "D:\codex项目\金蝶领星钉钉三端数据同步开发\approval-mcp"
npm ci
npm test
npm run typecheck
npm run build
```

生成 Ed25519 PKCS#8 签名私钥：

```bash
mkdir -p secrets
openssl genpkey -algorithm Ed25519 -out secrets/mcp-signing-private.pem
openssl rand -base64 32 > secrets/mcp-audit-hmac.key
chmod 600 secrets/mcp-signing-private.pem secrets/mcp-audit-hmac.key
```

复制 `.env.example` 配置真实环境变量。服务不会自动读取 `.env`；Compose、systemd 或密钥管理器必须显式注入。

启动：

```powershell
npm run build
node .\dist\transports\http.js
```

## 客户端

WorkBuddy 与 Codex 的无密钥 OAuth 配置模板和测试顺序见：

- [`docs/client-config-templates.md`](docs/client-config-templates.md)

客户端配置中只出现公开 MCP URL，不填写 App Secret、Bearer token 或钉钉 userAccessToken。

## 部署

- 使用 [`compose.example.yaml`](compose.example.yaml) 部署应用。
- MCP 签名私钥和独立审计 HMAC key 均以只读 Secret 文件挂载。
- `deploy/cvm/edge/dingtalk.conf` 只转发 `/mcp`、OAuth/metadata 端点和 `/healthz`。
- 当前 CVM 入口以 `/public/cvm-web-edge/README.md` 为准：应用只发布一个唯一的 loopback 后端端口，由 `edge-nginx` 转发；不得绑定 `0.0.0.0`。
- `127.0.0.1:3000` 已登记给唯一的正式 DingTalk 服务。后续并行灰度须通过 `APPROVAL_HOST_PORT` 选择并登记另一个经 `ss -lntp` 验证为空闲的临时端口；临时实例不得继续占用正式端口。
- 容器 Router 与共享外部 Docker 网络是后续全站入口迁移目标，不在本次 MCP 鉴权升级中单点切换。
- OAuth/审批状态、事件驱动的待审批索引、幂等账本和最多 30 天审计日志位于持久卷 `/app/data`。
- 同一应用 Client ID 同时只能运行一个生产 Stream 消费者。灰度容器不得在旧生产容器仍运行时开启 `DINGTALK_APPROVAL_EVENTS_ENABLED`。

详细安全与模块设计见：

- [`docs/mcp-auth-module-design.md`](docs/mcp-auth-module-design.md)
- [`docs/dingtalk-oauth-mcp-client-auth.md`](docs/dingtalk-oauth-mcp-client-auth.md)
- [`docs/approval-request-tool-design.md`](docs/approval-request-tool-design.md)
