# MWE审批MCP

`MWE审批MCP` 是部署在 `https://dingtalk.mwexk.com/mcp` 的自托管钉钉 OA 审批 MCP Server。

当前版本：`0.6.2`。

## 当前架构

```text
WorkBuddy / Codex
  -> 本服务 OAuth 2.1 + PKCE
  -> 钉钉 OAuth 验证真实企业用户
  -> 本服务签发限 audience/scope 的短期 MCP token
  -> Streamable HTTP /mcp
  -> MWE审批MCP 企业内部应用 access token
  -> 钉钉 OA OpenAPI
```

- 只提供自托管 Streamable HTTP；不提供 stdio。
- 已删除 AIHub 版本，不使用 `mcp-gw.dingtalk.com`。
- 不提供或兼容 `/platform/tools/*` 旧路由。
- 钉钉 `userAccessToken` 只用于登录身份验证，不作为 MCP Bearer、不持久化。
- OA OpenAPI 仍使用 `MWE审批MCP` 企业内部应用的 App ID/App Secret。
- MCP token 中的 `corpId + unionId + userId` 按请求绑定审批调用者，模型输入不能覆盖身份。

## 公共工具

正常 `tools/list` 只有一个审批人工具：

```text
approval_task
```

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

Access token 默认 10 分钟；refresh token 默认 8 小时、每次使用轮换。重放旧 refresh token 会撤销整个 token family。授权事务、客户端注册和 refresh 哈希保存在 `MCP_AUTH_STORE_PATH`，原始 token 不落盘。

## 开发者后台

在 `MWE审批MCP` 企业内部应用中配置精确 OAuth 回调：

```text
https://dingtalk.mwexk.com/oauth/dingtalk/callback
```

并确认应用具备：

- 登录用户身份/个人信息权限。
- 根据 unionId 映射企业 userId 的通讯录权限 `qyapi_get_member`。
- 审批实例读写和审批表单读取权限。

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
- `127.0.0.1:3001` 已登记给当前正式 DingTalk 服务；OAuth 切换期间，`127.0.0.1:3000` 仅保留为旧版快速回滚实例。后续并行灰度须通过 `APPROVAL_HOST_PORT` 选择并登记另一个经 `ss -lntp` 验证为空闲的临时端口。
- 容器 Router 与共享外部 Docker 网络是后续全站入口迁移目标，不在本次 MCP 鉴权升级中单点切换。
- OAuth/审批状态、幂等账本和最多 30 天审计日志位于持久卷 `/app/data`。

详细安全与模块设计见：

- [`docs/mcp-auth-module-design.md`](docs/mcp-auth-module-design.md)
- [`docs/dingtalk-oauth-mcp-client-auth.md`](docs/dingtalk-oauth-mcp-client-auth.md)
