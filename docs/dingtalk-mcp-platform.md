# 钉钉 MCP 开发平台部署方案

## 架构结论

`MWE审批MCP` 只使用钉钉 MCP 开发平台托管的对外 MCP 网关。当前工具直接在平台配置，未来工具数量增加、更新频繁时再把普通 HTTP 动作切换到本仓库后端：

```text
客户端 --Streamable HTTP--> mcp-gw.dingtalk.com
       --平台当前 HTTP 动作--> api.dingtalk.com

未来代码模式：
客户端 --Streamable HTTP--> mcp-gw.dingtalk.com
       --平台 HTTP 动作--> 我们部署的 HTTPS 工具后端
       --OpenAPI--> api.dingtalk.com
```

- 对外 MCP Server URL：官方文档说明服务通过钉钉统一网关；2026-08-12 从钉钉官方 MCP 市场实际取得的 `MWE审批MCP` 版本 1 配置使用 `streamable-http`，主机为 `mcp-gw.dingtalk.com`，可确认当前 MCP 网关由钉钉托管。
- 当前工具动作 URL：直接使用钉钉官方 `api.dingtalk.com`，由平台保存的 Token 鉴权注入访问令牌。
- 未来代码版工具动作 URL：由我们托管。该 URL 只是平台调用的普通 HTTP API，不是 MCP Server URL，也不会提供给 MCP 客户端。
- 本项目不暴露 `/mcp`，不使用 Deap 自定义 MCP URL，也没有自托管 MCP 回退。
- 不提供 stdio。

## 2026-08-12 至 2026-08-13 平台验收与当前发布边界

- 使用当前登录账号最近已处理的一条真实审批实例，经钉钉 MCP 开发平台已保存的 `MWE审批MCP` Token 凭证读取到 1 个 `operationRecords[].attachments[]` 附件。
- 以官方字段 `withCommentAttatchment=true` 调用 `POST /v1.0/workflow/processInstances/spaces/files/urls/download` 成功获得临时下载地址；实际下载 HTTP 200、122,165 字节。附件为 1 页、未加密 PDF，可提取文本并能正常渲染。
- 2026-08-14 实测客户端手选本地文件形成的表单附件不返回 `spaceId`；此类文件不能调用 `authDownload`，而应直接向同一下载地址接口提交 `processInstanceId + fileId + fileName + fileType`。服务端已按该分支实现，并保留带 `spaceId` 表单附件的授权链路。
- 全程未出现 401、403 或权限不足错误，因此本轮不需要再申请权限。临时下载地址、PDF、PNG 和剪贴板内容均已清理。
- `get_approval_instance` 已更新为版本 2，工具入参使用顶层 `processInstanceId`，经最近两个真实审批实例验证可返回表单内容、操作记录、表单附件和评论附件元数据；仍不返回附件正文。
- `start_process_instance` 已发布版本 1，HTTP 动作为 `POST https://api.dingtalk.com/v1.0/workflow/processInstances`。正式 schema 必填 `confirm`、`processCode`、`deptId`、`formComponentValues`；`originatorUserId` 固定映射平台“系统参数.操作用户id”，不暴露给 Agent；不开放 `approvers`，默认复用 OA 后台审批流程。
- 发起工具使用不存在的 processCode 做负向联调，OA 返回 HTTP 400 `processCodeError`，证明 Token、请求体和当前用户映射已经进入业务校验，且没有创建审批实例。真实发起必须等待用户确认具体模板、部门和全部表单内容。
- AIHub 重置后官方网关 `tools/list` 返回 3 个工具，并验证上述发起工具 schema；重置会更新 Streamable HTTP URL，旧配置必须替换。
- 官方 FAAS 文档只说明公开入参映射到 `input`。实测 FAAS 可发网络请求，但不会自动继承已保存的 Token 鉴权；直接请求钉钉 OpenAPI 返回缺少鉴权参数。为避免把 AppSecret 暴露为工具入参或写进脚本，正式组合工具必须使用下方 HTTPS 工具后端方案。

官方说明：

- [钉钉 MCP 广场介绍](https://open.dingtalk.com/document/development/mcp-square-introduction)：服务经钉钉统一网关，平台负责升级、替换、监控和 SLA 等治理。
- [阿里云百炼使用钉钉 MCP 服务](https://open.dingtalk.com/document/development/alibaba-cloud-uses-dingtalk-mcp-services)：客户端配置类型为 Streamable HTTP。

## 当前平台直连配置

当前不部署自建服务器。钉钉 MCP 开发平台中的正式工具为：

| 工具 | 平台版本 | HTTP 动作 | 当前边界 |
|---|---:|---|---|
| `get_approval_capabilities` | 1 | 钉钉 FaaS | 返回能力说明 |
| `get_approval_instance` | 2 | `GET /v1.0/workflow/processInstances` | 详情和附件元数据 |
| `start_process_instance` | 1 | `POST /v1.0/workflow/processInstances` | 当前用户发起，复用 OA 后台流程 |

两个直连 OA OpenAPI 的工具使用平台已保存的企业内部应用 Token 鉴权；能力查询由钉钉 FaaS 返回静态说明，不依赖该 Token，且 FaaS 不会自动继承它。发起工具只把公开参数映射到请求体，并把系统操作用户 ID 映射到 `originatorUserId`。`confirm` 是必填的 Agent 安全契约，但平台直连 HTTP 动作无法像代码后端一样实施持久化幂等、allowlist 和服务端二次确认；这些增强能力保留在仓库实现中。

## 未来代码后端配置

部署时注入平台到后端的随机密钥，至少 32 UTF-8 字节：

```text
MCP_PLATFORM_API_KEY=<仅供钉钉平台调用工具动作的密钥>
# 组合调用中 Base64 附件正文的总字节预算
APPROVAL_ATTACHMENT_BATCH_MAX_BYTES=15728640
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
| `approval_task`（正常 Agent 唯一审批人工具） | `/platform/tools/approval_task` |
| `get_approval_capabilities` | `/platform/tools/get_approval_capabilities` |
| `get_approval_instance`（首选组合工具） | `/platform/tools/get_approval_instance` |
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

代码后端启用后，正常 Agent 工具清单只发布 `approval_task`：

- `action=view`：一次返回审批内容、操作记录、评论、当前可操作任务和附件元数据；`attachmentAction=read` 时在同一调用中完成选定附件的授权、临时地址换取、安全下载和逐文件 ledger。
- `action=approve`：要求 `processInstanceId + taskId + requestId + confirm`，服务端原子预留幂等键、重新读取任务并校验固定调用人后再同意。
- `action=reject`：与同意共用状态机和持久化幂等账本，但强制要求非空 `remark`。
- 三个动作统一返回实例 ID、动作、当前状态、本地审计关联 ID、安全后续动作和数据 envelope。

其余表中的端点仅是钉钉平台迁移期兼容面或内部管理面，不进入正常 MCP `tools/list`。发起、撤销属于申请人角色，不能混入审批人的 `approval_task`；在对外发布代码版申请人能力前应另行聚合为 `approval_request`。

## 开发者平台操作顺序

1. 当前阶段直接在钉钉 MCP 开发平台配置官方 OpenAPI HTTP 动作，优先交付小而稳定的工具。
2. 写工具必须明确标注真实副作用，使用平台系统身份映射，避免把可伪造的操作者 ID 暴露给 Agent。
3. 发布后在 AIHub 重置服务以刷新工具清单，并立即更新客户端保存的完整 Streamable HTTP 配置。
4. 只接受平台生成的 `streamable-http` 配置，并确认 URL 主机严格为 `mcp-gw.dingtalk.com`；URL 中的 `key` 只放入调用端密钥存储。
5. 当工具数量和变更频率使平台逐项配置难以维护时，部署本项目 HTTPS 后端，先验证 `GET /healthz`，再把审批人动作统一切换到 `/platform/tools/approval_task`。
6. 代码后端启用后恢复完整的 `dryRun`、服务端确认、调用人/userId/processCode allowlist、持久化幂等和审计语义；对外 MCP 域名仍保持钉钉官方托管。
