# E2E 用例选择表

> 状态：已生效 · 建立：2026-11-10 · 决策：[ADR-018](./decisions/ADR-018-E2E按需选择.md)（按需选择）· [ADR-019](./decisions/ADR-019-内存回归线环境分线.md)（内存回归线）
> 单一真源：[`apps/desktop/tests/e2e/manifest.json`](../apps/desktop/tests/e2e/manifest.json) · 门禁：G20 `pnpm check:e2e-manifest` · 运行器：`scripts/e2e-select.mjs`

> **30 秒看懂**
> 1. 改完代码，AI 先跑 `pnpm e2e:select -- --dry-run --json`，算出「这次建议跑哪些」。
> 2. AI 在**聊天里**列出 spec 让你勾选（项目不弹窗、不建窗口）。
> 3. 你选完，AI 只跑你选的；想全量跑就 `pnpm e2e`。
> 4. 这套按需机制坏了/算不出来/你不在场 → 直接 `pnpm e2e` 回退，原方式永远可用。

---

## 1. 一句话规则

- **本地**：先算「这次改动建议跑哪些」→ AI 在**会话里**问你选哪些 → 只跑你选的。
- **全量只在这三种时候**：发布前收口、选择器算不出来、你明确要求全量。
- **CI 永远全量**：CI 里不允许有任何交互。
- **项目里不弹任何软件窗口**：选择发生在 AI 会话内（agent 的复选/问答工具），项目代码只负责算推荐和执行。

## 2. 谁负责什么

| 角色 | 负责 | 不负责 |
| --- | --- | --- |
| `scripts/e2e-select.mjs` | 读 git 改动、按 manifest 算推荐、打印表格 / 输出 JSON、执行指定 spec | **不弹窗**、不替用户做选择、不静默全量 |
| AI（agent） | 运行 `--dry-run --json`，把结果整理成会话内复选项，问用户，按选择执行 | 不自建 GUI 窗口、不默认全量 |
| 用户 | 勾选这次要跑的 spec（或选择全量 / 不跑） | — |
| CI | 永远 `pnpm e2e` 全量 | 不读 manifest、不弹窗、不询问 |

## 3. 标准流程（AI 必须按此执行）

1. **出推荐**：`pnpm e2e:select -- --dry-run --json`
2. **展示**：把推荐表给用户看，至少包含 `spec / 能力域 / 例数 / 耗时 / 依赖 / 为什么推荐`。
3. **会话内选择**（两步，用 agent 自己的复选/问答工具）：
   - 第一步问：`仅推荐（N 个 spec / M 例 / 约 X）` / `全量 23 spec / 38 例` / `自定义` / `这次不跑 E2E`
   - 只有选「自定义」时才进入第二步：逐条多选 spec。
4. **执行**：`pnpm e2e:select -- --specs=launch.spec.ts,clipper.spec.ts`
5. **收尾**：把「本次跑了哪些 spec、为什么」写进回复；失败就按常规排查。

> 会话内提问模板（可直接照抄）：
> 「这次改动推荐 8 个 spec / 12 例，预估 1m16s。要跑哪些？」
> 选项：仅推荐 / 全量 38 例 / 自定义 / 不跑。依赖警告（如缺 `OPENCODE_API_KEY`、缺 GenOffice 产物）必须一起说明。

## 4. 回退机制（方案失效时回到原方式）

**回退 = 直接跑全量，不需要改代码、不需要回滚提交。** 命令任选其一：

```bash
pnpm e2e                              # 原本的测试方式（CI 同款）
pnpm e2e:select -- --fallback         # 同上，带“回退”提示
```

以下任一情况**必须回退全量**，不要在“按需”上继续猜：

| 情况 | 处理 |
| --- | --- |
| 选择器脚本报错 / manifest 非法 / `check:e2e-manifest` 失败 | 直接 `pnpm e2e`；先修 manifest 再恢复按需 |
| 无改动、无匹配、改动涉及 IPC 契约等全局面 | 先问用户；用户不选或不确定 → `--fallback` |
| AI 会话内没有可用的选择工具 / 用户不在场 | `--fallback`（不允许静默挑几条就跑） |
| 发现推荐集合明显漏了相关 spec | `--fallback`，并把漏掉的触发路径补进 manifest |
| 用户明确要求“全部跑一遍” | `pnpm e2e` 或 `--fallback` |

> 回退不是失败：它只是“这次不用按需”。在回复里写清回退原因即可；如果是因为 manifest 漏项，顺手补上并跑 `pnpm check:e2e-manifest`。

## 5. 本地 / CI 分工与命令

| 环境 | 入口 | 范围 | 交互 |
| --- | --- | --- | --- |
| 本地（推荐） | `pnpm e2e:select -- --dry-run --json` → 会话内选择 → `--specs=...` | 推荐集合 | 会话内复选，无软件窗口 |
| 本地（只看） | `pnpm e2e:select -- --dry-run` | 只打印 | 无 |
| 本地（明确要求） | `pnpm e2e` 或 `pnpm e2e:select -- --fallback` | 全量 23 spec / 38 例 | 无 |
| CI | `pnpm e2e` | 全量 23 spec / 38 例 | **绝不交互** |

命令示例：

```bash
pnpm e2e:select -- --dry-run --json                          # 给 AI 组装选择项
pnpm e2e:select -- --dry-run --changed=apps/desktop/src/main/tabs/tab-manager.ts
pnpm e2e:select -- --specs=launch.spec.ts,clipper.spec.ts    # 执行用户勾选
pnpm e2e:select -- --list                                    # 列出 23 条
pnpm e2e:select -- --fallback                                # 回退：全量
pnpm check:e2e-manifest                                      # G20：manifest ↔ spec 双向一致
```

> `--json` 会输出 `{ mode, note, files, recommended, all, totalDurationSec, fallbackCommand }`，AI 直接把 `all` 映射成复选项即可。
> 直接运行 `pnpm e2e:select`（不带参数）只会打印推荐表并以退出码 3 结束，**不会弹窗、不会执行**——这是防止“静默挑几条就跑”的保护。

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
| `bookmark-folder-delete.spec.ts` | 收藏夹面板 | 2 | 6s | 无 | 是 | 命中即跑 | `main/bookmarks/**` · `main/panel/**` · `renderer/panel/**` |
| `bookmark-panel-visibility.spec.ts` | 收藏夹面板 | 1 | 6s | 无 | 是 | 命中即跑 | 收藏夹 + `main/status-bar/**` · `renderer/status-bar/**` |
| `clipper-mhtml-viewer.spec.ts` | 剪藏 | 1 | 5s | 无 | 是 | 命中即跑 | `main/clipper/**` · `main/files/**` · `main/protocol/**` · `renderer/files/**` |
| `clipper.spec.ts` | 剪藏 | 1 | 6s | 无 | 是 | 命中即跑 | 剪藏 + `main/status-bar/**` · `renderer/status-bar/**` · `renderer/omnibox/**` |
| `devtools-panel.spec.ts` | DevTools | 3 | 10s | 无 | 是 | 命中即跑 | `main/devtools/**` · `renderer/devtools/**` |
| `dsh-lifecycle.spec.ts` | DeepSeek Harness | 1 | 9s | **vendor-dsh** | **否（skip）** | 命中即跑 | `main/deepseek-harness/**` · `renderer/sidebar/**` · `main/tabs/**` · `scripts/fetch-dsh.mjs` · `scripts/fetch-node.mjs` |
| `genoffice-editors.spec.ts` | GenOffice | 5 | 15s | **genoffice-artifact** | 是（A1 后） | 命中即跑 | `main/genoffice/**` · `main/files/**` · `main/protocol/**` · `renderer/files/**` · `scripts/genoffice-build.mjs` |
| `genoffice-markdown.spec.ts` | GenOffice | 4 | 20s | **genoffice-artifact** | 是（A1 后） | 命中即跑 | 同上 |
| `homepage-memory-measure.spec.ts` | 标签与启动 | 1 | 17s | 无 | 是 | 命中即跑 | `renderer/home/**` · `main/tabs/**` · `renderer/sidebar/**` |
| `launch.spec.ts` | 标签与启动 | 4 | 10s | 无 | 是 | **始终（基线）** | 启动/标签/状态栏/omnibox/组件/preload 多路 glob |
| `notebook-layout-check.spec.ts` | 笔记 | 1 | 4s | 无 | 是 | 命中即跑 | `renderer/notebook/**` |
| `notebook-middle-drag.spec.ts` | 笔记 | 1 | 3s | 无 | 是 | 命中即跑 | `renderer/notebook/**` |
| `notebook.spec.ts` | 笔记 | 1 | 3s | 无 | 是 | 命中即跑 | `renderer/notebook/**` · `renderer/sidebar/**` · `main/settings/**` |
| `perf.spec.ts` | 性能 | 1 | 12s | 无 | 是 | 命中即跑 | `main/tabs/**` · `renderer/home/**` · `renderer/sidebar/**` · `renderer/components/**` |
| `pi-agent-build.spec.ts` | pi agent | 1 | ~300s | **api-key** | **否（skip）** | 命中即跑（需 key） | `packages/pi-web-host/src/pi-server/**` · `main/pi-web-host/**` · `tests/e2e/helpers/pi-agent-driver.ts` · `apps/pi-web/**` |
| `pi-agent-tetris.spec.ts` | pi agent | 1 | ~300s | **api-key** | **否（skip）** | 命中即跑（需 key） | 同上 |
| `pi-web-host.spec.ts` | pi 托管 | 2 | 9s | 无 | 是 | 命中即跑 | `main/pi-web-host/**` · `packages/pi-web-host/**` · `apps/pi-web/**` · `renderer/sidebar/**` · `scripts/build-pi-web.mjs` |
| `session-restore.spec.ts` | 标签与启动 | 1 | 5s | 无 | 是 | 命中即跑 | `main/tabs/**` · `main/workspaces/**` · `main/lifecycle/**` · `main/bootstrap/**` |
| `settings-page.spec.ts` | 设置 | 1 | 4s | 无 | 是 | 命中即跑 | `main/settings/**` · `renderer/settings/**` · `renderer/components/**` |
| `tab-close-activation.spec.ts` | 标签与启动 | 1 | 3s | 无 | 是 | 命中即跑 | `main/tabs/**` · `renderer/tabs/**` · `renderer/sidebar/**` |
| `tab-order-repro.spec.ts` | 标签与启动 | 1 | 8s | 无 | 是 | 命中即跑 | 同上 |
| `translate.spec.ts` | 翻译 | 1 | 3s | 无 | 是 | 命中即跑 | `main/translate/**` · `renderer/translate/**` · `main/status-bar/**` · `renderer/status-bar/**` |
| `workspaces.spec.ts` | 工作区 | 3 | 35s | 无 | 是 | 命中即跑 | `main/workspaces/**` · `renderer/workspaces/**` · `renderer/sidebar/**` · `main/tabs/**` |

> 路径前缀省略了 `apps/desktop/src/`；完整 glob 以 manifest 为准。`CI 真实执行 = 否` 表示该 spec 在 CI 会 **skip**（依赖不入版本控制或缺 key），而不是「CI 不运行它」。

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
3. 改耗时 → 重跑全量 JSON reporter 后更新 `durationSec` 与本表。
4. 升级 vendor/genoffice 且未改 `package-lock.json` → CI 缓存需手动递增 key 版本（见 `ci.yml` 注释与打包核查清单）。
5. 若按需方案整体失效（脚本长期不可用 / 团队决定停用）→ 回退到 `pnpm e2e` 全量即可；manifest 与 `check:e2e-manifest` 可保留（不参与测试执行），不会阻塞原方式。