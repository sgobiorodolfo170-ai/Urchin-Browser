# ADR-016 · vendor/deepseek-harness 移出版本控制（脚本化同步 + 三源版本门禁）

> 状态：Accepted · 决策日：2026-11-06 · 关联：[ADR-009](./ADR-009-GenOffice编辑器融合.md)（vendor 治理先例）、[调研报告 §7.2/§7.6](../DeepSeek-Harness-现状调研.md)（同步人工化 / 仓库重量）
> 影响范围：仓库形态 / dsh 开发态同步流程 / CI 友好性 / 版本治理
> 依据：用户决策（P2-13，2026-11-06 四选一方案 C「脚本拉取 + 移出版本控制」）

## 背景

`vendor/deepseek-harness` 是 DeepSeek 官方 dsh 应用的全量上游源码，以 **16,324 文件 / 约 127MB** 被完整提交进本仓库（占仓库三棵 vendor 树 tracked 内容的 67%）。实测关键事实：

| 事实 | 值 | 含义 |
| --- | --- | --- |
| 开发态消费 | tsx 直启 `apps/cli/src/bin.ts`，cwd=vendor（需 vendor 内独立 pnpm install，node_modules ~1.96GB 本就未入库） | 入库的只是源码，跑起来仍需额外步骤 |
| **打包态消费** | npm 依赖 `@deepseek-ai/dsh`（精确 pin）→ `app.asar.unpacked` | **完全不使用 vendor 树** |
| typecheck / lint / 单测 / E2E / CI | 不触碰 vendor 树（不在 pnpm workspace，无源码引用） | 入库对门禁链毫无贡献 |
| 版本 | vendor `0.2.1-rc.3` = 桌面依赖 = lockfile；上游已到 rc.5 | 三处必须一致，此前无机器校验（调研 §7.2） |
| 升级方式 | 整树替换 + 独立安装 + ~286s 构建 + lockfile 更新，人工照抄 CHANGELOG | 无脚本、无门禁 |

结论：这 127MB 只服务于开发态一种场景，且不完整；入库成本（clone / git status / 全仓搜索负担、每次 rc 升级的万级 diff、外部代码混入审查面）由所有场景分摊，收益却只有「离线源码可得」。

## 决策

1. **退出版本控制**：`git rm -r --cached vendor/deepseek-harness` + `.gitignore`。本地工作树保留，开发态在本次变更后立即可用；CI 与全新 clone 的门禁链不受影响（本就不消费它）。
2. **版本唯一真源** = `apps/desktop/package.json` 的依赖 `"@deepseek-ai/dsh"`（必须精确 pin，禁 `^`/`~`）。vendor 拉取与门禁都读它，杜绝三处手抄漂移。
3. **同步脚本化**：`scripts/fetch-dsh.mjs`（`pnpm sync:dsh`）——幂等。版本缺失/不符时 `git clone --depth 1 --branch dsh-v<版本>` 整树替换（Windows 深路径含 ~2GB node_modules 先清理），再按 vendor 自身 `packageManager`（pnpm@11.28.5，与本仓库 9.x 不兼容故经 npx 指定）执行 `install --no-frozen-lockfile`，成功后打安装戳。
4. **三源版本门禁**：`scripts/check-dsh-version.mjs`（`pnpm check:dsh`）接入 `pnpm verify`（硬门禁 **G17**）。校验 桌面依赖 = lockfile = vendor（vendor 缺失时该子项自动跳过——CI / 未同步环境没有 vendor 树属正常态）。

## 候选方案与否决理由

| 方案 | 否决/采纳理由 |
| --- | --- |
| A. 维持现状 | 开发便利保留，但 127MB/16.3k 文件负担 + 升级万级 diff + 三源人工同步全保留；三源盖无门禁属「待爆」状态 |
| **C. 脚本拉取 + 移出（采纳）** | 仓库 -127MB；5 步人工升级变 1 条命令（连调研 §7.2 一起根治）；出处 = 官方 tag，比我方仓库快照更精确；门禁可机器判定 |
| B. git submodule（pin 于 tag） | 同样解决重量与出处，但 Windows 体验一般（忘 update → 目录为空）、CI 需额外 checkout 配置；升级 = 换指针，与 C 等价，脚本口径下无额外收益 |
| D. 入库但裁剪（仅保留运行时目录） | `.agents/`（18.7MB/3,858 文件）疑似 dsh 运行时资源，删除有真机风险；裁剪后「上游 tag 干净整树替换」升级路径断裂，每次升级需重放裁剪——比 C 更复杂 |
| E. git LFS / 独立仓库 | LFS 不适合源码（按字节演进要重复加载历史）；独立仓库破坏 monorepo 单命令验证流 |

## 后果

### 正面
- 仓库直接瘦身：-127MB tracked / -16,324 文件；`git status` / 全仓 grep / IDE 索引不再背负外部代码
- 升级流程从「5 步人工照抄 runbook」变为 `package.json 改依赖版本 + pnpm sync:dsh`
- 三源不一致可被 `verify` 在最早时刻检测（dev/prod 行为分裂防患）
- 与 AGENTS §十一 计数口径一致化："需要维护者理解并重构的代码面"不再混入 16k 个外部文件

### 负面 / 风险与对策
- 新机器 / CI 之外的开发环境首次使用 dsh 需要联网执行一次 `pnpm sync:dsh`（不跑不影响浏览器其他全部功能）
- fetch-dsh.mjs 成为维护面：上游 tag 命名变化 / 镜像诉求经 `URCHIN_DSH_REPO` 环境变量覆盖；脚本自防御（clone 后校验版本）
- 上游资产（docs / snapshots / .agents 等）随整树不再入库——本就是「外部上游整树」语义，恢复方法同 sync:dsh

### 边界（本 ADR 不解决，仍为独立事项）
调研报告 §7.1 生命周期缺陷、§7.3 token 日志脱敏、rc.4/rc.5 升级评估、`apps/pi-web/server/dsh` 休眠代码处置、DSH 专属 ADR 缺口的其余治理项。

## 落地清单

- `scripts/fetch-dsh.mjs`（新增）：版本真源读取 + 幂等拉取 + 安装戳
- `scripts/check-dsh-version.mjs`（新增）：三源一致性检查 → 硬门禁 **G17**
- `package.json`：新增 `sync:dsh` / `check:dsh` 脚本；`verify` 链接入 `check:dsh`
- `.gitignore`：`vendor/deepseek-harness/`
- `git rm -r --cached vendor/deepseek-harness`（16,324 个 tracked 文件全部移出；本地保留）
- `apps/desktop/src/main/deepseek-harness/launcher.ts`：dev 态失败文案指向 `pnpm sync:dsh`（并修正「需 build」的不准确——dev 用 tsx 直启，无 build 步骤）
- `apps/desktop/src/main/bootstrap/handlers.ts`：开发态 vendor 缺失日志指向 `pnpm sync:dsh`
- AGENTS.md §九.4 G17 登记 + 工作流约定 verify 组成更新；决策索引 ADR 表补行
- `docs/事实登记表.md` 新增 F8（dsh 版本三源，代码即真源）
- `docs/DeepSeek-Harness-现状调研.md` 增补 P2-13 处置章节

## 升级 runbook（自本 ADR 起）

1. 改 `apps/desktop/package.json`：`"@deepseek-ai/dsh": "<新版本>"`（精确 pin）
2. 根目录 `pnpm install`（更新 lockfile ②）
3. `pnpm sync:dsh`（vendor 重建 → ③ 对齐）
4. `pnpm verify`（G17 三源一致 + 常规门禁）
5. 打包 `pnpm package:win` + 真机 dsh smoke（打包态闭包 = 新 npm 版本）
6. 评估 breaking change 时参考 [调研报告 §三](../DeepSeek-Harness-现状调研.md) 同步历史条目
