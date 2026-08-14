# 钉钉 OAuth 作为自托管 Streamable HTTP MCP 客户端鉴权（研究结论）

日期：2026-08-14  
范围：仅依据钉钉开放平台、MCP 官方规范及 IETF RFC；未把“能放进 HTTP Authorization 头”误认为“语义上可用于该资源”。

## 结论先行

1. **不能直接把钉钉 `userAccessToken` 当作 MCP Bearer token。** MCP 要求客户端仅向 MCP 服务器发送由其授权服务器签发、且面向该 MCP resource 的 token；钉钉 token 的公开用途是调用钉钉 OpenAPI，不是访问本 MCP。RFC 6750 的 Bearer 只是传输认证方案，不会自动建立签发者、受众或权限语义。
2. **可行方案是“钉钉上游身份提供方 + MCP 专用短期 token”。** 先完成钉钉 OAuth/免登，服务端用 `userAccessToken` 调钉钉用户身份 API 验证身份，再由本服务签发仅用于 MCP 的短时、限 scope、限 audience token（JWT 或不可猜的 opaque token）。MCP 端只验证自己的 issuer/audience/expiry/scope；不要把钉钉 token 转发给 MCP 工具。
3. **可以避免维护密码、用户长期 token 和完整用户库，但不能避免最小身份映射。** 可仅保存 `corpId + userId/unionId`、启用状态/角色映射和短期会话或 token 哈希；每次首次/风险登录重新向钉钉验证。若完全不保存映射，则无法稳定做 ACL、撤销和审计。

## 规范依据

- [MCP Authorization（2025-11-25）](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization)：HTTP MCP 采用 OAuth 2.1 资源服务器模型；服务器公布 Protected Resource Metadata/Authorization Server Metadata，要求 `resource`/audience 绑定，并明确禁止接受或透传面向其他资源的 token。
- [RFC 6750 Bearer Token Usage](https://www.rfc-editor.org/rfc/rfc6750.html)：Bearer token 是“持有者即可使用”的凭据；必须使用 TLS、保护 token 不泄露，并建议短时、带 audience/scope 的 token。该 RFC 定义的是 HTTP bearer 方案，不定义钉钉 token 可访问任意第三方资源。
- [RFC 9700 OAuth 2.0 Security BCP（2025）](https://www.rfc-editor.org/rfc/rfc9700.html)：推荐授权码 + PKCE，反对隐式流；要求访问 token 采用 sender-constraining（条件允许时）、短时和最小权限，并建议发布 RFC 8414 元数据。

## 钉钉侧事实与验证边界

钉钉的[登录用户 OAuth 流程](https://open.dingtalk.com/document/development/obtain-identity-credentials)支持授权码登录，`scope` 目前为 `openid` 或 `openid corpid`。[获取用户 token](https://open.dingtalk.com/document/development/obtain-user-token)返回有效期 7200 秒的 `accessToken`、有效期 30 天的 `refreshToken` 和所选 `corpId`，公开用途是以用户身份调用钉钉 OpenAPI。[获取用户通讯录个人信息](https://open.dingtalk.com/document/development/dingtalk-retrieve-user-information)允许以个人 token 请求 `GET /v1.0/contact/users/me`，取得 `unionId`、`openId` 等真实登录身份。

这些接口足以让本服务把钉钉作为上游身份提供方，但不能让钉钉直接充当 MCP 授权服务器：公开参数与返回中没有面向 `https://dingtalk.mwexk.com/mcp` 的 `resource`/audience，也未提供 MCP 客户端所需的 Protected Resource Metadata、Authorization Server Metadata、客户端注册和 MCP 专用 scope。钉钉公开登录流程也未声明 MCP 要求的 PKCE 元数据。因此必须由本站的 MCP 授权层完成协议适配和 MCP token 签发。

服务端至少应验证：

- 钉钉上游 OAuth 回调必须验证 `state`，回调 URI 精确匹配且仅使用 HTTPS；不要假定钉钉支持其公开文档未声明的 `resource`、PKCE 或标准发现元数据。
- 面向 MCP 客户端的本站授权码流必须独立实现 OAuth 2.1、PKCE S256、Protected Resource Metadata 和 Authorization Server Metadata。
- `userAccessToken` 未过期、来自预期钉钉应用/企业（`corpId` 或应用绑定企业），并通过钉钉官方用户身份接口取得用户身份；**不要仅信任客户端提交的 `userId`、`unionId` 或 corpId**。
- 用户主键使用服务端取得的 `corpId + unionId`；需要执行 OA 审批时，再使用企业应用 access token 调用[根据 unionId 获取 userId](https://open.dingtalk.com/document/orgapp-server/query-a-user-by-the-union-id)，把身份转换为该企业内的 `userId`。不要相信客户端自报的任何身份字段。
- MCP 自有 token 验证 `iss`、`aud`（固定为本 MCP resource URI）、`exp/nbf`、签名密钥版本、scope/角色和租户绑定；401 时返回 `WWW-Authenticate: Bearer`，禁止 query-string token。

## 推荐交互

```text
MCP 客户端 -> 本站 OAuth /authorize（OAuth 2.1 + PKCE）
          -> 本站重定向到钉钉 OAuth（按钉钉公开授权码流程）
          -> 本站后端向钉钉换取并验证 userAccessToken
          -> 钉钉用户身份 API（校验 corpId + unionId/userId）
          -> 本站完成原 MCP OAuth 流程并签发专用 access token
MCP 客户端 -- Authorization: Bearer <MCP token> --> https://dingtalk.mwexk.com/mcp
```

该设计不要求维护用户密码、完整用户库或长期 MCP token。若审批权限完全按钉钉实时任务归属判断，可以在每次登录时在线取得 `corpId + unionId -> userId`，签发 5 至 10 分钟的无状态 JWT，不持久化用户或 token；代价是撤销最多延迟到短期 token 过期。服务仍必须维护签名密钥、短期授权事务状态，并为高风险场景提供密钥版本或紧急撤销能力。原始钉钉 `userAccessToken` 和 `refreshToken` 不落盘，MCP 会话到期后重新登录。

## 不能做的事情

- 不要接受任意 `Authorization: Bearer <userAccessToken>` 并把它当作 MCP token。
- 不要把 token 放在 URL、日志、SSE 查询参数或 cookie；不要记录完整 token。
- 不要仅通过 userId/unionId 字符串授权，不验证其来源、企业边界、过期和撤销状态。
- 不要把上游钉钉 token 透传给领星、金蝶或 MCP 工具；工具调用应使用后端持有的、与目标 API audience 匹配的凭据。

## 最终判定

|问题|判定|
|---|---|
|直接把钉钉 `userAccessToken` 当 MCP Bearer|**不合规/不可验证（除非另行建立并实现受信任的 token 验证与 audience 映射）**|
|钉钉作为上游 IdP、本站发行 MCP 短期 token|**可行，且是推荐方案**|
|避免用户库和长期 token|**可以；采用在线身份映射和 5 至 10 分钟无状态 MCP JWT，但仍需签名密钥与短期授权事务状态**|
|corpId/userId/unionId|**必须由服务端向钉钉验证来源并绑定租户；客户端自报值不可作为凭证**|
