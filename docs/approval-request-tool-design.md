# approval_request 首版设计

## 范围

`approval_request` 是申请人侧的一体化工具，聚合准备附件、提交审批、添加评论和撤销审批等同生命周期动作。采用默认拒绝和精确允许列表：

| 模板键 | OA 模板 | 固定 processCode | 附件字段 |
|---|---|---|---|
| `expense_reimbursement` | 费用报销 | `PROC-2DB91B79-3CDD-421D-A223-0489A7BAB2C0` | `invoice`、`other` |
| `payment_request` | 付款申请 | `PROC-5E238117-7121-4CB3-8219-9F11A2E42BE4` | `attachment` |

加班审批和所有未列出的模板均不发布，也不接受自由 `processCode`。

## 安全边界

- 申请人 `userId` 和 `unionId` 来自本站 OAuth 绑定身份；客户端不能覆盖。
- `deptId` 是可选的部门消歧提示，不是身份参数。服务端始终查询申请人的钉钉部门列表：单部门时自动选取并忽略客户端遗留的错误提示；多部门且未提供有效选择时返回 `DEPARTMENT_SELECTION_REQUIRED` 和部门 ID/名称候选。
- 不接受审批人、抄送人、流程节点或申请人参数，完全沿用 OA 后台流程。
- 每次 `prepare`/`submit` 前读取线上模板 Schema，精确核对模板类型、控件 ID/名称/类型，以及代码使用的固定选项键；任何漂移均失败关闭。
- `approval_request` 要求 `approval:read` 与独立的 `approval:create` OAuth scope。写操作仍要求明确 `confirm=true`。
- `submit` 和实际 `revoke` 均使用稳定 UUID `requestId` 和持久幂等账本；账本命名空间绑定 OAuth 申请人。附件提交、审批创建或撤销结果不确定时禁止自动重放。
- `comment` 仅允许操作当前 OAuth 用户本人发起且属于模板允许列表的实例，评论人由服务端注入；文本限制 1–1024 字符，真实写入要求 `confirm=true` 和稳定 UUID `requestId`，结果不确定时禁止自动重放。

## 草稿能力边界

钉钉官方 OA 公开服务端 API 当前没有保存到钉钉客户端草稿箱的接口；`POST /v1.0/workflow/processInstances` 只有正式创建实例语义，也没有草稿参数。项目不发布会造成误解的 `draft` 动作：`prepare` 和 `submit + dryRun=true` 是无提交预检，可验证实时模板、部门、字段与最终请求，但不会生成钉钉草稿箱条目。

## 审批评论

文本评论通过官方 `POST /v1.0/workflow/processInstances/comments` 写入。公开 Schema 不接受 `commentUserId`，服务端使用 OAuth 绑定的申请人 userId；写入前重新读取审批详情，核对发起人与模板允许列表。官方接口支持评论附件元数据，但其公开上传说明依赖 H5/小程序钉盘 JSAPI，首版保持文本评论，不接受未经服务端建立与验证的评论附件身份。

## 附件直传链路

MCP 服务端不接收文件字节，不解析文件，也不执行 OCR：

1. `prepare` 校验表单与附件元数据，并向钉钉申请审批空间和签名上传信息。
2. MCP 只向 Agent 返回经过 HTTPS Host 允许列表校验的 `PUT uploadUrl`、请求头、`uploadKey` 和 `spaceId`。
3. Agent 直接把文件上传到钉钉，不跟随上传重定向。
4. `submit` 重新确认当前用户的审批空间，提交 `uploadKey`，取得 `fileId` 后写入审批附件控件并发起审批。

限制为单文件 20 MiB、每单 10 个文件、合计 50 MiB。上传 URL 默认只允许 `.aliyuncs.com`，可通过 `APPROVAL_UPLOAD_HOST_SUFFIXES` 收紧或调整。

## 外部配置门禁

无附件审批不依赖 AgentId。启用附件必须同时满足：

- `MWE审批MCP` 应用具备 H5 微应用能力并配置正整数 `DINGTALK_AGENT_ID`。
- 应用已开通审批实例写、审批表单读、`Storage.UploadInfo.Read` 与 `Storage.File.Write`。
- 线上回归验证审批空间、签名上传、文件提交和审批创建完整链路。

任何门禁缺失时，附件 `prepare` 必须返回明确配置或钉钉权限错误，不得退化为让文件字节经过 MCP。
