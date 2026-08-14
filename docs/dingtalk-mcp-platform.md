# 钉钉 MCP 开发平台部署方案

## 架构结论

`MWE审批MCP` 只使用钉钉 MCP 开发平台托管的对外 MCP 网关。`approval_task` 新版本发布后，审批人组合工具的普通 HTTP 动作由平台转发到本仓库部署在 CVM 的 HTTPS 后端：

```text
客户端 --Streamable HTTP--> mcp-gw.dingtalk.com
       --平台 HTTP 动作--> dingtalk.mwexk.com/platform/tools/approval_task
       --OpenAPI--> api.dingtalk.com
```

- 对外 MCP Server URL：官方文档说明服务通过钉钉统一网关；2026-08-12 从钉钉官方 MCP 市场实际取得的 `MWE审批MCP` 版本 1 配置使用 `streamable-http`，主机为 `mcp-gw.dingtalk.com`，可确认当前 MCP 网关由钉钉托管。
- 组合工具目标动作 URL：由我们托管。该 URL 只是平台调用的普通 HTTP API，不是 MCP Server URL，也不会提供给 MCP 客户端。
- 旧的平台直连工具在组合工具版本正式发布前仍直接使用 `api.dingtalk.com`，由平台保存的 Token 鉴权注入访问令牌。
- 本项目不暴露 `/mcp`，不使用 Deap 自定义 MCP URL，也没有自托管 MCP 回退。
- 不提供 stdio。

## 2026-08-12 至 2026-08-14 平台验收与当前发布边界

- 使用当前登录账号最近已处理的一条真实审批实例，经钉钉 MCP 开发平台已保存的 `MWE审批MCP` Token 凭证读取到 1 个 `operationRecords[].attachments[]` 附件。
- 以官方字段 `withCommentAttatchment=true` 调用 `POST /v1.0/workflow/processInstances/spaces/files/urls/download` 成功获得临时下载地址；实际下载 HTTP 200、122,165 字节。附件为 1 页、未加密 PDF，可提取文本并能正常渲染。
- 2026-08-14 实测客户端手选本地文件形成的表单附件虽然也会返回 `spaceId`，但以该空间调用 `authDownload` 会返回 `noPermission`；直接向下载地址接口提交 `processInstanceId + fileId + fileName + fileType` 则成功。服务端因此优先采用完整文件标识直取，仅在缺少这组标识时保留 `spaceId` 授权链路。
- 同轮实测下载接口返回 `http://*.aliyuncs.com` 签名地址；同主机改用 HTTPS 后下载成功。代码只对已通过白名单的 `.aliyuncs.com` 初始地址强制升级 HTTPS，绝不执行明文下载，其他 HTTP 域名仍被拒绝。
- 全程未出现 401、403 或权限不足错误，因此本轮不需要再申请权限。
- 旧版 `0.3.1` 曾在 CVM 生产后端经公网 HTTPS 读取最近两个真实审批，并把 19 个表单附件以 Base64 返回。`0.4.0` 已移除该高资源链路：后端只换取经校验的临时链接，Agent 客户端负责下载、文件识别、解析和 OCR。
- `get_approval_instance` 已更新为版本 2，工具入参使用顶层 `processInstanceId`，经最近两个真实审批实例验证可返回表单内容、操作记录、表单附件和评论附件元数据；仍不返回附件正文。
- `start_process_instance` 已发布版本 1，HTTP 动作为 `POST https://api.dingtalk.com/v1.0/workflow/processInstances`。正式 schema 必填 `confirm`、`processCode`、`deptId`、`formComponentValues`；`originatorUserId` 固定映射平台“系统参数.操作用户id”，不暴露给 Agent；不开放 `approvers`，默认复用 OA 后台审批流程。
- 发起工具使用不存在的 processCode 做负向联调，OA 返回 HTTP 400 `processCodeError`，证明 Token、请求体和当前用户映射已经进入业务校验，且没有创建审批实例。真实发起必须等待用户确认具体模板、部门和全部表单内容。
- AIHub 平台版本现已删除，因此当前没有可调用的官方网关版本；重新发布会生成新的 Streamable HTTP URL，旧配置不能复用。
- 官方 FAAS 文档只说明公开入参映射到 `input`。实测 FAAS 可发网络请求，但不会自动继承已保存的 Token 鉴权；直接请求钉钉 OpenAPI 返回缺少鉴权参数。为避免把 AppSecret 暴露为工具入参或写进脚本，正式组合工具必须使用下方 HTTPS 工具后端方案。

官方说明：

- [钉钉 MCP 广场介绍](https://open.dingtalk.com/document/development/mcp-square-introduction)：服务经钉钉统一网关，平台负责升级、替换、监控和 SLA 等治理。
- [阿里云百炼使用钉钉 MCP 服务](https://open.dingtalk.com/document/development/alibaba-cloud-uses-dingtalk-mcp-services)：客户端配置类型为 Streamable HTTP。

## 当前平台与迁移配置

CVM 代码后端已生产部署。钉钉 AIHub 平台版本已删除，重新发布时只创建一个审批人工具：

| 工具 | HTTP 动作 | 当前边界 |
|---|---|---|
| `approval_task` | `POST https://dingtalk.mwexk.com/platform/tools/approval_task` | 查看、临时附件链接、同意、拒绝 |

平台通过 Bearer Key 调用代码后端；代码后端再使用企业内部应用凭证调用钉钉 OpenAPI。`confirm`、固定调用人、持久化幂等、allowlist 和审计均由代码后端实施。

## 代码后端配置

部署时已注入平台到后端的随机密钥，至少 32 UTF-8 字节：

```text
MCP_PLATFORM_API_KEY=<仅供钉钉平台调用工具动作的密钥>
# 临时附件链接允许的官方 Host 后缀
APPROVAL_DOWNLOAD_HOST_SUFFIXES=.dingtalk.com,.alicdn.com,.aliyuncs.com
```

反向代理必须提供 HTTPS，并把实际后端域名加入 `APPROVAL_BACKEND_ALLOWED_HOSTS`。不要把 Node.js 明文端口直接暴露到公网。

钉钉平台中每个工具的 HTTP 设置相同：

```text
方法: POST
URL: https://dingtalk.mwexk.com/platform/tools/approval_task
Header: Authorization: Bearer <MCP_PLATFORM_API_KEY>
Content-Type: application/json
Body: 工具参数对象
```

`MCP_PLATFORM_API_KEY` 是平台到我们后端的鉴权；它与 MCP 客户端访问钉钉网关时使用的凭据不是同一个概念。

## 工具端点

| 工具 | 后端路径 |
|---|---|
| `approval_task`（唯一公网工具动作） | `/platform/tools/approval_task` |

参数 Schema、说明、读写标注以 `src/mcp/create-server.ts` 为唯一代码事实源。公网 HTTP 适配器只装载公共 catalog，因此端点形状的内部兼容工具返回 404。

代码后端正常 Agent 工具清单只发布 `approval_task`：

- `action=view`：一次返回审批内容、操作记录、评论、当前可操作任务和附件元数据；`attachmentAction=download` 时在同一调用中完成选定附件的授权、临时地址换取和逐文件 ledger。Agent 必须自行下载并识别/解析/OCR，服务端不访问附件正文。
- `action=approve`：要求 `processInstanceId + taskId + requestId + confirm`，服务端原子预留幂等键、重新读取任务并校验固定调用人后再同意。
- `action=reject`：与同意共用状态机和持久化幂等账本，但强制要求非空 `remark`。
- 三个动作统一返回实例 ID、动作、当前状态、本地审计关联 ID、安全后续动作和数据 envelope。

端点形状的旧操作仅保留为进程内兼容 catalog，不进入正常 MCP `tools/list`，也不通过公网 HTTP 后端发布。发起、撤销属于申请人角色，不能混入审批人的 `approval_task`；在对外发布代码版申请人能力前应另行聚合为 `approval_request`。

## 开发者平台操作顺序

1. 已部署本项目 HTTPS 后端，并验证 `GET /healthz`、精确工具路径、Bearer 鉴权和未知路由 404。
2. 重新编辑而不是原地修改已发布版本，在平台新增或更新 `approval_task`，把 HTTP 动作指向 `/platform/tools/approval_task`。
3. 写动作必须明确标注真实副作用；操作者由代码后端固定绑定，不能把可伪造的操作者 ID 暴露给 Agent。
4. 发布后在 AIHub 重置服务以刷新工具清单，并立即更新客户端保存的完整 Streamable HTTP 配置。
5. 只接受平台生成的 `streamable-http` 配置，并确认 URL 主机严格为 `mcp-gw.dingtalk.com`；URL 中的 `key` 只放入调用端密钥存储。
6. 代码后端提供完整的 `dryRun`、服务端确认、调用人/userId/processCode allowlist、持久化幂等和审计语义；对外 MCP 域名仍保持钉钉官方托管。
