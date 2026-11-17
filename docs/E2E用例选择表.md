# E2E 用例选择表

> 状态：已生效 · 建立：2026-11-10 · 决策：[ADR-018](./decisions/ADR-018-E2E按需选择.md)（按需选择）· [ADR-019](./decisions/ADR-019-内存回归线环境分线.md)（内存回归线）
> 单一真源：[`apps/desktop/tests/e2e/manifest.json`](../apps/desktop/tests/e2e/manifest.json) · 门禁：G20 `pnpm check:e2e-manifest` · 运行器：`scripts/e2e-select.mjs`

> **当前策略（2026-11-17 用户指令）**：本地 E2E 是否运行、跑哪些、是否全量由模型按风险自主判断（MAY）。可跳过，无需例行询问；选择器失效或用户不在场不触发自动全量。旧「先问用户、异常必回退」约定已被取代。

## 1. 一句话规则

模型综合改动范围、回归风险、已有证据、成本与环境，选择不跑、定向跑或全量跑。用户明确指定的验证要求优先；现有 CI 仍按工作流全量执行且不交互。

## 2. 谁负责什么

| 角色 | 负责 |
| --- | --- |
| `scripts/e2e-select.mjs` | 根据 manifest 计算推荐、输出 JSON、执行显式指定的 spec 或全量；不创建 GUI |
| AI（agent） | 自主判断验证价值、范围与替代方式，如实说明结果和未验证范围 |
| 用户 | 可明确指定验证范围，无需每次参与勾选 |
| CI | 按 `.github/workflows/` 执行现有全量配置，不交互 |

## 3. 可选流程（供模型判断时参考）

1. 评估改动是否需要 E2E；纯文档、文案或已由其他检查充分覆盖的改动可跳过。
2. 需要辅助选例时，可运行 `pnpm e2e:select -- --dry-run --json`，结合源码与用例自行选择。推荐、`alwaysRecommend` 与 `fallbackCommand` 都不是执行义务。
3. 定向验证可用 `pnpm e2e:select -- --specs=launch.spec.ts,clipper.spec.ts`；需要全量时用 `pnpm e2e`。
4. 简述执行范围、结果与有意义的跳过原因；环境缺依赖时说明局限，不把 skip 当作通过。

## 4. 选择器不可用时的处理

| 情况 | 可选处理 |
| --- | --- |
| 选择器报错 / manifest 非法 | 直接指定已确认的相关 spec、修复选择器或采用其他验证；不自动全量 |
| 无改动 / 无匹配 | 结合实际 diff 判断是否需要验证；无匹配本身不构成全量理由 |
| 涉及 IPC / 生命周期等跨模块改动 | 根据影响面扩大定向范围或选择全量 |
| 用户不在场 / 无问答工具 | 模型自行决定，无需等待或扩大范围 |
| 推荐漏项 | 自行补选相关用例；涉及映射变更时维护 manifest |
| 用户明确要求全量 | 执行全量；受环境限制时如实报告 |

`pnpm e2e` 与 `pnpm e2e:select -- --fallback` 仍是可用的全量入口，是否使用由任务需要决定。

## 5. 本地 / CI 分工与命令

| 环境 | 入口 | 范围 | 交互 |
| --- | --- | --- | --- |
| 本地（不跑） | 无 | 模型判断无需 E2E | 无需询问 |
| 本地（辅助选例） | `pnpm e2e:select -- --dry-run --json` | 只输出推荐 | 无 |
| 本地（定向） | `pnpm e2e:select -- --specs=...` | 模型选择的相关 spec | 无需例行询问 |
| 本地（全量） | `pnpm e2e` 或 `pnpm e2e:select -- --fallback` | 全量 | 无 |
| CI | `pnpm e2e` | 现有工作流全量 | 不交互 |

命令示例：

```bash
pnpm e2e:select -- --dry-run --json                       # 可选：查看推荐
pnpm e2e:select -- --dry-run --changed=apps/desktop/src/main/tabs/tab-manager.ts
pnpm e2e:select -- --specs=launch.spec.ts,clipper.spec.ts  # 执行选定用例
pnpm e2e:select -- --list                                 # 查看用例清单
pnpm e2e:select -- --fallback                             # 显式执行全量
pnpm check:e2e-manifest                                   # 检查 manifest 与 spec 一致性
```

> `--json` 输出 `{ mode, note, files, recommended, all, totalDurationSec, fallbackCommand }`，供模型参考。直接运行 `pnpm e2e:select`（不带参数）只打印推荐并以退出码 3 结束，不执行测试；这是现有 CLI 行为，不要求模型额外向用户确认。

## 6. 2026-11-10 本机基线

| 项 | 值 |
| --- | --- |
| spec 文件 / 用例 | **23 / 38** |
| 本机全量（2026-11-10，JSON reporter 合计） | **36 passed / 2 skipped / 3.4 min**（另一次 2.8 min） |
| CI 最新真实执行（run 42803495499，2026-11-10，cd7178de） | **35 passed / 3 skipped / 2.0 min，0 failed / 0 flaky** |
| CI 历史（run 42770786468，dev.177 / 66a4fb7） | 26 passed / 12 skipped / 1.8 min |
| CI 12 skip 构成（A1 前） | GenOffice 9（缺嵌入产物）+ pi-agent 2（缺 key）+ dsh 1（缺 vendor/便携 node） |
| A1 补齐后 CI 构成 | **35 passed / 3 skipped**（仅剩 pi-agent×2 + dsh×1） |

耗时口径：单 spec 用例时长之和（含 Electron 启动开销），来自 `playwright test --reporter=json`；用于「预估」，不作为性能门槛。

## 7. 用例表

| spec | 能力域 | 例数 | 耗时 | 依赖 | CI 真实执行 | 建议级别 | 触发改动路径（manifest triggers） |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `bookmark-folder-delete.spec.ts` | 收藏夹面板 | 2 | 6s | 无 | 是 | 命中时建议 | `main/bookmarks/**` · `main/panel/**` · `renderer/panel/**` |
| `bookmark-panel-visibility.spec.ts` | 收藏夹面板 | 1 | 6s | 无 | 是 | 命中时建议 | 收藏夹 + `main/status-bar/**` · `renderer/status-bar/**` |
| `clipper-mhtml-viewer.spec.ts` | 剪藏 | 1 | 5s | 无 | 是 | 命中时建议 | `main/clipper/**` · `main/files/**` · `main/protocol/**` · `renderer/files/**` |
| `clipper.spec.ts` | 剪藏 | 1 | 6s | 无 | 是 | 命中时建议 | 剪藏 + `main/status-bar/**` · `renderer/status-bar/**` · `renderer/omnibox/**` |
| `devtools-panel.spec.ts` | DevTools | 3 | 10s | 无 | 是 | 命中时建议 | `main/devtools/**` · `renderer/devtools/**` |
| `devtools-native.spec.ts` | DevTools | 1 | 45s（预算；本轮实测约 25s） | 无 | 是 | 命中时建议 | 原生 F12 输入/固定目标/20 轮开关；触发路径以 manifest 为准 |
| `dsh-lifecycle.spec.ts` | DeepSeek Harness | 1 | 9s | **vendor-dsh** | **否（skip）** | 命中时建议 | `main/deepseek-harness/**` · `renderer/sidebar/**` · `main/tabs/**` · `scripts/fetch-dsh.mjs` · `scripts/fetch-node.mjs` |
| `genoffice-editors.spec.ts` | GenOffice | 5 | 15s | **genoffice-artifact** | 是（A1 后） | 命中时建议 | `main/genoffice/**` · `main/files/**` · `main/protocol/**` · `renderer/files/**` · `scripts/genoffice-build.mjs` |
| `genoffice-markdown.spec.ts` | GenOffice | 4 | 20s | **genoffice-artifact** | 是（A1 后） | 命中时建议 | 同上 |
| `homepage-memory-measure.spec.ts` | 标签与启动 | 1 | 17s | 无 | 是 | 命中时建议 | `renderer/home/**` · `main/tabs/**` · `renderer/sidebar/**` |
| `launch.spec.ts` | 标签与启动 | 4 | 10s | 无 | 是 | **推荐基线（非必跑）** | 启动/标签/状态栏/omnibox/组件/preload 多路 glob |
| `notebook-layout-check.spec.ts` | 笔记 | 1 | 4s | 无 | 是 | 命中时建议 | `renderer/notebook/**` |
| `notebook-middle-drag.spec.ts` | 笔记 | 1 | 3s | 无 | 是 | 命中时建议 | `renderer/notebook/**` |
| `notebook.spec.ts` | 笔记 | 1 | 3s | 无 | 是 | 命中时建议 | `renderer/notebook/**` · `renderer/sidebar/**` · `main/settings/**` |
| `perf.spec.ts` | 性能 | 1 | 12s | 无 | 是 | 命中时建议 | `main/tabs/**` · `renderer/home/**` · `renderer/sidebar/**` · `renderer/components/**` |
| `pi-agent-build.spec.ts` | pi agent | 1 | ~300s | **api-key** | **否（skip）** | 命中时建议（需 key） | `packages/pi-web-host/src/pi-server/**` · `main/pi-web-host/**` · `tests/e2e/helpers/pi-agent-driver.ts` · `apps/pi-web/**` |
| `pi-agent-tetris.spec.ts` | pi agent | 1 | ~300s | **api-key** | **否（skip）** | 命中时建议（需 key） | 同上 |
| `pi-web-host.spec.ts` | pi 托管 | 2 | 9s | 无 | 是 | 命中时建议 | `main/pi-web-host/**` · `packages/pi-web-host/**` · `apps/pi-web/**` · `renderer/sidebar/**` · `scripts/build-pi-web.mjs` |
| `session-restore.spec.ts` | 标签与启动 | 1 | 5s | 无 | 是 | 命中时建议 | `main/tabs/**` · `main/workspaces/**` · `main/lifecycle/**` · `main/bootstrap/**` |
| `settings-page.spec.ts` | 设置 | 1 | 4s | 无 | 是 | 命中时建议 | `main/settings/**` · `renderer/settings/**` · `renderer/components/**` |
| `tab-close-activation.spec.ts` | 标签与启动 | 1 | 3s | 无 | 是 | 命中时建议 | `main/tabs/**` · `renderer/tabs/**` · `renderer/sidebar/**` |
| `tab-order-repro.spec.ts` | 标签与启动 | 1 | 8s | 无 | 是 | 命中时建议 | 同上 |
| `translate.spec.ts` | 翻译 | 1 | 3s | 无 | 是 | 命中时建议 | `main/translate/**` · `renderer/translate/**` · `main/status-bar/**` · `renderer/status-bar/**` |
| `workspaces.spec.ts` | 工作区 | 4 | 55s | 无 | 是 | 命中时建议 | `main/workspaces/**` · `renderer/workspaces/**` · `renderer/sidebar/**` · `main/tabs/**` |

> 路径前缀省略了 `apps/desktop/src/`；完整 glob 以 manifest 为准。`CI 真实执行 = 否` 表示该 spec 在 CI 会 **skip**（依赖不入版本控制或缺 key），而不是「CI 不运行它」。
| `mail-oauth.spec.ts` | 邮箱 | 1 | 8s | 无 | 是 | 命中时建议 | `main/mail/**` · `renderer/mail/**` · `tests/unit/mail*` |


## 8. 依赖与跳过说明

| 依赖 | 缺失时的行为 | 补齐方式 |
| --- | --- | --- |
| `genoffice-artifact` | `genoffice-*.spec.ts` 整组 `test.skip` | `pnpm genoffice:build`；CI 由 A1 步骤构建并缓存 |
| `vendor-dsh` | `dsh-lifecycle.spec.ts` 整组 skip | `pnpm sync:dsh` + `node scripts/fetch-node.mjs`（均不入版本控制） |
| `api-key` | `pi-agent-*.spec.ts` 自动 skip（不耗额度） | 运行时注入 `OPENCODE_API_KEY`，绝不落盘 |
| `none` | 无 | — |

## 9. 相关修复与策略（2026-11-10）

**A3 · clipper flake 根因与修法**

连续 `--repeat-each=5` 复现 1 次，失败形态是 **MHTML 文件已存在但内容为空**（`Expected substring "MIME-Version"，Received ""`），不是「面板内容 20s 没等到」。根因：`webContents.savePage(target,'MHTML')` 先创建文件再写入，测试用 `existsSync` 命中后立即 `readFileSync`。

修法（`apps/desktop/tests/e2e/helpers/clipper.ts`）：

- 面板就绪 = `#root` 已挂载 + 标题可见 + 保存按钮可用（真实渲染信号，取代 20s 固定等待）；
- 保存结算 = 面板关闭或出现「已保存」提示（取代保存后固定 1.5s）；
- 文件落盘 = 轮询到内容满足格式断言（MHTML 含 `MIME-Version`、PDF >500B、PNG >100B），不再以「文件存在」为主判据。

验收：`playwright test tests/e2e/clipper.spec.ts --repeat-each=5` → **5 passed**。

**A4 · 内存回归线环境分线**

| 线 | 值 | 行为 |
| --- | --- | --- |
| 目标线（ADR-008） | 500MB | 超出仅 `console.warn`，不判红 |
| 回归线 · CI | 750MB | 超出失败 |
| 回归线 · 本机 | 800MB | 超出失败 |
| 覆盖口 | `URCHIN_PERF_BUDGET_MB` | 显式设置时优先 |

本机实测 707.7 / 711.0 / 715.9 / 740.2MB；CI 567.4MB。环境差约 150MB，已超过单线余量，故分线；**重校 500MB 目标线仍属产品决策**（ADR-019）。

## 10. 维护约定

1. 新增 / 删除 / 改名 spec → 同步改 `manifest.json`；`pnpm check:e2e-manifest` 会拦。
2. 调整触发路径 → 只改 manifest；本文表格随之更新（本表是投影，规则以 manifest 为准）。
3. 改耗时 → 可依据相关 spec 的 JSON reporter 实测更新 `durationSec` 与本表，无需为估时全量重跑。
4. 升级 vendor/genoffice 且未改 `package-lock.json` → CI 缓存需手动递增 key 版本（见 `ci.yml` 注释与打包核查清单）。
5. 选择器失效时由模型判断直接指定 spec、采用其他验证、跳过或全量；不触发强制回退。manifest 与 `check:e2e-manifest` 仍负责清单一致性。
