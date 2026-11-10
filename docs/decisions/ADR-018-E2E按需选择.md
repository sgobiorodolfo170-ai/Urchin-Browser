# ADR-018 · E2E 按需选择（manifest 单一真源 + check 门禁）

> 状态：Accepted · 决策日：2026-11-10 · 关联决策：ES1
> 关联：[ADR-019 内存回归线环境分线](./ADR-019-内存回归线环境分线.md) · [E2E 用例选择表](../E2E用例选择表.md) · [事实登记表 F5](../事实登记表.md) · [03-技术栈 §7](../03-技术栈.md#7-测试约定) · [AGENTS.md](../../AGENTS.md) §九.4 G20

---

## 1. 背景

2026-11-10 实测：本机全量 E2E = **23 个 spec / 38 例 / 3.4 分钟**（36 passed + 2 skipped），CI 最近一次真实执行（run 42770786468，dev.177 / 66a4fb7）= 26 passed / 12 skipped / 1.8 分钟。

此前的本地约定是「UI / 交互变更追加 `pnpm e2e`」，但存在两个结构性问题：

1. **成本与信号比失衡**：任意一处改动都要跑全部 38 例，其中 20+ 条与本次改动无关。真正的回归信号（如改了 tabs）淹没在剪藏、GenOffice、翻译、工作区的无关链路里；失败时还要逐条排除「是不是本来就绿的那几条」。
2. **约定不可执行**：E2E 不在 `pnpm verify` 链里，pre-commit / pre-push 只校验 verify 指纹。于是「忘了跑」不会在本机被拦下，只能等 CI 才发现，而 CI 反馈周期以十分钟计。

「每次都全量跑」被**否决**：3.4 分钟 × 每次改动 + 28 条无关链路噪声，成本高且掩盖真实回归。但「本地只跑相关用例」不能靠人肉记忆 spec 与源码的映射——那会变成新的漂移源。

## 2. 决策

**ES1 · 本地默认按需选择（MUST）**

- 本地 E2E 默认入口改为 `pnpm e2e:select --dry-run --json`：采集改动 → 按 manifest 的 `triggers` 匹配 → 并入 `alwaysRecommend` 基线 → 输出推荐（含依赖警告与总预估时长）。
- **选择交互归 AI 会话，不归项目代码**：AI 拿到推荐后，用自身的复选/问答工具（如 `question`）把 `spec / 例数 / 耗时 / 依赖 / 推荐理由` 展示给用户，由用户勾选；AI 再用 `--specs=...` 执行。**项目内不得新建 GUI 窗口或 PowerShell 弹窗。**
- **AI 不得默认全量跑**：必须先出表 → 给建议 → 用户勾选。全量仅限三种情况：发布前、选择器无法判定（无改动 / 无匹配 / 改动涉及契约等全局面）、用户明确要求。
- 非交互环境（无 TTY / CI）**不允许静默执行**：默认只打印推荐表并退出码 3，要求显式 `--specs=...` 或 `--fallback`。
- 运行器还提供 `--dry-run`、`--json`、`--changed=<path>`、`--list`，供 AI 组装选择项与人工查看。

**ES1.1 · manifest 是唯一真源**

`apps/desktop/tests/e2e/manifest.json` 每个 spec 一条：`spec / area / tests / durationSec / triggers / deps / ciRuns / alwaysRecommend / note`。触发路径、依赖（`genoffice-artifact | vendor-dsh | api-key | none`）与耗时都只在这里维护；`docs/E2E用例选择表.md` 是它的可读投影，不重复定义规则。

**ES1.2 · 双向一致性是硬门禁（G20）**

`pnpm check:e2e-manifest`（`scripts/check-e2e-manifest.mjs`）扫描 spec 目录与 manifest 双向比对：

- spec 文件没有 manifest 条目 → fail（新用例永远不被推荐，本地永远不跑）；
- manifest 条目没有 spec 文件 → fail（推荐一个不存在的文件，playwright 直接报错）；
- 字段类型 / deps 枚举 / triggers 非空 / tests 与 durationSec 为正数 → 非法即 fail。

已接入 `pnpm verify` 与 CI 独立步骤，登记为 AGENTS.md §九.4 **G20**。

**ES1.3 · CI 语义不变**

CI 永远走 `pnpm e2e`（全量），且 CI 中绝不出现任何交互。本地按需、CI 全量的分工写在选择表与 AGENTS.md 工作流约定 #2。

**ES1.4 · 回退机制（MUST）**

按需方案失效时**直接回退到原全量方式**，不改代码、不回滚提交：

- 命令：`pnpm e2e`（原测试方式）或 `pnpm e2e:select -- --fallback`；
- 触发条件：脚本报错 / manifest 非法 / 无改动 / 无匹配 / 选择工具不可用 / 用户不在场 / 用户明确要求全量 / 发现推荐集合明显漏项；
- 回退不是失败：在回复中写清原因；若因 manifest 漏项，补条目并跑 `pnpm check:e2e-manifest`。

## 3. 否决方案

| 方案 | 否决理由 |
| --- | --- |
| 每次改动都全量跑（原约定） | 3.4 分钟 × 每次改动；28 条无关链路噪声掩盖真实回归；且不在 verify 链里，仍然会「忘跑」 |
| 只靠人肉记 spec 映射 / 手工 `--specs=` | 映射会随文件移动立刻漂移，无机械校验；新人不具备该知识 |
| 按改动自动跑、不询问用户 | 用户失去「这次想验什么」的控制权；部分改动（如 UI 文案）用户可能明确不想跑 E2E；也无法在跑前看到依赖警告 |
| 项目内自带 WinForms/PowerShell 弹窗（首版方案，2026-11-10 修订时否决） | 偏离用户设想：选择应发生在 AI 会话里；跨平台/无 GUI 环境不可用；与 agent 的问答交互割裂；项目职责膨胀（维护一段 PowerShell UI 代码） |
| 只在发布前全量、本地一律不跑 | 回归反馈太晚，违背「小步快跑 + 改动后验证」 |
| 让 E2E 进 `pnpm verify` | 每次 verify 至少 +3.4 分钟，且与「按需」目标直接冲突；CI 已全量兜底 |

## 4. 证据（2026-11-10）

| 场景 | 结果 |
| --- | --- |
| 本机全量 | 23 spec / 38 例 / 3.4 min，36 passed + 2 skipped（pi-agent 缺 key） |
| `--dry-run --changed=apps/desktop/src/main/tabs/tab-manager.ts` | 推荐 8 spec / 12 例 / 1m16s（含 launch 基线 + tab 系 + perf/session/workspaces） |
| `--dry-run --changed=docs/...` | 0 条，说明「文档改动无需 E2E」 |
| `--dry-run --changed=<无匹配路径>` | 建议全量 23 spec / 38 例，说明原因 |
| 会话内选择（2026-11-10 实测） | AI 跑 `--dry-run --json` 推荐 `launch` + 3 个 notebook spec（4 spec / 7 例）；用户确认后执行 7 passed / 21.4s |
| CI 真实执行 | run 42803495499（2026-11-10，cd7178de）：**35 passed / 3 skipped / 2.0 min，0 failed / 0 flaky** |

## 5. 影响与约束

- 新增文件：`apps/desktop/tests/e2e/manifest.json`、`scripts/e2e-select.mjs`、`scripts/lib/e2e-select-core.mjs`、`scripts/check-e2e-manifest.mjs`、`docs/E2E用例选择表.md`；单测在 `apps/desktop/tests/unit/scripts/e2e-select-core.test.ts`。
- **不新增任何依赖，也不新增 GUI**：项目脚本只做推荐与执行；选择 UI 由 AI 会话工具承担。
- 改动 `scripts/**` 不计入覆盖率 include（与既有构建脚本一致）；匹配/推荐核心逻辑已抽出并由单测覆盖。
- manifest 的 `durationSec` 是本机实测值，仅用于「预估时长」，不作为性能门槛。

## 6. 修订记录

| 日期 | 修订 | 原因 |
| --- | --- | --- |
| 2026-11-10 | 首版 ES1：`e2e-select` 自带 PowerShell/WinForms 复选窗 | 初版实现 |
| 2026-11-10 | ES1 修订：删除项目内 GUI，选择改由 AI 会话内工具完成；新增 ES1.4 回退机制 | 用户明确要求「复选弹窗应由 agent 工具在 AI 会话发起，项目里只有文档约束，不是单独创建软件窗口」 |