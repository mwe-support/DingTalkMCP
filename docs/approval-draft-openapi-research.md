# 钉钉 OA 审批草稿与评论 OpenAPI 调研

调研日期：2026-08-17

## 结论

1. **没有找到企业内部应用可调用的、把普通 OA 审批实例保存到钉钉“草稿箱”的服务端 OpenAPI。** 当前官方 OA 审批 API 目录、正式发起接口请求模型和官方 `workflow_1_0` SDK 都没有 draft/save-as-draft 动作或草稿状态参数。
2. 普通 OA 的服务端写入入口是正式发起：`POST /v1.0/workflow/processInstances`。成功即返回 `instanceId`，进入真实审批流程，不是草稿。
3. `PremiumSaveFormInstance`、`PremiumSaveIntegratedProcessInstance` 等名称包含 `Save` 的接口不是普通 OA 审批草稿：前者创建 OA 高级版“数据表单实例”，后者创建/保存“流程中心外部集成实例”，对象、权限和产品版本均不同。
4. **存在普通 OA 审批评论写入接口**：`POST /v1.0/workflow/processInstances/comments`。它支持正文、图片 URL 和最多 20 个审批钉盘附件，仅支持企业内部应用，所需权限为 `Workflow.Instance.Write`（“工作流实例写权限”）。
5. 对本 MCP，建议继续把 `prepare`/`dryRun` 作为无钉钉副作用的服务端预检。如果需要可恢复的“草稿”，只能先实现为本项目自己的本地草稿；它不会出现在钉钉草稿箱。评论应作为同一 applicant-facing `approval_request` 工具的 action，而不是新增零散工具。

## 一、普通 OA 审批草稿

### 1. 官方目录和 SDK 的证据

钉钉开放平台把 OA 审批列为独立能力目录。调研时读取其官方 OA 审批 OpenAPI 列表，共返回 58 个条目；其中包含正式发起、撤销、评论、任务操作、附件、模板及 OA 高级版能力，但没有“保存审批草稿”“创建审批草稿”或“草稿箱”接口。对同一官方目录以“草稿”检索，结果为 0。

- [OA 审批能力总览](https://open.dingtalk.com/document/orgapp/workflow-overview)
- [官方 OA 审批 OpenAPI 目录接口](https://open.dingtalk.com/api/backstage/getOpenApiList?pageNo=1&pageSize=200&categoryCode=BACK%23oa_approval)
- [官方 OA 审批目录中的“草稿”检索](https://open.dingtalk.com/api/backstage/getOpenApiList?pageNo=1&pageSize=200&categoryCode=BACK%23oa_approval&keywords=%E8%8D%89%E7%A8%BF)

官方 Go SDK 的 `workflow_1_0` 模块同样没有 `Draft` 请求类型或方法。普通审批实例写入方法为 `StartProcessInstance`，请求被发往 `POST /v1.0/workflow/processInstances`；响应只返回 `instanceId`。

- [官方 Go SDK：StartProcessInstance 请求模型](https://github.com/alibabacloud-go/dingtalk/blob/3077c44e195cee47a1036c5fc98bbb625399f4de/workflow_1_0/client.go#L19707-L20068)
- [官方 Go SDK：StartProcessInstance 路径与方法](https://github.com/alibabacloud-go/dingtalk/blob/3077c44e195cee47a1036c5fc98bbb625399f4de/workflow_1_0/client.go#L27136-L27223)

### 2. 正式发起接口不是草稿

正式发起接口：

```http
POST /v1.0/workflow/processInstances
Host: api.dingtalk.com
```

主要请求字段为：

- `originatorUserId`：发起人 userId，必填；
- `processCode`：审批模板唯一码，必填；
- `deptId`：发起人部门；
- `microappAgentId`；
- `formComponentValues`：表单控件列表，必填；
- `approvers`、`ccList`、`ccPosition`、`targetSelectActioners` 等流程参与字段。

接口模型没有 `draft`、`saveAsDraft`、`status=DRAFT` 或草稿 ID 字段；成功响应为真实审批 `instanceId`。当前项目已经禁止模型修改审批人、抄送人和流程节点，因此即使官方接口包含这些字段，也不应向 MCP 客户端开放。

- [钉钉官方：发起审批实例](https://open.dingtalk.com/document/development/create-an-approval-instance)

### 3. 名称含 Save 的 OA 高级版接口不是普通审批草稿

官方 SDK/目录中的以下能力容易被误判为草稿：

| 接口 | 路径 | 实际对象 | 限制 |
|---|---|---|---|
| `PremiumSaveFormInstance` | `POST /v1.0/workflow/premium/dataForms/formInstances/save` | 创建“数据表单实例”，不是流程中的普通 OA 审批草稿 | OA 高级版专享；权限 `Premium.Workflow.ReadWrite.All` |
| `PremiumSaveIntegratedProcessInstance` | `POST /v1.0/workflow/premium/processCentres/instances` | 创建/保存“流程中心外部集成实例” | 高级版专享；外部集成模型，不是普通模板草稿箱 |
| 模板 schema 的 `status=SAVED` | 读取模板 schema 时返回 | 模板本身处于草稿状态 | 指模板设计稿，不是员工填写中的审批实例草稿 |

- [官方权限目录：`Premium.Workflow.ReadWrite.All`](https://open.dingtalk.com/api/official/scope/list)
- [官方 Go SDK：创建数据表单实例](https://github.com/alibabacloud-go/dingtalk/blob/3077c44e195cee47a1036c5fc98bbb625399f4de/workflow_1_0/client.go#L25574-L25652)
- [官方 Go SDK：保存流程中心外部集成实例](https://github.com/alibabacloud-go/dingtalk/blob/3077c44e195cee47a1036c5fc98bbb625399f4de/workflow_1_0/client.go#L25748-L25827)
- [钉钉官方：获取数据表单 schema](https://open.dingtalk.com/document/development/api-premiumgetformschema)

### 4. 与客户端 JSAPI、dryRun、本地草稿的区别

| 机制 | 是否写入钉钉草稿箱 | 是否启动真实流程 | 说明 |
|---|---:|---:|---|
| 正式发起 OpenAPI | 否 | 是 | 成功即产生 `instanceId` |
| 附件上传/选择 JSAPI | 否 | 否 | 只在钉钉客户端选择并上传附件，取得 `spaceId`、`fileId` 等元数据，随后仍需正式发起/评论 OpenAPI |
| MCP `dryRun` / `prepare` | 否 | 否 | 本项目的预检语义，不是钉钉官方资源或状态 |
| 本地草稿 | 否 | 否 | 如实现，应由本项目持久化、加密、设定所有者与 TTL；只用于恢复/复核输入 |
| 钉钉客户端内部草稿 | 可能由客户端产品提供 | 否 | 本次没有发现受支持的服务端 OpenAPI；不应调用未公开或抓包得到的私有接口 |

附件 JSAPI 是客户端交互能力，不等同于审批草稿接口：

- [钉钉官方：上传附件到钉盘/从钉盘选择文件](https://open.dingtalk.com/document/development/jsapi-upload-attachment-to-ding-talk)
- [钉钉官方：服务端 API 发起带附件审批](https://open.dingtalk.com/document/orgapp/initiate-an-approval-flow-with-attachments)

### 5. 证据边界

“没有普通 OA 草稿 OpenAPI”是基于截至 2026-08-17 的公开官方 API 目录、官方文档和官方生成 SDK 得出的结论。它不等于断言钉钉客户端内部没有草稿实现，也不覆盖私有接口、灰度能力或未来新增接口。后续若钉钉正式发布草稿 API，应重新核对应用类型、权限、模板范围、草稿所有者及提交转换语义后再接入。

## 二、普通 OA 审批评论写入

### 1. 接口、应用类型与权限

```http
POST /v1.0/workflow/processInstances/comments
Host: api.dingtalk.com
x-acs-dingtalk-access-token: <enterprise app access token>
Content-Type: application/json
```

- 企业内部应用：支持；
- 第三方企业应用：暂不支持；
- 第三方个人应用：暂不支持；
- 权限显示名：工作流实例写权限；
- `scopeValue`：`Workflow.Instance.Write`。

官方权限目录对该 scope 的描述包括查询钉盘空间、新建评论与实例、修改实例状态等能力，并明确把“添加审批评论”列在其 API 清单中。

- [钉钉官方：添加审批评论](https://open.dingtalk.com/document/development/official-approval-adds-approval-comments)
- [钉钉官方权限目录](https://open.dingtalk.com/api/official/scope/list)
- [官方 Go SDK：评论请求与附件模型](https://github.com/alibabacloud-go/dingtalk/blob/3077c44e195cee47a1036c5fc98bbb625399f4de/workflow_1_0/client.go#L702-L862)
- [官方 Go SDK：评论接口路径与方法](https://github.com/alibabacloud-go/dingtalk/blob/3077c44e195cee47a1036c5fc98bbb625399f4de/workflow_1_0/client.go#L20832-L20895)

### 2. 请求字段

| 字段 | 必填 | 说明 |
|---|---:|---|
| `processInstanceId` | 是 | 目标审批实例 ID |
| `text` | 是 | 评论正文，最大 1024 字符 |
| `commentUserId` | 是 | 评论人的 userId |
| `file` | 否 | 图片与附件容器 |
| `file.photos` | 否 | 图片 URL 数组 |
| `file.attachments` | 否 | 附件数组，最多 20 个 |
| `attachments[].spaceId` | 否 | 审批钉盘空间 ID |
| `attachments[].fileId` | 否 | 文件 ID，最大 256 字符 |
| `attachments[].fileName` | 否 | 文件名，最大 256 字符 |
| `attachments[].fileSize` | 否 | 文件大小 |
| `attachments[].fileType` | 否 | 文件类型 |

评论附件需要先获取审批钉盘空间，再由网页应用/小程序的附件 JSAPI 上传或选择文件，取得上述元数据后调用评论 OpenAPI。接口响应为 `result`、`success` 两个 Boolean 字段。

### 3. 评论人身份约束

官方接口技术上通过必填的 `commentUserId` 指定评论人；企业应用 access token 本身不是最终用户身份。官方文档没有给出“任意代写评论”的授权承诺，因此 MCP 不应把 `commentUserId` 暴露为模型可控参数。应由服务端使用已验证 MCP 调用者绑定的钉钉 `userId` 注入，并在写入前确认该用户与实例的业务关系。

### 4. 评论读取关系

评论没有独立的普通 OA “评论列表”读取接口。调用“获取单个审批实例详情”时，评论随 `operationRecords` 返回：

- 独立添加评论的记录类型为 `ADD_REMARK`；
- `operationRecords[].userId`：评论/操作人；
- `operationRecords[].date`：时间；
- `operationRecords[].remark`：评论正文；
- `operationRecords[].attachments`：评论附件元数据，包括 `fileName`、`fileSize`、`fileId`、`fileType`、`spaceId`；
- `operationRecords[].images`：图片链接。

审批动作本身也可能附带评论，所以不能只按“有 remark”判断独立评论；应结合 `type`（尤其 `ADD_REMARK`）和 `result` 解析。评论写入后可通过重新读取实例详情验证 `operationRecords` 是否出现对应记录。

- [钉钉官方：获取单个审批实例详情](https://open.dingtalk.com/document/development/get-details-single-approval-instance)
- [官方 Go SDK：operationRecords 与评论附件字段](https://github.com/alibabacloud-go/dingtalk/blob/3077c44e195cee47a1036c5fc98bbb625399f4de/workflow_1_0/client.go#L4354-L4718)

### 5. 对 MCP 工具设计的影响

- 保持一个 applicant-facing `approval_request` 工具，用 `action` 区分 `prepare`、`submit`、`revoke`、`comment` 等同一申请人生命周期动作。
- `comment` 是真实写操作，应要求 `confirm: true`、幂等保护和结构化审计；`dryRun` 仅返回将要评论的实例、文本摘要、附件数量和绑定评论人，不调用钉钉。
- `commentUserId` 服务端注入；不允许客户端覆盖。
- 评论附件仅传经过校验的钉盘元数据，不由 MCP 服务端下载、解析或 OCR。
- 写入成功后重读实例详情，在 `operationRecords` 中验证 `ADD_REMARK`；若钉钉写入成功而审计落盘部分失败，应保留原业务结果并标记审计不完整，避免客户端重试造成重复评论。

