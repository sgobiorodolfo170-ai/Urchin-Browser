# E2E 用例选择表

> 状态：已生效 · 建立：2026-11-10 · 决策：[ADR-018](./decisions/ADR-018-E2E按需选择.md)（按需选择）· [ADR-019](./decisions/ADR-019-内存回归线环境分线.md)（内存回归线）
> 单一真源：[`apps/desktop/tests/e2e/manifest.json`](../apps/desktop/tests/e2e/manifest.json) · 门禁：G20 `pnpm check:e2e-manifest` · 运行器：`scripts/e2e-select.mjs`

---

## 1. 运行规则（MUST）

1. **AI 不得默认全量跑 E2E。** 任何改动完成后，必须先运行 `pnpm e2e:select`：出推荐表 → 给出建议与依赖警告 → **由用户勾选决定跑哪些**。
2. **全量仅限三种情况**：
   - 发布前收口；
   - 选择器无法判定（无改动 / 无匹配 / 改动涉及 IPC 契约等全局面）；
   - 用户明确要求全量。
3. **非交互环境不允许静默弹窗、也不允许静默全量**：无 TTY / CI 时只打印推荐表并以退出码 3 结束，必须显式 `--all` 或 `--specs=...`。
4. **CI 仍全量**：CI 永远执行 `pnpm e2e`（23 spec / 38 例），不读 manifest、不弹窗。manifest 只服务本地选择与预估。
5. **选择器判定不了就诚实全量**：宁可多跑，不接受「因为没匹配所以算了」。

## 2. 本地 / CI 分工

| 环境 | 入口 | 范围 | 弹窗 |
| --- | --- | --- | --- |
| 本地（默认） | `pnpm e2e:select` | 推荐集合，用户勾选 | 有（WinForms 复选清单） |
| 本地（dry-run） | `pnpm e2e:select -- --dry-run` | 只打印 | 无 |
| 本地（明确要求） | `pnpm e2e` 或 `pnpm e2e:select -- --all` | 全量 23 spec / 38 例 | 无 |
| CI | `pnpm e2e` | 全量 23 spec / 38 例 | **绝不弹窗** |

命令示例：

```bash
pnpm e2e:select                                             # 采集改动 → 弹窗勾选 → 运行
pnpm e2e:select -- --dry-run --changed=apps/desktop/src/main/tabs/tab-manager.ts
pnpm e2e:select -- --specs=launch.spec.ts,clipper.spec.ts
pnpm e2e:select -- --list                                   # 列出 23 条
pnpm e2e:select -- --interactive                            # 无 TTY 时强制弹窗（人工验收）
pnpm check:e2e-manifest                                     # G20：manifest ↔ spec 双向一致
```

> PowerShell 直接调用 pnpm 时不要加 `--` 之外的壳参数；`--` 之后的参数会原样传给 `node scripts/e2e-select.mjs`。

## 3. 2026-11-10 本机基线

| 项 | 值 |
| --- | --- |
| spec 文件 / 用例 | **23 / 38** |
| 本机全量（2026-11-10，JSON reporter 合计） | **36 passed / 2 skipped / 3.4 min**（另一次 2.8 min） |
| CI 最近真实执行（run 42770786468，dev.177 / 66a4fb7） | 26 passed / 12 skipped / 1.8 min |
| CI 12 skip 构成 | GenOffice 9（缺嵌入产物）+ pi-agent 2（缺 key）+ dsh 1（缺 vendor/便携 node） |
| A1 补齐 GenOffice 后 CI 目标 | **35 passed / 3 skipped**（仅剩 pi-agent×2 + dsh×1） |

耗时口径：单 spec 用例时长之和（含 Electron 启动开销），来自 `playwright test --reporter=json`；用于「预估」，不作为性能门槛。

## 4. 用例表

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
| `workspaces.spec.ts` | 工作区 | 2 | 12s | 无 | 是 | 命中即跑 | `main/workspaces/**` · `renderer/workspaces/**` · `renderer/sidebar/**` · `main/tabs/**` |

> 路径前缀省略了 `apps/desktop/src/`；完整 glob 以 manifest 为准。`CI 真实执行 = 否` 表示该 spec 在 CI 会 **skip**（依赖不入版本控制或缺 key），而不是「CI 不运行它」。

## 5. 依赖与跳过说明

| 依赖 | 缺失时的行为 | 补齐方式 |
| --- | --- | --- |
| `genoffice-artifact` | `genoffice-*.spec.ts` 整组 `test.skip` | `pnpm genoffice:build`；CI 由 A1 步骤构建并缓存 |
| `vendor-dsh` | `dsh-lifecycle.spec.ts` 整组 skip | `pnpm sync:dsh` + `node scripts/fetch-node.mjs`（均不入版本控制） |
| `api-key` | `pi-agent-*.spec.ts` 自动 skip（不耗额度） | 运行时注入 `OPENCODE_API_KEY`，绝不落盘 |
| `none` | 无 | — |

## 6. 相关修复与策略（2026-11-10）

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

## 7. 维护约定

1. 新增 / 删除 / 改名 spec → 同步改 `manifest.json`；`pnpm check:e2e-manifest` 会拦。
2. 调整触发路径 → 只改 manifest；本文表格随之更新（本表是投影，规则以 manifest 为准）。
3. 改耗时 → 重跑全量 JSON reporter 后更新 `durationSec` 与本表。
4. 升级 vendor/genoffice 且未改 `package-lock.json` → CI 缓存需手动递增 key 版本（见 `ci.yml` 注释与打包核查清单）。