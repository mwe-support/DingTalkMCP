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
3. 若客户端请求 `approval:decide`，先在本站权限页核对客户端名称与决定权限并明确同意；只读 scope 不显示该页。
4. 浏览器跳转到 `login.dingtalk.com`，使用公司当前账号授权。
5. 确认回调最终回到客户端 loopback URI，而不是停留在本站 callback。
6. `tools/list` 应只显示 `approval_task`。
7. 先用一个该用户确实参与的实例测试：

   ```json
   {
     "action": "view",
     "processInstanceId": "真实审批实例ID"
   }
   ```

8. 使用详情返回的 `fileId` 测试 `attachmentAction=download`；Agent 客户端负责下载和识别内容。
9. 写操作先使用 `dryRun=true`；确认任务仍属于当前 OAuth 用户后，再由用户明确授权 `confirm=true`。

## 预期失败含义

|现象|含义|
|---|---|
|`401` 且有 `resource_metadata`|未登录，正常 OAuth 起点|
|`invalid_target`|客户端没有发送精确 resource `https://dingtalk.mwexk.com/mcp`|
|`invalid_scope`|客户端请求了未开放 scope 或只请求 `approval:decide`|
|钉钉登录后 `access_denied`|corpId 不匹配、身份接口失败或 unionId 无法映射企业 userId|
|`APPROVAL_VIEW_FORBIDDEN`|登录用户不是该审批的可验证参与人|
|`INSUFFICIENT_SCOPE`|token 没有相应读取/决定 scope|

真实客户端测试时请保留：客户端版本、触发时间、HTTP 状态、OAuth 标准错误码。不要复制 token、授权码、PKCE verifier 或带签名的附件 URL。
