# 10 二丫 API 接口文档

> 状态：草稿（v0.7 评审草案） · 建立：2026-11-16 · 最近更新：2026-11-17
> 关联：[开发准备总览](./00-二丫AI助手开发准备总览.md) · [仓库文档索引](../文档索引.md)
> 来源：[ChatGPT Pages 原文](https://chatgpt.com/space/page_3943f0d108fc819194a79c6afb388454) · 本地落盘：2026-11-17。初次落盘保留来源稿；2026-11-17本地增量纳入dsh-pet借鉴要求，来源与取舍见00。以下仍为待实施方案，不代表功能已实现；Pages来源稿未同步本地增量；v0.6全能力补充见13，v0.7用户选定的地址栏双气泡方案见05/07。

版本：v0.7 评审草案，2026-11-17。二丫通过浏览器内部 IPC 接收任务，通过受控工具接口操作模块。本方案规定请求、授权、事件、错误与恢复语义；所有 `erya.*` 通道和下述 DTO 均为建议新增，尚未实现。关联 ER-001 至 ER-018。

## 接口范围与现有代码

本项目是 Electron 桌面应用，首版采用已有 preload 与类型化 IPC 模式，不新增对公网开放的 REST 服务。界面只能调用显式允许的通道；模型只能提出工具请求，不能直接调用任意 IPC。

现有 `page.extract` 可供页面读取适配器复用；`settings.set` 是普通设置入口；`ai.agent.start` 当前实现仍路由至 pi 适配链，这是 CUT-01 要消除的历史混用，不代表该命名归 Pi。它们不是二丫的新 API，也不证明已经具备细分授权。`registerHandler` 负责 zod 校验和超时包装，主进程仍须新增调用来源、工作区、资源和审批检查。

命名已确认：二丫 IPC 与非敏感设置采用 `erya.*`，独立表为 `erya_*`。`ai.*` 原为原生 AI 助手预留，不属于 Pi。CUT-01 要同步迁出旧调用端、schema、handler、preload白名单、事件/MessagePort及测试；Pi在用功能迁入Pi专属合同，共用功能按职责命名，废弃入口移除。旧业务别名不作为永久兼容层；仅独立升级模块可按具体版本读取白名单旧数据，不能接受旧通道继续执行业务。目标命名及验收见06，数据迁移见07。

## 公共请求与响应

建议所有新通道使用 `schemaVersion: 1`。ID 为不透明字符串；`workspaceId` 为请求作用域，服务端根据 Electron sender、窗口与当前档案核对。`profileId`、`actorId` 和可信时间由主进程产生，前端传入同名字段应拒绝。时间使用 UTC 毫秒，枚举与长度由 zod 同步定义。

```typescript
type EryaRequest<T> = {
  schemaVersion: 1;
  requestId: string;
  workspaceId: string;
  payload: T;
};
type EryaResult<T> =
  | { ok: true; requestId: string; data: T }
  | {
      ok: false;
      requestId: string;
      error: {
        code: string;
        message: string;
        retryable: boolean;
        outcomeKnown: boolean;
        details?: Record<string, unknown>;
      };
    };
```

这个响应信封属于新 `erya.*` 合同，不修改所有旧通道。旧 IPC 在通用包装层产生的 `IpcErrorPayload` 需由二丫客户端适配为相同界面错误模型；不能假定现有 `invoke` 已支持该新信封。错误详情不得携带密钥、页面正文或内部堆栈。

初始建议请求上限为 256 KiB，工具参数上限为 64 KiB，列表每页最多100条，事件增量每块最多16 KiB；均为待性能验证的工程限额。长正文通过受控 `sourceId` 引用，不能用提高上限绕过最小化采集。长任务先返回任务 ID，进度通过事件获取；IPC 超时不代表底层工作已取消。

## 对界面开放的通道

下列为首版最低接口集合。所有读取都校验当前档案与工作区；改变授权、审批、记忆和模型配置的请求只接受可信二丫界面。写请求包含 `idempotencyKey`，更新同时包含 `expectedRevision`。

| 通道                       | 关键输入                                                                                                             | 成功输出与行为                                       |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| `erya.capabilities.get`    | 无附加字段                                                                                                           | 可用工具版本、模型能力、当前限制；不返回密钥         |
| `erya.grants.create`       | level、tools、resources、limits、expiresAt、idempotencyKey                                                           | Grant；用户明确提交后创建，模型不可调用              |
| `erya.grants.list`         | cursor、limit                                                                                                        | 本作用域授权及下一页游标                             |
| `erya.grants.revoke`       | grantId、expectedRevision、idempotencyKey                                                                            | 新版本与撤销时间；阻止后续派发                       |
| `erya.tasks.create`        | goal、contextRefs、grantIds、modelPolicy、budget、idempotencyKey                                                     | TaskSnapshot；先建立 draft 再规划                    |
| `erya.tasks.get`           | taskId                                                                                                               | 当前状态、计划版本、步骤、回执和资源版本             |
| `erya.tasks.list`          | stateFilter、cursor、limit                                                                                           | 当前作用域任务摘要                                   |
| `erya.tasks.replan`        | taskId、expectedRevision、instruction、idempotencyKey                                                                | 新计划版本；旧审批失效，已发生结果保留               |
| `erya.approvals.decide`    | approvalId、decision、expectedRevision、idempotencyKey                                                               | 消费或拒绝结果；参数摘要从服务端审批记录取得         |
| `erya.tasks.cancel`        | taskId、expectedRevision、idempotencyKey                                                                             | accepted、当前状态、已提交步骤；不伪称已撤回         |
| `erya.tasks.resume`        | taskId、expectedRevision、idempotencyKey                                                                             | 重新核对资源和授权后恢复；未知写入未对账不得恢复执行 |
| `erya.events.subscribe`    | taskId、afterSequence                                                                                                | subscriptionId、最新序号、是否需重新获取快照         |
| `erya.events.unsubscribe`  | subscriptionId                                                                                                       | 已解除订阅；窗口销毁自动清理                         |
| `erya.memories.list`       | kind、cursor、limit                                                                                                  | 内容、来源、状态、容量、到期时间；按权限过滤         |
| `erya.memories.save`       | candidateId、expectedRevision、scope、expiresAt、idempotencyKey                                                      | 用户确认后的有效记忆                                 |
| `erya.memories.correct`    | memoryId、expectedRevision、content、idempotencyKey                                                                  | 新内容版本及被替代版本                               |
| `erya.memories.delete`     | memoryId、expectedRevision、includeDerivatives、idempotencyKey                                                       | deletionId、不可检索时间、后台清理状态               |
| `erya.memoryBudget.update` | itemLimit、contentByteLimit、activeByteLimit、backupByteLimit、retrievalTokenLimit、expectedRevision、idempotencyKey | 配额及是否暂停新增；不能静默清理固定条目             |
| `erya.modelConfig.update`  | providerId、modelId、dataPolicy、expectedRevision、idempotencyKey                                                    | 配置版本与能力验证状态                               |
| `erya.secrets.set`         | providerId、secretValue、idempotencyKey                                                                              | 仅返回已配置；值只交给主进程凭据存储                 |

删除派生摘要是隐私删除的必要部分，`includeDerivatives=false` 不能让包含已删内容的派生文本继续被检索；该字段只控制是否同时清理独立用户产物，服务端返回实际删除范围供界面核对。首版可固定为只删除二丫记忆及全部依赖摘要，用户自己的笔记保持独立。

## 关键数据结构

| 对象         | 必要字段与规则                                                                                                                               |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| ContextRef   | resourceType、resourceId、workspaceId、resourceRevision、selectedAt；网页引用绑定导航版本与来源，跳转后重检                                  |
| Grant        | id、profileId、workspaceId、level、tools、resources、limits、expiresAt、revokedAt、revision；范围空数组表示无权限                            |
| DataPolicy   | localOnly，或 providerId 加 allowedDataClasses 与 allowedResources；换提供方必须重检外发授权                                                 |
| TaskSnapshot | id、state、revision、planRevision、steps、budget、outcomeSummary、latestSequence；部分完成属于结果摘要                                       |
| Step         | id、ordinal、toolId、toolVersion、argsHash、state、expectedRevision、idempotencyKey、receipt；模型不能自填风险等级降低门槛                   |
| Approval     | id、taskId、stepId、actorId、workspaceId、argsHash、planRevision、resourceRevision、grantRevision、decision、expiresAt、consumedAt、revision |
| ToolReceipt  | operationId、toolId、resourceRefs、beforeRevision、afterRevision、verified、undoCapability、completedAt；内容按权限裁剪                      |
| Memory       | id、scope、kind、content、sourceRefs、status、contentVersion、expiresAt、pinned、byteSize；凭据不是合法记忆内容                              |

Grant 的 `limits` 显式包含最大操作次数、单任务成本和允许数据外发范围；数据外发也可作为独立策略引用。L0 仅使用用户输入，L1 范围读取，L2 每次写入审批。首版不接受 L3 授权创建；后续支持时仍受工具、对象、期限和额度限制，高风险逐次确认。

记忆更新请求的 expectedRevision 对应 Memory.contentVersion，候选记忆同样带内容版本；审批更新对应 Approval.revision。服务端在同一事务内比较版本并递增，不能把计划版本或资源版本替代对象自身版本。

任务状态固定为 `draft/planning/awaiting_approval/running/verifying/paused/completed/cancelled/failed`。步骤状态为 `prepared/running/verifying/succeeded/failed/cancelled/outcome_unknown`。结果未知令任务暂停；没有核验证据不得显示 completed。

## 工具调用与模型适配

内部 `ToolInvocation` 包含 taskId、stepId、toolId、toolVersion、arguments、argsHash、idempotencyKey、expectedRevision 和审批引用。只有运行子进程向主进程工具网关提交；前端不能伪造一个模型工具请求绕过任务状态机。

工具网关按当前可信状态检查：调用来源 → 工具 schema → 工作区和资源 → 授权与期限 → 预算 → 审批摘要与版本 → 派发。检查成功与审批消费在可恢复的串行调度中衔接，资源版本仍由目标模块在写入事务内做最终比较，避免检查后对象又改变。

模型 DTO 需增量支持 `assistant.toolCalls[{callId,name,arguments}]` 与 `toolResult{callId,status,content}`，并返回 usage、finishReason 与模型版本。每个 callId 必须匹配一个实际调用和工具结果；只支持文本聊天的 provider 不进入自动执行模式。当前 M12 的可选 `tools()`、`embed()` 和 `finishReason=tool_call` 不能代替这条完整合同。

## 幂等 审批与取消

任务创建键在 `(profileId,workspaceId,idempotencyKey)` 内唯一；同键同请求摘要返回原任务，同键不同摘要返回冲突。步骤执行键与 taskId、stepId、参数摘要和工具版本绑定。目标模块须把业务改动与操作回执放在同一事务内；外部服务只能达到其接口提供的幂等保证，不能承诺普遍“恰好一次”。

批准不是通用通行证。它仅绑定一版计划、一组规范化参数、目标资源版本和授权版本；确认后改参数或撤销授权，旧审批失效。重复提交同一批准不能再执行一次。建议审批10分钟过期，属于可调整初值；不以超时沉默作为同意。

取消先关闭新步骤派发，再向模型和工具传递真实 abort。已提交的外部动作转入核验，按结果显示已完成部分或 `outcome_unknown`。超时后不能看到错误码的 `retryable=true` 就自动重试写入；先按操作键查回执，无回查能力则暂停并让用户决定。

## 事件协议与恢复

建议事件通道 `erya:event`，信封包含 `schemaVersion`、taskId、sequence、type、timestamp 和 payload。类型包括 `task.state_changed`、`plan.updated`、`approval.required`、`step.started`、`step.verified`、`step.outcome_unknown`、`message.delta`、`usage.updated`、`memory.changed`、`error`。所有事件出站和入站验证 schema；只发给获授权的订阅窗口。

持久业务事件使用每任务严格递增 sequence。重连按 afterSequence 补发；界面按 sequence 去重，发现缺口请求快照。文本增量可只保留短缓冲，过期返回 `SNAPSHOT_REQUIRED`，不承诺完整流式 token 永久回放。订阅本身不扩大权限，撤权后立即停止敏感事件推送。

## 错误码与界面动作

| 新合同错误码                         | 含义                       | 建议界面行为                   |
| ------------------------------------ | -------------------------- | ------------------------------ |
| VALIDATION                           | 字段、长度或 schema 错误   | 指明可修正字段，不重试原请求   |
| PERMISSION_DENIED                    | 主体、范围或外发不允许     | 显示缺少哪项权限，用户可取消   |
| APPROVAL_REQUIRED / APPROVAL_EXPIRED | 需要确认或确认已过期       | 展示当前版本的具体动作         |
| REVISION_CONFLICT                    | 页面、笔记、计划或授权改变 | 刷新差异并重新确认             |
| IDEMPOTENCY_CONFLICT                 | 相同键对应不同请求         | 修正调用逻辑，不生成第二次写入 |
| BUDGET_EXCEEDED / CAPACITY_EXCEEDED  | 费用或存储达上限           | 暂停并提供明确调整入口         |
| MODEL_CAPABILITY_UNSUPPORTED         | 当前模型不支持任务所需能力 | 改为建议或让用户选择其他模型   |
| PROVIDER_UNAVAILABLE / TIMEOUT       | 提供方不可用或超时         | 读取可受限重试；写入先核验     |
| OUTCOME_UNKNOWN                      | 无法确认副作用是否发生     | 暂停任务，显示已知与未知部分   |
| CANCELLED / SNAPSHOT_REQUIRED        | 已取消或事件过期           | 停止等待或刷新任务快照         |

错误 `retryable` 只表示可能恢复，不能绕过幂等、审批和预算规则。旧 IPC 的 `PERMISSION/STATE/UNAVAILABLE/ABORTED` 由客户端适配映射；不声称这些新码已存在于当前枚举中。

## 一个完整调用示例

示例使用虚构 ID 与内容，不产生真实操作。用户在界面选择三个标签并允许本任务读取及向指定提供方发送选定正文，建立本次 L2 授权；L2 的写步骤仍需要逐次确认。

```json
{
  "channel": "erya.tasks.create",
  "request": {
    "schemaVersion": 1,
    "requestId": "req-demo-1",
    "workspaceId": "ws-demo",
    "payload": {
      "goal": "比较选定资料，并将结论保存到学习笔记",
      "contextRefs": [
        {
          "resourceType": "tab",
          "resourceId": "tab-a",
          "workspaceId": "ws-demo",
          "resourceRevision": "nav-8",
          "selectedAt": 1794787200000
        },
        {
          "resourceType": "tab",
          "resourceId": "tab-b",
          "workspaceId": "ws-demo",
          "resourceRevision": "nav-4",
          "selectedAt": 1794787200000
        },
        {
          "resourceType": "tab",
          "resourceId": "tab-c",
          "workspaceId": "ws-demo",
          "resourceRevision": "nav-2",
          "selectedAt": 1794787200000
        }
      ],
      "grantIds": ["grant-demo"],
      "modelPolicy": {
        "providerId": "configured-provider",
        "modelId": "configured-model",
        "dataPolicyId": "policy-demo"
      },
      "budget": {
        "maxToolCalls": 8,
        "maxModelCalls": 4,
        "maxCostMinorUnits": 100,
        "currency": "CNY"
      },
      "idempotencyKey": "task-create-demo-1"
    }
  }
}
```

金额上限1元仅为示例，不是实际模型报价；生产实现需使用已配置币种、价格版本与保守预算预留。

执行序列：create 返回 task-demo → 收到 plan.updated → 读取并形成带来源的结论 → 收到 approval.required，显示指定笔记、完整拟写内容及版本 → 用户批准 `approval-demo` → `erya.approvals.decide` 校验并消费票据 → 工具写入一次 → 回读笔记内容与版本 → step.verified → task.state_changed 为 completed。若用户同时编辑笔记，返回 REVISION_CONFLICT，展示新差异后重新确认。

记忆保存作为独立操作：完成卡提出候选“以后比较工具时优先展示上手难度”，用户选择保存才调用 `erya.memories.save`。保存失败不把已经核验的笔记任务改写为失败。

## 速记 日历与邮箱工具合同

本节为ER-013—016接入设计。`erya.*`为助手IPC；下列业务toolId由内部网关登记，日历既有`calendar_*`标识原样复用，不因采用erya命名空间而机械改名。底层`calendar.*`、`mail.*`属于原模块，模型不可直接调用任意IPC。

### 日历8工具映射

以下合同已在日历模块预备，尚未注册到助手；参数/返回以原zod schema为单一真源。审批与作用域由ToolInvocation外围承载，不把不支持的字段硬塞进原请求。

| 预备toolId               | 领域通道                | 必要语义                                                                                              |
| ------------------------ | ----------------------- | ----------------------------------------------------------------------------------------------------- |
| calendar_list_calendars  | calendar.listCalendars  | 返回后按grant裁剪日历元数据，不自动全授权                                                             |
| calendar_list_events     | calendar.listEvents     | startAt/endAt半开范围、calendarIds/includeDeleted；范围≤366日；返回展开事件                           |
| calendar_get_event       | calendar.getEvent       | eventId；返回事件及当前version                                                                        |
| calendar_create_event    | calendar.createEvent    | 完整event、必填idempotencyKey；同键异参冲突                                                           |
| calendar_update_event    | calendar.updateEvent    | eventId、expectedVersion、完整event、重复scope                                                        |
| calendar_delete_event    | calendar.deleteEvent    | eventId、expectedVersion、重复scope；软删除                                                           |
| calendar_check_conflicts | calendar.checkConflicts | 完整event、可选excludeEventId；冲突列表                                                               |
| calendar_find_free_slots | calendar.findFreeSlots  | 时间范围、日历、durationMinutes、bufferMinutes、timeZone、workingHours、排除ID和limit；只代表本地候选 |

原listEvents空calendarIds表示所有启用日历，不能将空grant透传为全读；网关须展开获准ID并拒绝空授权。日历写入检查启用与可写，重复scope必须明确single/future/series；实例ID、seriesId与occurrenceDate使用服务返回值，不自行猜算。确认卡展示完整替换输入的差异，避免默认字段覆盖已有描述或关联。

定时使用带offset的ISO与IANA时区；全天使用startDate/endDateExclusive。calendarContextSchema的today/timeZone/calendarIds/selectedEvent/range/capabilities由授权采集器构造，不自动注入。现有saveCalendar/restoreEvent/提醒管理/备份导入导出不在8工具中，初期不向模型开放；恢复引导原生UI。

创建去重保存首次响应，后续getEvent核当前状态；更新/删除没有同等幂等键保证，助手operationId不是原生防重凭证，未知时先对账或暂停。日历NOT_FOUND/INVALID_ARGUMENT/VERSION_CONFLICT/IDEMPOTENCY_CONFLICT映射二丫错误；当前主进程包装与Mock错误形态不同，CAL-01需补稳定类型化映射和测试，不能靠随意解析自然语言错误消息。

### 速记与邮箱拟新增合同

下列仅是拟登记业务工具，具体schema与领域服务由相应任务实现后才能开放；都复用ToolInvocation、审批、回执与作用域规则，不另开通用SQL、脚本或settings写权限。

| 拟toolId                                                     | 最小输入与输出                                                                      | 写入约束                                                           |
| ------------------------------------------------------------ | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| notebook.list/get                                            | 已授权笔记本ID或范围→元数据与revision                                               | 不返回未授权笔记正文                                               |
| notebook.create/rename                                       | 名称、目标ID；更新含expectedRevision→ID/新revision                                  | 操作键、防重、审批；整本删除后置                                   |
| notebook.note.list/get/create/update                         | notebookId、noteId、选区或标题正文→内容/来源/revision                               | 写入含操作键，更新含expectedRevision；仅目标对象                   |
| notebook.task.list/create/update                             | notebookId、taskId、text/done→任务及revision                                        | 不伪造dueDate/priority；更新CAS，任务删除待恢复设计                |
| notebook.canvas.readSelection/createSticky/updateSticky/move | notebookId、对象ID、文字或几何参数→对象及revision                                   | 内容与布局差异分明；不可读取路径所指文件                           |
| mail.message.readSelection                                   | 不透明mailRefIds→裁剪正文、来源、缓存时效、附件元数据                               | 账号/文件夹/UID/UIDVALIDITY与当前身份验证；阅读不自动标已读        |
| mail.draft.create/get/update                                 | accountId、replySourceRef、To/CC/BCC、subject/body、attachmentRefs→draftId/revision | MAIL-02拟建邮箱本地草稿；保存需审批，更新CAS；初期不承诺IMAP同步   |
| mail.message.sendApproved                                    | draftId、expectedRevision、审批引用、操作键→发送尝试回执                            | 仅发送已批准最终快照；服务器接受/失败/未知区分，不普遍保证恰好一次 |
| mail.message.setRead                                         | mailRef、seen→回读状态                                                              | 与读取分离，单独审批与恢复语义                                     |
| resource.resolve/open                                        | 带领域与真实归属的resourceRef→可解析/失效/无权限及可信定位                          | 导航不扩大读取授权，不任意加载模型给的路径或URL                    |

现有mail.message.list/fetch/markRead/send可供领域适配；账号密码管理和attachment.fromPath不直接注册模型工具。mail.message.fetch主要返回text/contentUrl与附件元数据，不能把contentUrl当纯正文；MAIL-01补主进程受控文本提取，不加载邮件远程图片。附件通过受控attachmentRef选取，临近发送重核内容摘要。现有inReplyToUid不能替代原始Message-ID回复头，MAIL-02需纠正并测试。

现有邮件合同只暴露accountId/folder/uid，持久引用需补UIDVALIDITY及辅助Message-ID核对；缺失时标为待解析，不承诺可靠跨模块跳转。LINK-01对日历relations中的email类型仅传可解析的不透明ID；原schema支持type/id不表示解析器已经实现。

依据：[日历schema](https://github.com/sgobiorodolfo170-ai/Urchin-Browser/blob/f92816c327cab6978838a860ccddddf26a30e942/packages/ipc-contract/src/schemas/calendar.ts)、[日历handler](https://github.com/sgobiorodolfo170-ai/Urchin-Browser/blob/f92816c327cab6978838a860ccddddf26a30e942/apps/desktop/src/main/calendar/register-handlers.ts)、[邮箱handler](https://github.com/sgobiorodolfo170-ai/Urchin-Browser/blob/f92816c327cab6978838a860ccddddf26a30e942/apps/desktop/src/main/mail/register-handlers.ts)、[邮箱服务](https://github.com/sgobiorodolfo170-ai/Urchin-Browser/blob/f92816c327cab6978838a860ccddddf26a30e942/apps/desktop/src/main/mail/mail-manager.ts)。

## DevTools拟新增工具合同

下列均为待实施的业务toolId，不是现有IPC；外部仍经erya任务、授权、事件和快照合同。旧devtools RPC、evaluate和ai.chat.start不恢复。DT-00复用对话，无新采集接口。内部CDP方法只在主进程固定白名单适配，模型不能提交method+params、表达式、脚本或任意webContentsId。

| 拟工具与任务                        | 关键输入                                                                          | 返回与限制                                                                                         |
| ----------------------------------- | --------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| devtools.capture.start，DT-01/02/03 | 已登记targetRef/documentRevision、kinds、durationMs、maxEntries、maxBytes         | captureId、实际生效范围、expiresAt、coverageStart、backend；拒绝超授权范围，不把空范围当全部       |
| devtools.capture.read，DT-02/03     | captureId、cursor、limit                                                          | 脱敏Evidence[]、nextCursor、droppedCount、truncated、coverageEnd、stopReason；只读当前任务获准证据 |
| devtools.capture.stop，DT-01        | captureId                                                                         | stoppedAt与释放状态；幂等停止，只结束本采集、不关闭F12或detach他人租约                             |
| devtools.dom.inspect，DT-04         | targetRef/documentRevision、可信UI选出的nodeRef、固定属性集合、depth/byte上限     | 有界DOM/CSS证据、nodeRevision、缺失/截断；非原生$0接口；禁止脚本/输入值                            |
| devtools.preview.create，DT-05      | evidenceRef、sourceDocumentRevision、允许CSS差异、viewport、审批引用、operationId | previewId和清洗/隔离状态；只创建禁脚本/外联副本，不修改源页面                                      |
| devtools.preview.verify，DT-05      | previewId、预先批准的视觉判据                                                     | before/after、pass/fail/inconclusive及证据引用；不表示业务修复                                     |
| devtools.preview.dispose，DT-05     | previewId                                                                         | 释放结果，重复调用无新增副作用；不删除用户源文件                                                   |
| devtools.trace.read，DT-06          | 获准taskId/stepId、timeRange、数据类别                                            | 二丫/Provider/工作区已存在关联与缺口；不读凭据，不接远期工作台                                     |

TargetRef由主进程解析到profile/workspace/window/tab/webContents/documentRevision，不以模型传的ID充当可信归属。首期自动采集仅http/https普通网页；内部页、GenOffice、DevTools前端、其他用户档案、未授权子frame/worker拒绝，file需要后续独立读取合同。

Evidence最小信封包括evidenceId/captureId/sourceKind/targetRef/documentRevision/time/coverage/truncated/redactionVersion；Console只承诺文本、级别和裁剪来源位置。网络仅方法、状态/失败码、类型、脱敏来源和单调耗时；URL查询/fragment、敏感路径、headers/body默认不返回。底层原生可观察原始事件不意味着允许将其入缓冲、模型或日志。

工程建议初值：单次最多60秒、500条且总量≤1MiB，单条≤8KiB，分页≤100条且单次返回≤64KiB，长文本以受控证据引用分页读取；采用服务端硬上限，哪项先到先停止并说明原因，缺省值不能表示无限。值为待压测初值，不是性能保证。captureId需同时校验task、grant与document范围，stop可重复消费；导航/撤权后read也须重检，不能用已缓存数据绕过撤权。

新增规范错误：TARGET_CHANGED、TARGET_UNSUPPORTED、CAPTURE_BUSY、CAPTURE_DETACHED、EVIDENCE_EXPIRED、NODE_STALE、PREVIEW_UNSAFE，映射到暂停/范围重选/人工路径。容量达到上限为正常停止原因；CDP断开不自动重连。采集不是修改页面，创建隔离副本仍经L2审批；工具能力未验收时capabilities不登记或标不可用。

## 展示 召回与通知合同增量（v0.5）

下列为UX-STATE、MEM-GUARD、MEM-RECALL和UX-NOTIFY的拟定内部DTO，实施时在erya-contract中定义zod输入输出校验；不新增公开HTTP接口，不改变九态任务协议。来源与适配理由见00。

| 对象                | 必要字段与边界                                                                                                                                                                                            |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| TaskPresentation    | profileId、workspaceId、taskId、taskRevision、latestSequence、state、reasonCode、activeStepIds、completedStepCount、totalStepCount、messageCode、safeParams、resultRefs；来自可信快照，不接受模型直接写入 |
| MemoryRecallRequest | profileId、scope、workspaceId、taskId、query、limits、deadlineAt、grantRevision、policyRevision；身份由可信链路补齐，不由请求值自行授权                                                                   |
| MemoryEvidence      | memoryId、contentVersion、scopeRef、mutationEpoch、kind、content、sourceRefs、capturedAt、expiresAt可空；仅当前许可可见且有效记录                                                                         |
| MemoryRecallResult  | status=ok/unavailable、items、truncated、reasonCode可空；失败时items为空，不返回替换system/history的对象                                                                                                  |
| MemoryJobGuard      | jobId、scopeRef、epochAtStart、sourceVersions、grantRevision、policyRevision、idempotencyKey；只在受控运行时/存储worker流转                                                                               |
| TaskNotification    | notificationId、profileId、workspaceId、taskId、taskRevision、eventSequence、kind、messageCode、createdAt、expiresAt；无正文、任意URL或审批票据                                                           |

scopeRef显式区分profile/workspace并绑定真实资源范围；字段可空不能表示无限权限。MemoryEvidence的sourceRefs携带可验证来源与版本，任务引用同样经解析器检查。RecallRequest中的query与返回content均为不可信资料，不在日志记录，也不能修改系统规则。limits包含maxItems/maxBytes/maxTokens，均为正且受宿主上限约束；deadlineAt为总截止时间，取消信号由进程内AbortSignal及跨进程取消协议传递。

MEM-RECALL建议先试总召回500ms、最多5条、内容合计8KiB及2000 tokens，均为待实测初值，不是服务保证；同时服从09单次记忆上下文预算。按排名加入整条证据，保留ID与版本；超限丢弃末尾条目并标记truncated，不切断来源字段。token预算由所用模型计量器检查，缺计量能力时采用保守上界或拒绝注入，不能用汉字数冒充token。查询改写首版不启用，后续若引入也共用总deadline与预算，不额外无限等待。超时取消、异常或形状非法返回unavailable；迟到响应丢弃。

TaskPresentation是TaskSnapshot/步骤的派生视图，不另建可写事实源。messageCode及safeParams由受控模板渲染；activeStepIds为空不代表完成，完成依据仍是业务状态和核验。展示更新消费已有erya:event信封，按每任务sequence去重；缺口请求快照，不能仅凭更高序号忽略中间授权变化。撤权停止敏感推送并清理界面缓存。

通知kind暂限approval_required/completed/failed/paused；notificationId由持久事件生成并在多窗口/重启间去重，重放不补弹陈旧通知。通知点击只提交不透明目标引用到主进程，经当前身份与任务可见性校验后导航；不直接传任意URL、不批准、不重试工具。任务事件订阅不等于系统通知许可，许可、焦点、勿扰与内容策略在发布前再检查。

## 合同验证与源码依据

CUT-01 合同验证另覆盖旧7个点式IPC通道及其生产者/消费者、事件名、流式端口和取消配对。更新调用与注册必须同批完成；发布候选版测试旧调用返回不支持且不产生副作用，新Pi和erya链路各自正常，未授权界面不能借遗留入口绕过权限。供应商 `ai:*` 仅在已登记的隔离适配器内使用，不作为二丫公共合同。03新增后续场景中的标签整理、记忆合并和长期目标接口是能力需求，未在本合同列出前不得宣称已经支持。

实现时为上述通道补 zod 入出参、坏请求、跨区、撤权、审批变参、同键重试、事件重连和取消后未知结果测试。示例 DTO 应由合同测试验证，防止文档与实现各写一套。

- [现有 IPC schema](https://github.com/sgobiorodolfo170-ai/Urchin-Browser/blob/7f9f59af29c641ae5900849ee685dc3570a443b6/packages/ipc-contract/src/schemas/ipc-schema.ts)

- [调用包装与超时语义](https://github.com/sgobiorodolfo170-ai/Urchin-Browser/blob/7f9f59af29c641ae5900849ee685dc3570a443b6/packages/ipc-contract/src/server.ts#L69)

- [当前 IPC 错误合同](https://github.com/sgobiorodolfo170-ai/Urchin-Browser/blob/7f9f59af29c641ae5900849ee685dc3570a443b6/packages/ipc-contract/src/errors.ts)

- [页面提取处理器](https://github.com/sgobiorodolfo170-ai/Urchin-Browser/blob/7f9f59af29c641ae5900849ee685dc3570a443b6/apps/desktop/src/main/page-context/register-handlers.ts)

- [当前 Provider 消息结构](https://github.com/sgobiorodolfo170-ai/Urchin-Browser/blob/7f9f59af29c641ae5900849ee685dc3570a443b6/packages/ai-provider-contract/src/messages.ts)

## 全能力工具和控制合同（v0.6）

[13 全能力接入设计](./13-二丫全能力接入设计.md)维护逐通道接入决定、V-T/D/F/J/S/M/U核验模板及web.*专用schema；原生请求复用领域req/res，在外围绑定ToolInvocation和资源/审批。新增工具在ALL-02建立zod合同与兼容测试前不得暴露；不提供通用invoke/evaluate端点。

| 拟控制通道/对象 | 最小输入与返回 | 关键语义 |
| --- | --- | --- |
| erya.capabilities.get增量 | taskId可选、cursor/limit → manifestRevision、actionId/toolId、input/outputSchema、adapterVersion、调用模式、平台/限制与不可用原因 | 按真实身份过滤；参数分支可分页，不泄露秘密资源，未知不可调用 |
| erya.tasks.pause | taskId、expectedRevision、idempotencyKey → accepted、TaskSnapshot、在途步骤状态 | 先禁止新派发，再请求取消；已提交副作用核验，不能假装撤回 |
| erya.handoffs.get | handoffId → 原因、脱敏目标、过期时间及允许下一步 | 仅当前主体可见，不返回凭据/原生窗口秘密 |
| erya.handoffs.resume | handoffId、expectedTaskRevision、idempotencyKey → 重检后的TaskSnapshot | 用户明确继续；旧审批/元素引用不复用，不把点击恢复当批准新提交 |
| DomainJobRef | operationId、domainJobId、state、cancelMode、receiptLookup、resultRefs | accepted/running/succeeded/failed/cancel_requested/cancelled/outcome_unknown为异步操作状态，非新增任务状态；取消请求不等于取消成功 |
| PageTarget/ElementRef | profile/workspace/window/tab、实际origin、frameRef、documentRevision、captureId；element引用不透明且限时 | 身份由主进程生成；导航/frame变化使引用失效，禁止任意webContentsId |
| WorkbenchHandoff | sourceTaskId、目标工作台、targetTaskId可空、资源/预算/版本、expiresAt、argsHash、operationId | 两侧分别授权；仅FUT立项及专属协议实现后开放，无原始供应商方法代理 |

错误增补CAPABILITY_UNAVAILABLE、MANIFEST_CHANGED、TARGET_STALE、ELEMENT_AMBIGUOUS、ELEMENT_NOT_INTERACTABLE、ORIGIN_NOT_ALLOWED、HANDOFF_REQUIRED、HANDOFF_EXPIRED、SUBMISSION_UNKNOWN；错误码到暂停/重观察/可信接管的映射由适配器明确，不能仅依retryable自动重试写操作。计划/manifest语义改变后重新规划和审批，不沿用旧参数摘要。

原生适配样例：download.pause输入授权downloadId与期望状态，回读领域状态；file.saveAs输入fileRef/目标目录引用/内容摘要及覆盖审批，返回文件版本/摘要；settings.updateAllowed输入具体已登记键、expectedRevision与新值，返回实际生效值。每个工具还须绑定13中的具体actionId、原schema和验证器；这些样例不代表领域已经支持CAS/幂等，缺失部分由NAT/SYS任务补齐。

所有新增控制请求保持可信UI sender限制、幂等/版本与既有事件恢复规则。网页/工作台观察信息也只推送获准窗口，撤权后停止并清除未发出缓存；审批仍通过erya.approvals.decide处理，不由网页或供应商界面直写二丫授权。

原生截图完整工具还需区分captureMode=window/viewport/region、目标引用、区域DIP坐标及screen/displayRevision；界面框选是人工接管模式，不能把screenshot.capture已打开框选层当成自动截图完成。回执包含实际尺寸、受控imageRef/摘要与保存结果；多屏/DPI或窗口移动后旧区域失效，截图外发单独授权。

标签排序/跨窗口移动需明确源、目标、前后位置及预期顺序；目前tab.reorder不等于已有跨窗口移动领域合同，ALL-01应拆动作并由NAT-01补缺口。设置键、Home方法和原生UI枚举的完整展开见13，未支持分支不能通过native.*名字存在就显示可用。

## 地址栏 双气泡与配置合同（v0.7）

05为交互/配置数值真源，07为持久化目录与表结构真源；以下为UX-OMNI/BUBBLE/PREF和DATA-ERYA的拟新增zod合同，尚未实现。仅可信宿主界面可调用，按profile/workspace/会话及窗口注册校验，普通网页不能调用或伪造位置/审批。

| 拟通道/DTO | 输入与返回 | 必要约束 |
| --- | --- | --- |
| erya.messages.send | conversationId可空、clientMessageId、content、contextRefs/attachmentRefs、expectedConversationRevision、modelPolicy/预算引用、idempotencyKey → accepted、messageId、conversationId、taskId、queued、revision | 同键同规范化请求返回原回执，同键异内容冲突；消息与本地任务入队同事务/可恢复outbox，不能先显示成功后丢任务 |
| erya.conversations.list / erya.messages.list | 当前范围、conversationId、afterSequence/cursor、limit → 授权摘要或分页可见消息 | 不返回其他工作区/无痕或隐藏工具秘密；消息保留期与自动隐藏分开 |
| erya.uiSnapshot.get | conversationId、已登记layoutSlotId → 两角色布局、消息摘要/未读、配置revision、任务状态 | 几何与内容均按真实sender裁剪，不接受任意windowId跨窗读取 |
| erya.bubbles.layout.update | layoutSlotId、bubbleRole、anchor、xRatio/yRatio、expectedRevision、idempotencyKey → 宿主夹取后的布局/revision | 仅user/assistant，坐标合法且属于当前窗口槽，拖动结束保存；无痕仅内存 |
| erya.bubbles.layout.reset | layoutSlotId、bubbleRole或both、expectedRevisions、idempotencyKey → 默认布局 | 只重置位置，不改尺寸设置或删除内容；跨角色重置先检查相应revision集合 |
| erya.uiSettings.get / erya.uiSettings.update | 读取无秘密配置；写入05允许的气泡字段patch、expectedRevision、idempotencyKey → 生效配置/revision | 类型、范围及未知键严格校验；不兼作模型/权限/记忆或密钥通用写入口 |
| BubbleProjection | conversationId、bubbleRole、latestSequence、visibleMessageIds、displayState、unreadCount、pendingAction、taskRefs | 由可信事实投影，隐藏不是任务state；不把每个token当新消息 |
| ContextDraft | originTab/documentRef、显式contextRefs、受控attachmentRefs及显示元数据 | 草稿默认内存；选入不自动读内容或外发；切页不自动改目标 |

暂停/取消/审批沿用erya.tasks.pause/cancel、erya.approvals.decide，不新增“关闭气泡即取消”的API。UI配置更新事件只带schemaVersion、配置revision和允许字段/变更通知，不能混入消息正文或密钥。messages事件增加message.accepted/started/delta/finalized/failed，携带conversationId/messageId、角色、状态/内容revision及任务信封sequence；接收/入队持久，delta可短缓冲，缺口取快照，不因重放重显或重复消费审批。

消息send中的expectedConversationRevision在新会话时按空/初始版本合同明确，服务端原子建会话、写用户消息与outbox；重复clientMessageId必须比对摘要，消息ID和任务键分别持久关联。send返回accepted只证明已受理，不证明模型或工具成功。UI重试沿用原键直到得到确定回执，用户明确再次发相同文字生成新键。附件验证失败不部分接收未说明的消息，上传/拷贝任务有独立进度与失败回执。

未实现delete会话/保留期配置合同前，设置页不能展示假按钮；DATA-ERYA需补erya.conversations.delete及消息保留策略管理，输入会话/作用域、expectedRevision、删除范围与操作键，返回清理状态/受影响附件和派生项；消息清理不自动删除用户独立产物。所有二丫设置由同页调用各专属合同，不能用uiSettings.update修改Grant或模型凭据。

前端字段navigationDraft/eryaDraft、inputMode、IME composing及显隐计时为受控UI状态；导航提交与messages.send完全分离。原文档settings/消息布局配置提到的主窗口限制仍有效；新增overlay若有独立sender须按06注册最小白名单，不能放开全部窗口调用审批。
