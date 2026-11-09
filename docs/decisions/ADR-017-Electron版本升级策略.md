# ADR-017 · Electron 版本升级策略与 43→45 迁移计划

> 状态：Accepted · 决策日：2026-11-09 · 关联决策：EL1（T1 的落地规则）
> 关联：[ADR-009 GenOffice 编辑器融合](./ADR-009-GenOffice编辑器融合.md) · [ADR-016 vendor/dsh 移出版本控制](./ADR-016-vendor-dsh移出版本控制.md) · [事实登记表 F12](../事实登记表.md) · [打包核查清单](../打包核查清单.md) · [03-技术栈 §1 T1](../03-技术栈.md#1-核心技术选型t1-t6)

---

## 1. 背景

`docs/03-技术栈 §1 T1` 的选型策略是「Electron 最新稳定版」，但此前没有任何**可执行的升级规则**：既没写清「什么时候必须升」，也没写清「升不动时怎么办」。2026-09-20 的 32.3.3 → 43.7.3 是一次性、事件驱动的跳跃（为对齐 GenOffice 上游），随后停在 `43.8.0` 未再跟进。

Electron 的维护策略是**只维护最新 3 个 stable major**（官方 Electron Releases 文档），且每 8 周发一个大版本；43 的 EOL 时间官方 breaking-changes（v44 条目）已明确为 **2027 年 1 月**。

对浏览器产品，父版本 EOL 意味着**不再接收 Chromium 安全补丁**——这与 AGENTS.md「项目声明一：生产级标准全程适用」直接冲突。因此本 ADR 把「跟随最新稳定版」落成一条可判定的规则，并给出 43 → 45 的分阶段迁移计划。

## 2. 版本事实（2026-11-09 实测）

| 项 | 值 | 来源 |
| --- | --- | --- |
| 项目当前 | `electron` **43.8.0**（Chromium 150.0.7871.250 / Node 24.22.0 / V8 15.0） | `apps/desktop/package.json` + `pnpm-lock.yaml` |
| 43 线最新补丁 | **43.8.7**（本轮升至此处） | npm dist-tag `43-x-y` |
| 最新 stable | **45.2.3**（Chromium 156.0.8078.80 / Node 24.22.2 / V8 15.6） | releases.electronjs.org |
| 上一条线 | 44.10.2（Chromium 152.0.7977.169 / Node 24.22.2） | 同上 |
| 下一版本 | 46（alpha.7 阶段，预计 2027-01 stable） | npm dist-tag `alpha` |
| 支持窗口 | 43 于 **2027-01**（46 stable）EOL；44 于 47 stable EOL；45 于 48 stable EOL | Electron Releases「Version support policy」 |

## 3. 决策

**EL1 · 升级规则（MUST）**：Electron 主版本落后不超过 2 个 major；**任何在支持窗口内的版本进入「窗口外」（即被第 4 个更新版本挤出）之前必须完成升级**。无法按期升级时，必须在 `CHANGELOG.md` 当行写明「阻塞：<原因>」并附预计决策日（落实 AGENTS.md §三 唯一真实缺口）。

**EL2 · 本次目标版本 = 45.2.3**。理由：45 是当前 latest，支持到 48 stable（约 2027-05），跨 2 个 major 的破坏面对本项目较小（见 §4.2）。**不选 44**：44 是承载剪贴板重写的那一版，支持窗口又最短（47 出来即 EOL），为过渡版本做两次适配不划算。**46 作为备选**：若上游阻塞拖到 2026-12 之后仍未解，则等到 46 stable 一次性跨完（此时 43 恰好 EOL，等价于踩线升级）。

**EL3 · 分阶段执行**：阶段 0（零 Electron 大版本风险，本轮已完成）→ 阶段 1（45 spike 量化破坏面）→ 阶段 2（按 spike 结果二选一落地）。

**EL4 · 阻塞登记**：GenOffice 上游（含最新 tag `v0.12.852`）仍 pin `electron ^43.8.3` 且使用 Electron 44 已移除的剪贴板同步 API，构成宿主升级的**硬阻塞**（证据见 §4.3）。解除方式只有两条：自己给 vendor 打补丁，或等上游适配后随 vendor 升级一起升。

## 4. 证据

### 4.1 我们自己的代码面（升 45 的改动量很小）

| 检查项 | 结论 |
| --- | --- |
| `clipboard`（自有代码） | 仅 2 处主进程 `writeText`（`clipper/register-handlers.ts`、`genoffice/home-handlers.ts`），44+ 变 Promise；阶段 0 已改显式 fire-and-forget |
| sandbox preload | 全仓仅 1 个 preload，且只用 `process.platform/versions`；45 移除 `events/timers/url` shim 与 `Buffer`/`setImmediate` **不受影响** |
| `net.request` / `contentTracing` / `getUserMedia` + `chromeMediaSource` / `select-client-certificate` | 均未使用（45 的相关收紧不命中） |
| `window.open` 子窗口沙箱化（45） | 所有窗口本就 `sandbox: true`，行为不变 |
| ASAR 文件描述符语义（45） | 原生模块只读 userData / resources 下的普通文件，不读 asar 内部 FD |
| 原生模块 ABI | `better-sqlite3@13`（包内 N-API 预编译）+ `node-pty@1.1.0`（`prebuilds/` N-API）与 Electron ABI 解耦 |
| dsh / pi-web | dsh 走便携 `node.exe v24.22.0`（与 Electron 解耦）；pi-web 走 `ELECTRON_RUN_AS_NODE`，Node 24.22.0 → 24.22.2 同 major |
| `safeStorage` | 45 弃用同步三件套、46 移除；**阶段 0 已完成异步化**（43 已提供 async API，且旧 .enc 可直接解密） |
| **ANGLE 静态链接（44）** | Windows GPU 栈变化，本项目有 `GR1` 三卡混合 / TDR 前科 → 属**不可预判项**，阶段 1 必须实测 |

### 4.2 为什么不选其他版本

- **44.10.2**：支持窗口最短，且正是剪贴板重写版本——该做的适配一样要做，却只换来 2 个月支持期。
- **46.x**：当前仍是 alpha；作为「12 月仍未解阻塞」时的备选（见 EL2）。
- **停着不动**：2027-01 后浏览器携带不再修补的 Chromium，违背项目声明一。

### 4.3 GenOffice 硬阻塞（关键证据）

Electron 44 的 breaking change「clipboard 模块按 W3C Clipboard API 重构」移除了 `readBuffer` / `writeBuffer` / `readImage` / `readHTML` / `writeBuffer` / `availableFormats` 等，并把 `readText` / `writeText` 改成 Promise、`write()` 改成接收 `ClipboardItem[]`。

`vendor/genoffice`（v0.12.446，**上游最新 v0.12.852 同样**）在 **main 进程**使用旧 API，且已被打进宿主实际加载的产物 `vendor/genoffice/apps/urchin-embed/out/main/index.js`（11.5 MB）：

| 产物行 | 调用 | 45 下的后果 |
| --- | --- | --- |
| 253068 | `clipboard.readBuffer(...)` | `undefined` → TypeError |
| 253076 | `clipboard.readHTML()` | `undefined` → TypeError |
| 253106 | `clipboard.write({ image, html })` | 参数契约变更 → 行为错误/异常 |
| 279414 | `clipboard.writeBuffer('io.genoffice.slides.slide', ...)` | `undefined` → TypeError |
| 280181 | `clipboard.readBuffer(format)` | `undefined` → TypeError |
| 280190 | `clipboard.readImage()` | `undefined` → TypeError |
| 280192 | `clipboard.readText()` | 返回 Promise，后续 `.trim()` 抛错 |
| 280199 | `clipboard.availableFormats()` | `undefined` → TypeError |
| 280216 | `clipboard.writeBuffer(ELEMENT_CLIPBOARD_FORMAT, ...)` | `undefined` → TypeError |

命中用户可见功能：**Slides 复制/粘贴幻灯片与元素、元素另存图片、文本右键剪贴板、Docs 复制图片到剪贴板**。
上游 `apps/shell/package.json` 仍 pin `electron ^43.8.3`，说明**上游尚未开始适配 44+**（2026-11-09 经 GitHub API 核实 tag `v0.12.852`）。

## 5. 阶段 0（本轮完成，不涉及 Electron 大版本）

| # | 内容 | 状态 |
| --- | --- | --- |
| 0-1 | `electron ^43.8.0 → ^43.8.7`；`@playwright/test → ^1.65.0`；`electron-builder → ^26.18.0` | ✅ |
| 0-2 | `safeStorage` 同步 → 异步（`ISafeStorage` 接口、适配器、`SecretStore`、3 个单测文件） | ✅ |
| 0-3 | 2 处 `clipboard.writeText` 改为显式 fire-and-forget（不依赖返回值） | ✅ |
| 0-4 | 本 ADR + 决策索引 + 03-技术栈 + 事实登记表 F12 + 打包核查清单 + CHANGELOG | ✅ |

## 6. 阶段 1 · 45 spike（待执行，落盘备查）

**分支**：`spike/electron-45`（不合并主干，验证完按结论落地）

**改动**：仅 `apps/desktop/package.json` 的 `electron` → `^45.2.3`（`@types/node` 如需随 Electron 45 的类型升级到 ^24 再评估）。

**命令**：
1. `pnpm install`
2. `pnpm verify`
3. `pnpm e2e`
4. genoffice 相关 e2e（按现有 genoffice spec 单跑）
5. `pnpm start` 手测 + `pnpm package:win`（按 [打包核查清单](../打包核查清单.md) §9 核对、§10 留痕）

**检查清单（逐项勾选）**：
- [ ] 六编辑器（docs / sheets / slides / pdf / markdown / html）打开、编辑、保存、另存、导出
- [ ] Slides 复制/粘贴幻灯片、复制/粘贴元素、元素另存图片（**预期失败点**）
- [ ] Docs 复制图片到剪贴板（**预期失败点**）
- [ ] 文本右键 / 系统剪贴板（`clipboard.writeText` / `readText` 语义变化）
- [ ] GPU：ANGLE 静态链接后是否复发 TDR（GR1 前科）、视频/滚动/GPU 进程状态
- [ ] pi-web（`ELECTRON_RUN_AS_NODE`）与 dsh（便携 node.exe）启动
- [ ] 截图 overlay / `desktopCapturer` / 状态栏悬浮窗 / 剪藏面板 / 邮件等 sandbox 窗口
- [ ] 主窗口、标签页、书签、历史、下载、设置、主题、工作区快照基本路径

**产出**：破坏清单 + 工作量估算，回填本 ADR §7 决策依据；未预期问题另起条目，不夹带修复。

## 7. 阶段 2 · 决策门禁与落地（待执行）

Spike 完成后按结果二选一：

- **A 路（自打补丁）**：若破坏面仅限 GenOffice 剪贴板 → 在 vendor 内把旧 API 换成 ClipboardItem 语义（约 9–12 处调用；`elementClipboardMarkerMatches`、`slides:clipboard-external`、`slides:clipboard-probe` 三条链路需转 async，`ipcMain.handle` 天然支持 Promise），登记到 `vendor/genoffice/VENDOR.md` 改动清单（上游每次升级需重放），随后升 45 并全量验收。
- **B 路（等上游）**：若上游在 2026-12 前把 shell 抬到 44+，则 vendor 升级与宿主升级一次做完，不维护本地补丁。

**门禁**：无论 A/B，**2027-01 前必须落到 44+**；否则按 EL1 在 CHANGELOG 记阻塞并评估 46 stable。

**验收信号**：`pnpm verify` + `pnpm e2e` + genoffice e2e 全绿；`pnpm package:win` 通过并在打包核查清单 §10 留痕；手测清单全部勾选。

## 8. 风险与回滚

| 风险 | 应对 |
| --- | --- |
| ANGLE 静态链接导致 GPU 回归 | spike 阶段实测；复发时按 GR1 预案（回退禁用硬件加速或 `--use-angle=d3d11`），并在 ADR 记录 |
| vendor 补丁与后续上游升级冲突 | 补丁集中在一个文件（适配层）+ VENDOR.md 登记；上游适配后立即删除本地补丁 |
| Playwright 1.65 与 Electron 45 组合未验证 | spike 中一并验证；失败则回退 Playwright 单独排查 |
| 升级后发现严重回归 | 回滚为「不合并 spike 分支」；主干始终留在受支持版本，绝不在未验收前合并 |
| 43 在 2027-01 前仍未升 | 按 EL1 记阻塞；紧急情况下先升 46 stable（一次跨完） |

## 9. 明确不在本次范围（后续独立议题）

1. `BrowserView → WebContentsView` 迁移：`BrowserView` 自 Electron 29 起 deprecated，仍可用但移除风险随版本上升；与版本升级叠加会放大回归面，本 ADR 仅登记。
2. `safeStorage` 密钥轮换（`decryptStringAsync` 的 `shouldReEncrypt`）：当前只取明文，未自动重加密；需要时在 `SecretStore` 读写路径补触发。
3. 打包体积：Electron 45 包体变化不设门槛，随 `docs/00-设计总览` 的包体预算评估一并处理。

## 10. 本节落地状态

- 2026-11-09：阶段 0 完成（43.8.7 + safeStorage 异步化 + clipboard 语义对齐 + 文档留痕）；阶段 1/2 待执行。
- 2026-11-09 打包回归：`pnpm package:win` 通过，产物 `0.3.0-dev.170`（exe 340.8 MB），日志 `electron=43.8.7` / `electron-builder version=26.18.0`；已记入[打包核查清单 §10](../打包核查清单.md#10-核对记录) 第 5 行。