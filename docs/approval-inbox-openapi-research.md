# 钉钉 OA 待审批收件箱 OpenAPI 调研

调研日期：2026-08-17
适用目标：自建 `MWE审批MCP` 的独立只读 `approval_inbox` 工具

## 结论

1. **企业内部应用有官方公开 API 可以按 `userId` 批量查询待处理审批任务，但它是 OA 高级版专享接口。**

   ```http
   GET /v1.0/workflow/premium/processCentres/todoTasks
   Host: api.dingtalk.com
   x-acs-dingtalk-access-token: <企业内部应用 accessToken>
   ```

2. 接口名为 `PremiumGetTodoTasks`，仅支持企业内部应用，需开通 OA 高级版和权限 `Premium.Workflow.ReadWrite.All`（界面名称“OA审批工作流读写权限（OA高级版专享）”）。未开通或已过期会返回 `benefit.status.invalid`。
3. 它一次最多返回 20 条，`pageNumber` 为 1–10，所以在同一 `createBefore` 窗口内官方明确的最大页面覆盖是 200 条。官方未说明超过 200 条后的无重无漏全量遍历规则，MCP 不应承诺无上限全量。
4. 返回的每条摘要同时包含 `processInstanceId` 和 `taskId`，可直接作为后续 `approval_task` 逐实例查看、同意或拒绝的发现入口。
5. 待处理列表只是摘要，不包含完整表单、附件、评论和全部操作历史。详情仍需对所选 `processInstanceId` 逐个调用 `GetProcessInstance`。
6. DWS 的 `dws oa approval list-pending` / `list_pending_approvals` **不是企业应用 OpenAPI 实现**：它把参数转发给钉钉官方 `mcp-gw.dingtalk.com` 的 OA MCP，并使用 DWS 用户 OAuth Bearer/行为授权链路。可复用其工具契约和输出投影思路，不应让自建 MCP 在运行时依赖 DWS。

## 一、官方直接 API：`PremiumGetTodoTasks`

### 1. 应用、权限和令牌

| 项目 | 结论 |
|---|---|
| 应用类型 | 企业内部应用；官方页面未列出第三方企业/个人应用支持 |
| 产品前提 | OA 高级版权益已开通且未过期 |
| 权限名称 | OA审批工作流读写权限（OA高级版专享） |
| `scopeValue` | `Premium.Workflow.ReadWrite.All` |
| API 凭证 | 企业内部应用 `AppKey/AppSecret` 换取的应用 `accessToken` |
| Header | `x-acs-dingtalk-access-token` |
| 是否需要钉钉用户 `userAccessToken` | 不需要 |

MCP 的“当前用户”仍由自建 MCP OAuth 登录得到的 `corpId + unionId + userId` 绑定。对钉钉 OpenAPI 的真实请求使用企业应用 token，但 Query 中的 `userId` 必须由服务端从已验证 caller context 注入，禁止 Agent 客户端自由传入任意员工 ID。

官方证据：

- [查询审批中心用户待处理任务列表](https://open.dingtalk.com/document/development/api-premiumgettodotasks)
- [官方权限映射：`Premium.Workflow.ReadWrite.All`](https://open.dingtalk.com/api/official/scope/list)

### 2. HTTP 契约

```http
GET /v1.0/workflow/premium/processCentres/todoTasks
    ?userId=<caller.userId>
    &pageSize=<1..20>
    &pageNumber=<1..10>
    &createBefore=<optional UTC yyyy-MM-ddTHH:mmZ>
Host: api.dingtalk.com
x-acs-dingtalk-access-token: <enterprise app accessToken>
```

| 字段 | 必填 | 约束 | MCP 处理 |
|---|---:|---|---|
| `userId` | 是 | OA 审批任务执行人 | 由服务端注入 `caller.userId`，不出现在公开 Schema |
| `pageSize` | 是 | 1–20 | 由 `limit` 和剩余条数计算，每次上游调用不超过 20 |
| `pageNumber` | 是 | 1–10 | 封装在服务端发出的不透明 `cursor` 中，不鼓励 Agent 自行组装 |
| `createBefore` | 否 | 只取创建时间小于该值的任务；官方 Go SDK 标注 UTC `yyyy-MM-ddTHH:mmZ` | 首次请求由服务端冻结查询时间并放入 cursor；在真实联调确认时区行为前，不向公开 Schema 暴露原始字符串 |

官方生成 Go SDK 与文档一致：

- [请求与响应模型（固定 SHA）](https://github.com/alibabacloud-go/dingtalk/blob/3077c44e195cee47a1036c5fc98bbb625399f4de/workflow_1_0/client.go#L11819-L11935)
- [HTTP 路径、GET 方法与 Header 实现（固定 SHA）](https://github.com/alibabacloud-go/dingtalk/blob/3077c44e195cee47a1036c5fc98bbb625399f4de/workflow_1_0/client.go#L24905-L24967)

### 3. 分页和数量上限

- `pageSize`：1–20。
- `pageNumber`：1–10。
- 返回 `hasMore`，但没有 `nextToken`。
- 因此一个固定 `createBefore` 窗口最多有 10 页、200 条官方定义的可达范围。
- 官方未定义超过第 10 页后如何用新的 `createBefore` 无重无漏地继续。若真实生产出现超过 200 条待办，工具应返回 `truncated=true` / `paginationLimitReached=true`，不应假装已全量读取。
- 待办集合在查询期间可变。首次查询冻结 `createBefore`可减少新建任务导致的页面漂移，但任务被处理/转交仍可能让后续页面发生变化。客户端应以 `taskId + processInstanceId` 去重，不应将 cursor 视为强一致快照。

## 二、返回字段与归一化

### 1. 待处理列表原始字段

`result.list[]` 包含：

| 字段 | 含义 |
|---|---|
| `taskId` | 当前待处理任务 ID |
| `processInstanceId` | 审批实例 ID，必须在 MCP 结果中保留 |
| `status` | 流程状态；官方示例为 `RUNNING` |
| `title` | 标题 |
| `processCreateTime` | 实例发起时间，ISO 8601 |
| `processEndTime` | 实例完成时间，ISO 8601；运行中可能为空 |
| `originatorId` / `originatorName` / `originatorPhoto` | 发起人信息 |
| `formMassage` | 官方字段的原始拼写，含义为摘要；MCP 可归一化为 `summary` |
| `url` | 详情页链接；应按安全策略检验协议和主机后再返回 |
| `activityId` | 当前任务节点 ID |
| `processType` | `0` 官方 OA，`1` 自有 OA |
| `appType` | `0` 流程表单，`1` 数据表单，`2` 办事流程 |

顶层还有 `success` 和 `hasMore`。官方未在该页定义列表排序，MCP 应保持上游顺序，不对“最新优先”做未验证承诺。

### 2. 建议的 MCP 摘要项

```json
{
  "processInstanceId": "...",
  "taskId": "...",
  "title": "...",
  "summary": "...",
  "status": "RUNNING",
  "processType": "OFFICIAL_OA",
  "appType": "PROCESS_FORM",
  "originator": {
    "userId": "...",
    "name": "..."
  },
  "processCreateTime": "...",
  "activityId": "...",
  "detailAvailableVia": {
    "tool": "approval_task",
    "action": "view"
  }
}
```

不要把 `originatorPhoto` 默认返回给 Agent；它对审批发现没有必要，并会扩大个人信息暴露。`url` 也不应取代结构化 ID。

## 三、详情、已处理、转交和代理语义

### 1. 完整详情需逐实例查询

`PremiumGetTodoTasks` 不返回完整表单、附件、评论和操作历史。需要详情时，对选中的 `processInstanceId` 调用：

```http
GET /v1.0/workflow/processInstances?processInstanceId=<id>
```

该详情 API 支持企业内部应用，使用同一企业应用 access token，需权限 `Workflow.Instance.Read`（“工作流实例读权限”）。它是单实例 API；官方没有为这些详情提供同等的批量请求。

- [获取单个审批实例详情](https://open.dingtalk.com/document/development/obtains-the-details-of-a-single-approval-instance-pop)
- [官方权限映射：`Workflow.Instance.Read`](https://open.dingtalk.com/api/official/scope/list)

### 2. 已处理不属于待审批收件箱

OA 高级版使用独立接口查询已处理任务：

```http
GET /v1.0/workflow/premium/processCentres/doneTasks
```

返回任务处理结果 `agree` / `refuse`。首版 `approval_inbox` 应仅使用 `todoTasks`，不把已处理项混入待审批结果。

- [查询审批中心用户已处理任务列表](https://open.dingtalk.com/document/development/api-premiumgetdonetasks)

### 3. 转交与代理

完整实例详情的官方语义是：

- `operationRecords[].type = EXECUTE_TASK_AGENT`：代理人执行任务；
- `operationRecords[].type = REDIRECT_TASK`：发生转交；
- `tasks[].result = REDIRECTED`：该任务已转交。

`PremiumGetTodoTasks` 页面没有承诺“转交后原审批人/新审批人分别出现在哪个列表”，也不返回代理来源字段。因此：

- 收件箱结果应被视为“指定 `caller.userId` 在查询时刻的待处理快照”；
- 不要仅根据列表摘要猜测代理或转交原因；
- 如果要说明历史转交/代理，交给 `approval_task(action="view")` 读取单实例详情。

## 四、DWS 和官方 OA MCP 的现有实现

### 1. 现有命令与工具

DWS 公开命令：

```text
dws oa approval list-pending
```

它调用上游官方 MCP 工具：

```text
list_pending_approvals
```

DWS 适配的参数是：

| CLI 参数 | 上游 MCP 参数 |
|---|---|
| `--start` | `starTime`（上游字段确实拼为 `starTime`） |
| `--end` | `endTime` |
| `--page` | `pageNum` |
| `--limit` | `pageSize` |
| `--query` | `query` |

注意这组参数与 `PremiumGetTodoTasks` 的 `userId/pageSize/pageNumber/createBefore` 不同，证明 DWS 不是这个 OpenAPI 的本地包装。

- [DWS 原子命令映射（固定 SHA）](https://github.com/DingTalk-Real-AI/dingtalk-workspace-cli/blob/9e3a5d6fbd38dfeb8707e44095ff96372c3d1286/internal/helpers/oa.go#L79-L151)
- [DWS 只读组合调用与输出投影（固定 SHA）](https://github.com/DingTalk-Real-AI/dingtalk-workspace-cli/blob/9e3a5d6fbd38dfeb8707e44095ff96372c3d1286/internal/shortcut/oa/oa.go#L24-L105)
- [DWS `+pending` 的近 90 天窗口与输出归一化（固定 SHA）](https://github.com/DingTalk-Real-AI/dingtalk-workspace-cli/blob/9e3a5d6fbd38dfeb8707e44095ff96372c3d1286/internal/shortcut/smart/pending_approvals.go#L23-L100)

### 2. 运行时边界

DWS 将 OA 产品路由到官方托管网关：

```text
https://mcp-gw.dingtalk.com/server/8faff71bdfc3cb5437894ada5305b48214eb56408ca31e378f4be2773ba4500c
```

其传输把 DWS 登录获得的 access token 作为 `Authorization: Bearer ...` 发给 MCP 网关；DWS 还有独立 PAT 行为授权机制，由上游服务在需要时拦截。这与自建 MCP 持有企业应用 token 并调用 `api.dingtalk.com` 是两套鉴权模型。

- [DWS 官方 OA MCP 网关路由（固定 SHA）](https://github.com/DingTalk-Real-AI/dingtalk-workspace-cli/blob/9e3a5d6fbd38dfeb8707e44095ff96372c3d1286/internal/syncdata/endpoints.go#L29)
- [DWS 将用户 access token 发为 Bearer（固定 SHA）](https://github.com/DingTalk-Real-AI/dingtalk-workspace-cli/blob/9e3a5d6fbd38dfeb8707e44095ff96372c3d1286/internal/transport/client.go#L547-L553)
- [DWS 用户 token 交换端点（固定 SHA）](https://github.com/DingTalk-Real-AI/dingtalk-workspace-cli/blob/9e3a5d6fbd38dfeb8707e44095ff96372c3d1286/internal/auth/endpoints.go#L52-L60)

### 3. 可复用与不可复用

| 部分 | 可否复用 | 说明 |
|---|---:|---|
| 业务名称“待我审批”和只读安全标记 | 可 | 与 `approval_inbox` 角色一致 |
| 将输出归一化为 `processInstanceId/title/status/createTime` | 可，需扩展 | 自建工具还应保留 `taskId`、发起人和分页元数据 |
| 对多种响应容器和 snake/camel 字段做防御性读取 | 可 | 但直接 OpenAPI 应先以官方固定模型为主，未知形状要 fail closed |
| `starTime/endTime/pageNum/query` 参数契约 | 不可 | 这是上游 MCP 契约，不是 `PremiumGetTodoTasks` OpenAPI |
| 官方 MCP 网关路由、DWS OAuth/PAT | 不可作为自建服务的隐式依赖 | 会重新引入已经决定排除的 DWS/官方托管 MCP 运行链路 |

## 五、不可用的“普通版替代”

### 1. 流程中心集成任务接口不等于全量官方 OA 待办

官方还有 `QueryIntegratedTodoTask` / `/v1.0/workflow/processCentres/todoTasks`，但官方场景明确是查询“通过流程中心集成”的运行中自有 OA 任务。它不能保证覆盖钉钉原生官方 OA 审批，不能用来实现“当前用户全部待审批”。

- [OA审批流程中心操作流程](https://open.dingtalk.com/document/development/oa-approval-process-center-access-example)

### 2. 生成 SDK 中的旧 `ListTodoWorkRecords` 不能作为新建依赖

官方生成 SDK 历史上存在 `GET /v1.0/workflow/workRecords/todoTasks`（`ListTodoWorkRecords`），模型可返回 `instanceId/taskId/title/forms/url`。但截至调研日期：

- 钉钉当前官方文档检索不返回该 API 页；
- 官方 `/api/official/scope/list` 中也没有 `workflow_1.0#ListTodoWorkRecords` 的权限映射；
- 无法从当前官方公开文档确认新企业内部应用可申请的 scope、覆盖范围和稳定性承诺。

因此不应仅因 SDK 仍保留历史模型就在新 MCP 中使用它。若真实应用后台已有历史权限，也应先在隔离环境验证，不把它作为可移植的官方契约。

### 3. 未开通 OA 高级版时的安全降级

若真实调用返回 `benefit.status.invalid`：

1. 返回稳定错误 `OA_PREMIUM_REQUIRED`，说明必需的产品权益和 `Premium.Workflow.ReadWrite.All`；
2. 不抓包、不调用私有客户端端点、不隐式启动 DWS；
3. 不用通用钉钉待办 API 冒充 OA 审批待办，因为它不承诺返回 OA `processInstanceId/taskId`；
4. 如企业决定不升级 OA，可将“调用官方托管 OA MCP”做成一个显式、可关闭的远程适配器，但这会重新引入用户 OAuth/PAT、官方网关可用性和上游工具漂移，不应冒充为本地 OpenAPI 实现。

## 六、`approval_inbox` 最小安全契约

### 1. 工具定位

`approval_inbox` 的 actor 是“当前审批人的收件箱”，主要业务对象是待处理集合，生命周期是发现/分页，与只处理一个实例的 `approval_task` 不同，因此独立成工具符合仓库 `AGENTS.md` 的聚合原则。

### 2. 建议公开 Schema

首版推荐不接收 `userId`：

```json
{
  "limit": 20,
  "cursor": "opaque-server-issued-cursor",
  "includeDetails": false
}
```

| 字段 | 约束 |
|---|---|
| `limit` | 可选，默认 20，最小 1，**MCP 硬上限 50**；`limit=1` 就是获取单条，大于 1 是批量 |
| `cursor` | 可选、不透明、服务端发出；至少绑定 caller/tenant、`createBefore`、下一 `pageNumber`、版本和过期时间 |
| `includeDetails` | 可选，默认 `false`；若保留，`true` 时单次最多为 5 个实例逐一读取详情，不准备附件下载链接 |

更小的首版可直接省略 `includeDetails`，把所有详情读取交给 `approval_task(action="view")`。这是更清晰的边界，也避免一次收件箱调用触发大量上游详情/附件链接请求。

### 3. 建议响应

```json
{
  "action": "list_pending",
  "items": [],
  "count": 0,
  "hasMore": false,
  "nextCursor": null,
  "truncated": false,
  "source": "DINGTALK_OPENAPI_PREMIUM",
  "caller": {
    "corpId": "masked-or-omitted"
  },
  "nextActions": [
    {
      "tool": "approval_task",
      "action": "view",
      "requires": ["processInstanceId"]
    }
  ]
}
```

待办为空是正常成功，应返回 `items=[]` 和 `count=0`，不应把它包装为错误。

### 4. 与 `approval_task` 的边界

| `approval_inbox` | `approval_task` |
|---|---|
| 发现当前 caller 的待处理集合 | 处理一个已知 `processInstanceId` |
| 批量返回摘要、`processInstanceId`、`taskId` | `view` 返回完整表单、操作记录、附件元数据/有界链接 |
| 永远只读，不接受 `confirm` | `approve` / `reject` 是写操作，必须重读任务并确认 |
| 不提供批量同意/拒绝 | Agent 根据 inbox 返回的 ID 选定对象后，逐实例调用 |

即使 OA 高级版有官方“批量同意或拒绝”API，也不应在首版 `approval_inbox` 中暴露它。收件箱是发现工具，不是写操作工具。

## 七、错误映射

| 官方错误码 | 官方含义 | 建议 MCP 错误 |
|---|---|---|
| `oaplus.params.error` | 参数校验不合法 | `INVALID_INPUT` / 服务端内部分页编码错误，不要回退为任意 `userId` |
| `oaplus.query.limit` | 企业访问并发超限 | `UPSTREAM_RATE_LIMITED`，按官方提示稍后重试，服务端加有界指数退避 |
| `benefit.status.invalid` | OA 高级版未开通或过期 | `OA_PREMIUM_REQUIRED`，不应无限重试 |
| `benefit.query.error` | 权益系统查询失败 | `UPSTREAM_BENEFIT_CHECK_FAILED`，可重试但需有上限 |
| `system.error` | 钉钉系统错误 | `UPSTREAM_ERROR`，记录匿名化 request/correlation ID |

鉴权失败和缺少 scope 应分开映射：企业应用 token 失效可刷新一次；权限未开通则返回明确配置错误，不得让 MCP 客户端反复重做用户 OAuth。

## 八、实施前验证清单

1. 在钉钉开发者后台确认 `MWE审批MCP` 应用已获得 `Premium.Workflow.ReadWrite.All`。
2. 用企业应用 access token 对真实 `caller.userId` 调用第 1 页，区分权限错误与 `benefit.status.invalid`。
3. 与钉钉客户端“待我审批”抽样对账，至少覆盖官方 OA、转交任务、代理处理场景。
4. 验证 `createBefore` 时区、列表顺序、空列表、第 10 页与页面漂移。
5. 对每条结果确认 `processInstanceId` 和 `taskId` 非空；缺少任一时标记为不可处理，不伪造 ID。
6. 用返回的一个 `processInstanceId` 调用现有 `approval_task(action="view")`，确认身份归属、任务状态和附件边界。
7. 通过精确公网 MCP URL 完成 `initialize` / `tools/list` / `approval_inbox` 实调，并确认无 DWS 进程或官方 OA MCP 网关参与业务取数。

## 九、来源

### 钉钉官方文档/接口

- [查询审批中心用户待处理任务列表](https://open.dingtalk.com/document/development/api-premiumgettodotasks)
- [查询审批中心用户已处理任务列表](https://open.dingtalk.com/document/development/api-premiumgetdonetasks)
- [获取单个审批实例详情](https://open.dingtalk.com/document/development/obtains-the-details-of-a-single-approval-instance-pop)
- [OA 审批流程中心操作流程](https://open.dingtalk.com/document/development/oa-approval-process-center-access-example)
- [官方 API 权限列表](https://open.dingtalk.com/api/official/scope/list)

### 官方生成 SDK

- [Alibaba Cloud 钉钉 Go SDK `workflow_1_0`（固定 SHA）](https://github.com/alibabacloud-go/dingtalk/tree/3077c44e195cee47a1036c5fc98bbb625399f4de/workflow_1_0)

### DWS 官方仓库

- [DingTalk-Real-AI/dingtalk-workspace-cli（调研固定 SHA）](https://github.com/DingTalk-Real-AI/dingtalk-workspace-cli/tree/9e3a5d6fbd38dfeb8707e44095ff96372c3d1286)
