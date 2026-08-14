# 钉钉 AIHub / MCP 开发平台旧链路退役说明

日期：2026-08-14

该文档原先描述的 `mcp-gw.dingtalk.com -> /platform/tools/*` 链路已经退役，不再是本仓库的运行或部署方案。

当前唯一架构：

```text
MCP 客户端
  -> https://dingtalk.mwexk.com/mcp
  -> 本服务 OAuth 2.1 / 钉钉上游身份验证
  -> approval_task
  -> 钉钉 OA OpenAPI
```

硬边界：

- AIHub 版本已删除。
- 不再使用钉钉官方托管 MCP 网关 URL 或网关 `key`。
- 不再配置 `MCP_PLATFORM_API_KEY`。
- 不再暴露 `/platform/tools/approval_task` 或任何 `/platform/tools/*` 路由。
- 钉钉开发者后台只负责企业应用凭据、OAuth 回调 URI 和 OpenAPI 权限。
- 客户端配置、联调步骤见 [`client-config-templates.md`](./client-config-templates.md)。
