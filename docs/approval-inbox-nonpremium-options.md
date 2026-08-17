# 非 OA 高级版条件下的待审批/已处理收件箱方案研究

更新时间：2026-08-17

## 结论

在没有有效 OA 高级版权限时，不能把 `Premium.Workflow.ReadWrite.All` 对应的“当前用户待审批列表”接口作为生产依赖。普通版可行的首选路径是：

1. 在企业内部应用中订阅 `bpms_task_change` 审批任务事件；
2. 服务端按 OAuth 绑定的当前用户身份（服务端注入，不接受工具参数中的 userId）维护一个受限的 pending/completed 索引；
3. 事件中的 `processInstanceId` 作为审批实例 ID，事件中的任务标识作为 `taskId`；
4. 对索引中的实例再调用现有审批详情/任务接口确认当前状态；
5. `approval_inbox` 用 `recordStatus=pending|completed` 返回已确认的实例和任务 ID，`approval_task` 负责后续查看、同意、拒绝等动作。

该方案是“事件驱动的当前用户索引”，不是对钉钉全历史收件箱的无损重建。首次部署、事件丢失、应用离线期间需要明确返回 `coverage`/`resyncRequired`，不能伪装成完整列表。

## 1. 企业待办 API 不能稳定映射普通 OA 审批

钉钉官方待办文档的查询接口为 `POST /v1.0/todo/users/{unionId}/org/tasks/query`。官方页面说明该查询面向通过“创建钉钉待办任务”接口创建且带 `detailUrl` 的企业待办；返回卡片包含 `taskId`、`detailUrl`、`sourceId`、`bizTag` 等字段，并没有承诺 `sourceId` 必然是 OA `processInstanceId`，也没有承诺 `detailUrl` 可以反解析出 OA `taskId`。

官方文档入口：[钉钉待办任务概述](https://open.dingtalk.com/document/orgapp/dingtalk-todo-task-overview)。

因此，即使能调用该 API，也只能把它作为“企业待办卡片来源”，不能把 `sourceId -> processInstanceId` 当成稳定协议。尤其是已有官方 DWS 能看到 OA 审批，并不能证明 OA 审批在普通应用的企业待办查询中暴露为可解析的待办卡片。该 API 的公开返回模型也只定义通用 todo 字段：[`QueryOrgTodoTasksResponseBodyTodoCards`](https://javadoc.io/static/com.aliyun/dingtalk/1.3.75/com/aliyun/dingtalktodo_1_0/models/QueryOrgTodoTasksResponseBody.QueryOrgTodoTasksResponseBodyTodoCards.html)。

建议：不要以 `/org/tasks/query` 作为 `approval_inbox` 的主实现；如以后实测发现本企业 OA 卡片稳定返回 OA 标识，也只能作为可选补充源，并保留未映射项和证据字段。

## 2. `bpms_task_change` 是普通版最适合的索引来源

官方审批事件说明中，`bpms_task_change` 表示审批任务开始、结束、转交；事件模型包含 `processInstanceId`，并可按企业内部应用和具体审批模板订阅。官方 DWS 也把审批待办查询与任务 ID 查询拆成两个不同的工具：`list_pending_approvals` 用于发现实例，`list_pending_tasks` 用于已知实例后取得 taskId。[DWS 固定版本源码](https://github.com/DingTalk-Real-AI/dingtalk-workspace-cli/blob/9e3a5d6fbd38dfeb8707e44095ff96372c3d1286/internal/helpers/oa.go#L41-L49)

DWS 的 `list-pending` CLI 只把时间、分页和关键词参数转发给官方上游 MCP 的 `list_pending_approvals`，没有在本地实现 OA 收件箱扫描。[DWS 固定版本源码](https://github.com/DingTalk-Real-AI/dingtalk-workspace-cli/blob/9e3a5d6fbd38dfeb8707e44095ff96372c3d1286/internal/helpers/oa.go#L72-L145)

这意味着可复用的是工具边界和字段语义，而不是把 DWS 的官方 MCP 当作自建服务的下游依赖。官方上游 OA MCP 的静态地址确实由 DWS 配置为钉钉 `mcp-gw.dingtalk.com`，但其认证和后端能力属于钉钉托管链路，不应猜测或复制到生产服务。[DWS 固定版本端点清单](https://github.com/DingTalk-Real-AI/dingtalk-workspace-cli/blob/9e3a5d6fbd38dfeb8707e44095ff96372c3d1286/internal/syncdata/endpoints.go#L25-L31)

事件索引的处理规则：

- `start`：写入 `(processInstanceId, taskId, currentUser, processCode, createdAt)`；
- `transfer`：结束旧任务并写入新任务；
- `finish/end`：从待审批集合删除并写入最近 30 天的已处理集合，保留 `agree/refuse/redirect`；
- `cancel`：从待审批集合删除，但不计入已审批；
- 使用 `eventId`/`bizId` 幂等去重；
- 只接受企业、应用、OAuth 用户和订阅模板均匹配的事件；
- 事件缺少 taskId 时，只能返回实例 ID，并标记 `taskIdUnavailable`，不能从猜测中生成 taskId。

事件订阅本身是企业内部应用的能力，是否需要额外 OA 高级版权益，应以当前开发者后台和该企业实际返回为准；公开资料没有证据表明 `bpms_task_change` 必须购买 Premium。因而首版应先在开发者后台订阅一个已知审批模板并用真实审批验证。

## 3. `instanceIds/query` + 详情扫描只作为有限刷新

官方普通 OA 接口 `POST /v1.0/workflow/processes/instanceIds/query` 能按审批模板、时间和分页取得实例 ID 集合，权限为工作流实例读权限。必填 `processCode`、`startTime`、`nextToken`、`maxResults`，每页最多 20；可用 `statuses=RUNNING|TERMINATED|COMPLETED` 过滤实例状态。[官方文档](https://open.dingtalk.com/document/development/obtain-an-approval-list-of-instance-ids)

它是“实例发现”接口，不是“当前用户待办/已处理收件箱”接口：`userIds` 过滤的是发起人，不是审批人。扫描后仍必须逐实例拉取详情、读取任务执行人和任务状态，并与 MCP OAuth 用户匹配。查询 completed 任务时需要扫描 `RUNNING + COMPLETED` 实例，因为当前用户的节点可能已经完成，但整个流程仍在后续节点运行。

该方法存在三个边界：

1. 需要知道所有相关 `processCode`，无法覆盖未知模板；
2. 需要足够短的时间窗口和持续轮询，否则会漏掉短生命周期任务；
3. 调用成本约为 `模板数 × 时间页数 + 命中的实例详情数`，并受 OpenAPI 频率和权限影响。

所以它只能作为事件索引丢失后的“有限重同步”工具：管理员通过 `APPROVAL_INBOX_PROCESS_CODES` 提供模板白名单，客户端通过 `refreshWindowDays=1..30` 提供时间窗口；单次最多检查 40 个候选实例，结果返回刷新统计并继续标记 `coverage=partial/resyncRequired=true`，不能宣称与官方 DWS 收件箱等价。未配置环境变量时，默认只扫描已精确适配的费用报销与付款申请模板。

## 4. 官方 DWS 上游 MCP 不应作为自建服务下游

DWS 的源代码显示 OA 服务使用钉钉官方 MCP 网关地址，并通过 `callMCPTool("list_pending_approvals", argsMap)` 调用上游工具；仓库没有公开该上游服务的内部认证协议或将用户 OAuth token 转换为可供第三方服务长期使用的方式。[工具调用源码](https://github.com/DingTalk-Real-AI/dingtalk-workspace-cli/blob/9e3a5d6fbd38dfeb8707e44095ff96372c3d1286/internal/helpers/oa.go#L88-L106)、[官方网关配置](https://github.com/DingTalk-Real-AI/dingtalk-workspace-cli/blob/9e3a5d6fbd38dfeb8707e44095ff96372c3d1286/internal/syncdata/endpoints.go#L27-L28)

可复用内容：

- `list_pending_approvals` 的语义：当前用户待处理审批实例；
- 分页、时间窗口、关键词过滤的参数设计；
- 实例发现与任务 ID 获取分层；
- 只读、幂等的安全标记。

不可复用内容：

- 不把 `mcp-gw.dingtalk.com` 当作自建 MCP 的隐式后端；
- 不抓取、转存 DWS 的 PAT/加密令牌；
- 不假设官方网关会接受自建服务的 AppKey/AppSecret 或我们的 OAuth access token。

## 5. 首选可测试方案

首版 `approval_inbox` 建议采用以下降级策略：

```text
事件索引（主源）
  ├─ 有效事件：返回 pending items + processInstanceId + taskId
  ├─ 只有实例 ID：返回 item，taskIdUnavailable=true
  └─ 事件索引为空/过期：返回 coverage=partial, resyncRequired=true

有限重同步（可选）
  └─ instanceIds/query → 详情任务过滤 → 写回同一索引
     仅针对精确 processCode 白名单、1–30 天窗口、最多 40 个候选
```

工具返回必须包含：`recordStatus`、`processInstanceId`、可用时的 `taskId`、`processCode`、任务状态、事件时间、`coverage`、`nextCursor`/`hasMore`；已处理项还应在事件提供时返回 `decisionResult`。若 5000 条容量边界截断了保留窗口中的旧记录，必须返回 `capacityTruncated=true` 并推进 `coverageSince`。不接受 `userId`、`unionId` 或“代表谁查询”等模型输入；身份来自 MCP OAuth 会话。

上线测试顺序：

1. 在开发者后台为 `MWE审批MCP` 订阅一个已知模板的 `bpms_task_change`；
2. 用当前账号发起一张测试审批并确认 `start` 事件落库；
3. 用另一流程节点产生待审批任务，确认事件中能取得 `processInstanceId` 与 `taskId`；
4. 通过 `approval_inbox(recordStatus=pending, limit=1)` 和批量分页分别验证；
5. 同意/拒绝后确认 `finish/end` 事件把任务从 pending 移入 completed，并返回处理结果；
6. 人为停服或丢弃一条事件，验证服务返回 `coverage=partial` 而不是错误地宣称完整。

## 无法做到的边界

- 无高级版权限且未订阅事件时，不能凭现有普通应用接口可靠获得“当前用户所有 OA 待审批”；
- 通用待办 `sourceId`、`detailUrl` 不能未经实测就当作 OA 实例/任务 ID 映射协议；
- 仅靠流程实例扫描不能覆盖未知模板、事件空窗期和已过期任务；
- DWS 能查询不等于自建应用拥有相同权限，DWS 官方托管 MCP 的用户授权链路不可推断。
