# WorkBuddy 与 Codex MCP 配置模板

日期：2026-08-14
目标 URL：`https://dingtalk.mwexk.com/mcp`

## 使用前检查

浏览器或命令行应能读取：

```text
https://dingtalk.mwexk.com/.well-known/oauth-protected-resource/mcp
https://dingtalk.mwexk.com/.well-known/oauth-authorization-server
```

直接访问 `/mcp` 返回 401 是正常的；响应必须包含指向 Protected Resource Metadata 的 `WWW-Authenticate`。

客户端配置中不要添加固定 `Authorization` header。OAuth token 由客户端在钉钉登录后取得和保存。

## WorkBuddy

WorkBuddy 配置文件通常位于：

```text
~/.workbuddy/mcp.json
```

把下列 entry 合并进现有 `mcpServers`，不要覆盖其他服务：

```json
{
  "mcpServers": {
    "mwe-approval-mcp": {
      "type": "streamable-http",
      "url": "https://dingtalk.mwexk.com/mcp",
      "disabled": false
    }
  }
}
```

保存后，在 WorkBuddy 的连接器/自定义连接器页面启用并信任该服务。支持 MCP OAuth 2.1 的版本应自动发现 metadata、动态注册公共客户端，并打开钉钉登录页面。

若当前 WorkBuddy 版本只显示 401 且没有打开授权页面，请记录客户端版本和完整错误码，不要临时把钉钉 userAccessToken 或 App Secret 写进 `headers`。该结果表示客户端 OAuth 兼容性缺口，不是允许绕过鉴权。

## Codex

在 `~/.codex/config.toml` 中加入：

```toml
[mcp_servers.mwe_approval_mcp]
url = "https://dingtalk.mwexk.com/mcp"
```

等价 CLI 配置：

```text
codex mcp add mwe_approval_mcp --url https://dingtalk.mwexk.com/mcp
codex mcp login mwe_approval_mcp
```

不要设置 `http_headers`、`bearer_token_env_var` 或 URL query key。Codex 应从 401 的 `resource_metadata` 开始 OAuth 发现，并通过 loopback redirect URI 完成 PKCE。

如果当前 Codex 桌面安装的 CLI 因 WindowsApps 权限无法直接运行 `codex mcp login`，可以先只写 `config.toml`，重启 Codex 后在 MCP 管理界面触发登录。

## 实测顺序

1. 确认 metadata 两个 URL 返回 200。
2. 添加客户端配置并触发连接。
3. 初次授权时，服务端的 HTTP 401 challenge 不携带单一 scope；客户端应从 protected resource metadata 的 `scopes_supported` 读取 `approval:read`、`approval:create` 与 `approval:decide`。本站 `/authorize` 校验请求后直接跳转到钉钉官方 OAuth 页面，不展示自建权限确认页。
4. 已持有较小 scope 的客户端调用发起审批、同意或拒绝动作时，服务端仍通过 HTTP 403 `insufficient_scope` 分别要求 `approval:create` 或 `approval:decide`。WorkBuddy 5.3.13 会把运行时 403 归类为 transport error，不能自动升级；应只执行一次“重新授权”，让它按 metadata 重新申请。自动打开授权页后不要同时点击第二个手动授权按钮，否则并行 OAuth 流程会互相覆盖本地 `clientInformation` 与 `pendingOAuth` 状态。
5. 浏览器跳转到 `login.dingtalk.com`，使用公司当前账号授权。
6. 确认回调最终回到客户端 loopback URI，而不是停留在本站 callback。
7. `tools/list` 应只显示 `approval_inbox`、`approval_task` 与 `approval_request`。`approval_inbox` 通过 `recordStatus=pending|completed` 合并待审批和已处理记录，使用既有 `approval:read` scope，不需要重新走钉钉授权。
8. 先用一个该用户确实参与的实例测试：

   ```json
   {
     "action": "view",
     "processInstanceId": "真实审批实例ID"
   }
   ```

9. 使用详情返回的 `fileId` 测试 `attachmentAction=download`；Agent 客户端负责下载和识别内容。
10. 写操作先使用 `dryRun=true`；确认任务仍属于当前 OAuth 用户后，再由用户明确授权 `confirm=true`。

## 服务端更新与工具列表刷新

- 同一 OAuth scope 内的服务端更新不需要重新走钉钉登录。客户端应使用既有 refresh token 静默续期，然后重新连接并调用 `initialize`、`tools/list`。
- access token 默认 10 分钟；轮换 refresh token 为 7 天滚动窗口。成功签发 token 后客户端注册会滑动续期，停用 30 天后清理；升级时仍未过期的旧 8 小时 token 会一次性迁移，过期 token 不复活。
- 可先读取 `GET https://dingtalk.mwexk.com/healthz` 的 `version`/`toolsRevision`，或检查 `/mcp` 响应头 `x-mcp-server-version`/`x-mcp-tools-revision`，判断客户端缓存是否落后。
- 只有 scopes 增加、refresh token 过期或撤销、最近一代已轮换 token 重放导致 family 撤销时，才重新授权。更早 token 直接视为无效。不要用“重新授权”代替普通的断开重连或工具列表刷新。

## 预期失败含义

|现象|含义|
|---|---|
|`401` 且有 `resource_metadata`|未登录，正常 OAuth 起点|
|`invalid_target`|客户端没有发送精确 resource `https://dingtalk.mwexk.com/mcp`|
|`invalid_scope`|客户端请求了未开放 scope 或只请求 `approval:decide`|
|钉钉登录后 `access_denied`|corpId 不匹配、身份接口失败或 unionId 无法映射企业 userId|
|`APPROVAL_VIEW_FORBIDDEN`|登录用户不是该审批的可验证参与人|
|HTTP `403` 且 `error="insufficient_scope"`|token 缺少当前动作的 scope；兼容客户端应发起增量授权|
|工具结果 `INSUFFICIENT_SCOPE`|客户端未处理 HTTP scope challenge，或请求未经过标准 Streamable HTTP 入口|

真实客户端测试时请保留：客户端版本、触发时间、HTTP 状态、OAuth 标准错误码。不要复制 token、授权码、PKCE verifier 或带签名的附件 URL。
