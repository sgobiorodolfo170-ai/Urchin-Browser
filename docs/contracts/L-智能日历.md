# L · 智能日历（M28，P0 + P1 本地能力）

依据：[产品方案](../顽童浏览器_智能日历组件产品方案与建设规范_完善整合最终版.md)、[ADR-023](../decisions/ADR-023-本地日历与预备工具边界.md)。2026-11-16 用户确认本次完成 P0 + P1 本地增强；P2/P3 独立立项。AI 助手仍为占位，本模块只预备日历能力，不决定助手架构、注册方式或开发方向。

## 架构与单一真源

Renderer CalendarDialog → 现有 Preload typed invoke → M17 Zod 双向校验 → Main CalendarService / Repository → M8 `urchin.db`。不将日程写入 notebook.state、ai.db 或远端。不另造 Agent 或自动化引擎。

`packages/ipc-contract/src/schemas/calendar.ts` 是 Calendar、Event、Recurrence、Attendee、Relation、Reminder、Backup、Context 及 IPC 的单一真源。calendarChannels 合入现有 ipcSchema，沿用现有 Preload。主库 migration 5 保存日历/事件/幂等响应/审计，migration 6 保存单次例外/提醒投递/恢复快照。

本机单用户所有权，调用只接受受管主窗口 webContents；请求不得传 ownerId。日志不写事件标题、正文或会议链接。日历事件变更后发送无内容的 calendar.changed 通知，窗口重新读取；calendar.reminder 通知提示读取持久提醒列表。

## IPC

| 通道 | 语义 |
| --- | --- |
| calendar.listCalendars | 默认日历、颜色、时区、启用与写权限 |
| calendar.saveCalendar | 创建/编辑/默认切换/归档；编辑要求 expectedVersion，最多 100 个日历 |
| calendar.listEvents | 半开范围内事件，日历筛选，可包含软删除；重复实例按需展开 |
| calendar.getEvent | 主事件或稳定实例 ID 的最新版本 |
| calendar.createEvent | 完整输入 + 必填 idempotencyKey，事务内创建 |
| calendar.updateEvent | 完整输入 + eventId + expectedVersion；重复操作要求 scope |
| calendar.deleteEvent | 软删除，要求最新版本及重复操作范围 |
| calendar.restoreEvent | 恢复普通事件、单次取消或已删除系列 |
| calendar.checkConflicts | 半开区间冲突，排除当前事件/系列，取消事件不占忙 |
| calendar.findFreeSlots | 范围、时长、日历、缓冲、时区、工作星期/时间、排除项、结果上限 |
| calendar.listReminders | 最近 100 条未关闭的持久提醒，按应提醒时间倒序 |
| calendar.dismissReminder | 关闭持久提醒 |
| calendar.exportBackup | 完整日历 JSON、当前内容 digest、上次恢复前快照 |
| calendar.importBackup | 校验后的事务替换；要求确认时 digest，返回恢复数量 |

日历列表为空筛选时，查询启用日历；明确传 calendarIds 可查看已归档日历，界面可单独勾选。事件写入要求目标日历启用且可写。默认日历不能直接归档，须先指定其他默认日历。

查询范围最多 366 天；每段连续空档返回一个最早候选，并按 limit 截断。空闲结果只反映本地记录，不等于现实世界绝对可用。冲突不自动改期，界面保存冲突事件要求再次确认。

## 时间与重复

定时事件使用带偏移 ISO 瞬时值，保留 IANA 时区；全天使用 YYYY-MM-DD 和不含结束日的半开日期范围。服务统一换算 DST 边界。界面时刻表以当前系统时区显示，事件详情标注事件时区。

支持 daily/weekly/monthly/yearly、interval、weekly byWeekday、count 与 endDate。月末无对应日和非闰年 2 月 29 日跳过；DST 中不存在的本地时刻跳过且不计有效次数。count 对有效实例计数，最多 10000；无次数限制的老系列直接跳到查询附近，避免从多年以前逐日扫描。单次请求有 10000 周期展开护栏，超过明确报错。

实例 ID 为主事件 ID@民用日期；seriesId 与 occurrenceDate 仅由服务生成，实例版本使用主事件版本。有限 count 系列提供 occurrenceIndex；对已跳过历史的无穷系列该索引可为 null，不假装已统计全部历史。

- single：保存独立覆盖或取消，不改变其他实例。
- future：截断旧系列，再建立新系列；更新请求中的 count 表示新系列的剩余次数，界面按当前实例自动预填。删除后半段也保留为已删除系列，可恢复。
- series：从系列锚点应用修改，不把选中的较晚实例误当作新的首日；停止重复时清理例外。

修改/删除重复事件未指定 scope 返回 INVALID_ARGUMENT。规则变化后不再属于系列的历史例外不展示。普通删除、单次取消和系列删除均可恢复，没有自动清除任务。

## 可靠性、恢复与错误

创建幂等键和初次响应持久保存，编辑后同键重试仍返回初次响应；同键不同内容报 IDEMPOTENCY_CONFLICT。修改、例外、拆分、删除、恢复在同一事务内检查 expectedVersion 并递增版本；不匹配报 VERSION_CONFLICT。事件、请求键和审计同事务写入，审计只记录操作、来源、时间和版本。

领域错误包括 NOT_FOUND、INVALID_ARGUMENT、VERSION_CONFLICT、IDEMPOTENCY_CONFLICT；M17 外层沿用现有错误信封，领域码在消息中保留。数据库异常不跨 IPC 泄漏细节。AI Mock 可直接读取 CalendarError.code；这不规定真实助手的错误适配方案。

JSON 备份包含全部日历、主事件、例外、初次响应、审计和提醒去重记录。界面导入限制 5MB，先校验格式、对象唯一性和依赖，再展示覆盖确认；恢复前自动保存最近 3 份完整快照，提供“撤销上次恢复”。确认后数据有变化时拒绝恢复，避免覆盖其他窗口新写入。恢复在事务内完成并提高事件/日历版本，旧编辑器不能覆盖恢复结果。

大数据量或整机迁移可在关闭所有实例后备份完整配置数据目录（urchin.db 及存在的 WAL/SHM），不要只备份 notebook.state 或 ai.db。日历 JSON 不包含关联文件本体或其他模块数据，恢复日历也不会改动笔记、任务或邮箱。

## 提醒

Main 每 15 秒扫描当前启用日历，启动 1 秒后补偿最近 24 小时应触发的提醒。去重键包含实例 ID、开始瞬时、提醒方式和提前分钟数；改标题不会重发，改期会产生新的正确触发点，取消/软删除/归档日历不再触发。投递记录与未关闭提醒持久保留，退出清理先停止扫描再关闭存储。

默认应用内提示；用户选择 notification 时同时尝试系统通知。先持久记录再通知，采用至多一次策略；系统通知失败或系统禁用通知时，仍可查看持久应用内提示。不能保证进程完全退出、设备关机或超过补偿窗口后的提醒；没有后台系统服务，不承诺 OS 已实际展示。

## 关联、参与者与真实依赖

现有速记笔记/任务可在表单中按名称选择，详情可跳转回对应对象，保持其所属笔记本和任务视图正确。参与者可保存联系人引用、显示名、角色与响应状态，不推断邮箱、不发送邀请。

项目与联系人目录尚无独立模块/API；邮件、文件也未提供统一的日历引用解析入口。它们的 type/id 引用可保存与编辑，但不声称已确认外部对象存在或完成自动跳转，不复制业务正文，也不为日历新建这些模块。由所属模块提供解析能力后继续接通。删除的笔记/任务会保留原引用并明确作为待解析引用显示。

## AI 预备契约与手册

calendarToolContracts 导出以下 8 个契约，与 IPC 同源；createCalendarOperations 提供纯日历服务函数映射，测试用 Mock Host 校验参数、执行与结果。没有注册到任何助手，不要求未来助手采用特定 Gateway、Registry 或上下文机制。calendarContextSchema 提供可选数据规范，不自动收集或注入。

| 意图 | 契约 | 操作约束 |
| --- | --- | --- |
| 有哪些日历 | calendar_list_calendars | 使用返回的 ID、默认标记和权限 |
| 查询安排 | calendar_list_events / calendar_get_event | 先确定时区与范围，读取最新版本 |
| 新增 | calendar_create_event | 校验必填项，查冲突，稳定请求键 |
| 修改 | calendar_get_event → calendar_update_event | 使用最新版本；重复事件明确 scope |
| 删除 | calendar_get_event → calendar_delete_event | 明确目标、范围及用户授权 |
| 查重叠 | calendar_check_conflicts | 明示冲突，不擅自改期 |
| 找空闲 | calendar_find_free_slots | 结果仅为候选，创建前再次查重叠 |

可选提示词片段（供未来助手开发者评估，不自动注入）：

> 调用日历前明确用户时区与时间范围。定时事件必须有偏移，全天结束日期不包含在范围内。创建使用稳定幂等键并在重试时复用。修改与删除前读取最新版本，VERSION_CONFLICT 后重新读取并确认变化。歧义时间、多目标、删除或冲突按用户授权范围确认。重复操作明确 single/future/series，future 的 count 是新系列剩余次数。工具失败不得报告成功。参与者引用不代表发送邀请，系统通知结果不代表用户已读。

建议上下文数据：日期、时区、可访问日历 ID、查询范围、选中事件 ID/版本、能力状态。不规定助手如何存储、更新或注入，不为其建设对话、路由、排期或全局主动服务。

真实 AI 注册与自然语言操作等待助手建设；ICS、外部日历、邀请、共享与多端同步属 P2/P3，不创建外部连接、凭据或令牌。
