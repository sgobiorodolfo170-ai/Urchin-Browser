# DeepSeek Harness（dsh）在本项目的现状调研

> 状态：调研完成，备查 · 调研日期：2026-10-30
> 范围：`vendor/deepseek-harness`、`apps/desktop/src/main/deepseek-harness`、`apps/pi-web` 中的 DSH 残留、构建与打包链路
> 方法：静态源码阅读 + 构建/打包产物核查 + npm registry / GitHub tag 查询。除特别标注外，未做真实 Electron 运行时验证；涉及运行行为的结论均标注「静态分析」。
> 关联：[03-技术栈](./03-技术栈.md) §3、[pi-web-评估](./pi-web-评估.md)、[pi-web-host-对接实施清单](./pi-web-host-对接实施清单.md) §3-5、`CHANGELOG.md` 的 dev.118 / dev.123
> 维护提示：本文是 2026-10-30 的快照，版本以 `package.json` / `pnpm-lock.yaml` 为准，体积为本次实测值；代码行号会随迭代漂移，引用前先复核。

---

## 一、结论摘要

- DSH 当前是**独立官方 Web 应用 + 浏览器标签页**式集成，不是自研 AI 助手（pi-web-host）的内置引擎。桌面启动器 `apps/desktop/src/main/deepseek-harness/` 是唯一活跃路径。
- 版本三处一致：vendor 源码、桌面 npm 依赖、lockfile 均为 `@deepseek-ai/dsh@0.2.1-rc.3`。但上游 npm latest 已是 `0.2.1-rc.5`，且 `dsh-v0.2.1-rc.4` / `rc.5` 的 GitHub tag 均已存在，项目落后 2 个 rc。
- 开发态与打包态两条启动链路均已落地；打包产物中确认存在 `dsh-base`、`dsh-app-boot`、`dsh/lib/bin.js`。
- 发现一个**疑似高优先级生命周期缺陷（静态分析）**：dsh 认证 URL 会 303 重定向为不带 token 的干净 URL，而项目用完整 token URL 做 `startsWith` 匹配，可能导致：
  - 关闭 DSH 标签不会停止后端；
  - 再次点击 DSH 入口不会激活/关闭已有标签，而是新开重复标签；
  - DSH 页面打开的衍生标签图标钉定失效。
- 另有版本同步人工化、休眠 DSH 引擎代码、无 DSH E2E、token 写入日志、包体膨胀、缺少 DSH 专属 ADR/文档等问题，详见 §七。

---

## 二、活跃集成架构

### 2.1 启动链路

入口是左侧栏底部的 DSH 图标（`apps/desktop/src/renderer/App.tsx:2254`），点击后：

```text
Renderer handleOpenDeepSeekHarness
  -> IPC deepseekHarness.status / launch
  -> DshLauncher 启动 dsh web 子进程
  -> 捕获 stdout 中的 http://127.0.0.1:<port>/?token=<43chars>
  -> tab.create 打开官方 DSH Web UI
```

关键实现：

| 环节 | 位置 | 说明 |
| --- | --- | --- |
| 启动器 | `apps/desktop/src/main/deepseek-harness/launcher.ts` | 随机空闲端口；`--no-open` 禁止拉起系统浏览器；120s 启动超时 |
| IPC 注册 | `apps/desktop/src/main/deepseek-harness/register-handlers.ts` | `launch` 通道覆盖 180s 超时，须大于启动上限 120s |
| IPC 契约 | `packages/ipc-contract/src/schemas/ipc-schema.ts:1401-1451`、`:2468-2476` | `deepseekHarness.launch/status/stop` 的 zod schema |
| 主进程接线 | `apps/desktop/src/main/index.ts:912-974` | 按 `app.isPackaged` 选择开发态/打包态 |
| 退出清理 | `apps/desktop/src/main/index.ts:2284-2294` | 解绑标签监听并 `dshLauncher.dispose()` |
| favicon 重定向 | `apps/desktop/src/main/index.ts:2035-2056` | 按端口匹配，重定向到 `urchin://dsh-icon/` |
| 标签关闭停止 | `apps/desktop/src/main/deepseek-harness/tab-lifecycle.ts` | 监听 `tabManager` 的 `removed` 事件，按 URL 前缀匹配后 `stop()` |

### 2.2 运行时分双态

| 场景 | 运行时 | CLI 入口 | 环境 |
| --- | --- | --- | --- |
| 开发态 | `apps/desktop/build/node/node.exe`（v24.22.0，约 94MB）+ tsx ESM | `vendor/deepseek-harness/apps/cli/src/bin.ts` | `cwd=vendor/deepseek-harness`，`DSH_HOME=userData/deepseek-harness` |
| 打包态 | `resources/node/node.exe`（便携 Node） | `app.asar.unpacked/@deepseek-ai/dsh/lib/bin.js` | 无 tsx，无 `ELECTRON_RUN_AS_NODE` |

为什么不能用 Electron 内置 Node：dsh 依赖 `node-addon-require-builtin` 校验运行时指纹，实测拒绝 Electron V8（`launcher.ts:17-22`）。因此随包附带便携 Node，`scripts/fetch-node.mjs` 负责下载与校验，`package:win` 链路会强制包含该文件。

### 2.3 认证与数据

- dsh web 每次启动生成 32 字节随机 token，附加在 URL 的 `?token=` 参数（43 字符 base64url）。
- 首次访问 token URL 后，服务端签发 30 天签名 cookie，并 **303 重定向到 `./`**（`vendor/deepseek-harness/packages/client/connection/src/browser-auth.ts:251-286`）。
- 不存在 `--no-auth` 旗标或环境变量；只能捕获 stdout 中的完整认证 URL。
- 数据目录由 `DSH_HOME` 决定，指向 `userData/deepseek-harness`。
- DSH 凭据与 Urchin AI 设置**相互独立**：启动器不注入 Provider/API Key，用户需在 DSH 自己的 UI 中配置。这带来账号/数据隔离，但也意味着用户要重复配置一次。

### 2.4 生命周期设计

- 设计意图：关闭 DSH 前端标签即停止后端（`tab-lifecycle.ts` 文件头注释），与 pi-web「启动器标签保留、关网页不停后端」不同。
- App 退出时统一 `dispose()`，这条路径不受标签关闭缺陷影响。
- `launch()` 幂等：并发调用复用同一次启动；单实例后端可被多个标签共享（若出现重复标签）。

---

## 三、版本与上游同步

| 项 | 本次核查值 |
| --- | --- |
| vendor 源码 | `0.2.1-rc.3`（GitHub tag `dsh-v0.2.1-rc.3`，commit `1f81c04`） |
| 桌面 npm 依赖 | `@deepseek-ai/dsh: 0.2.1-rc.3`（精确 pin，`apps/desktop/package.json:26`） |
| lockfile | `@deepseek-ai/dsh@0.2.1-rc.3` |
| 上游 npm latest | `0.2.1-rc.5`（同 `next` 标签） |
| 上游 Git tags | `dsh-v0.2.1-rc.4`、`dsh-v0.2.1-rc.5` 均已存在 |
| 本地 tracked patch | 无（`git diff` 干净） |
| vendor packageManager | `pnpm@11.28.5`（根仓库使用 `pnpm@9.12.0`，vendor 独立安装） |

同步历史：

- dev.118：`0.2.0-rc.2 -> 0.2.1-rc.2`，整树替换 + 依赖安装 + 完整构建（`CHANGELOG.md:129`）。
- dev.123：`0.2.1-rc.2 -> 0.2.1-rc.3`，整树替换 + 构建 + 根依赖/lockfile 更新（`CHANGELOG.md:137`）。
- dev.123 当时记录「rc.4 已发布但 GitHub 尚无 tag，无法干净同步」；该结论在 2026-10-30 已不成立，rc.4/rc.5 tag 均可拉取。

同步成本：

1. `git clone --depth 1 --branch <tag>` 整树替换 `vendor/deepseek-harness`（Windows 深路径先清理 node_modules）。
2. 在 vendor 内 `npx pnpm@11.28.5 install --no-frozen-lockfile`。
3. 在 vendor 内 `pnpm run build`（dev.123 实测约 286s）。
4. 更新 `apps/desktop/package.json` 精确版本 + 根 `pnpm-lock.yaml`。
5. 跑 `pnpm verify`、打包、真机 smoke。

目前**没有**一键脚本或版本漂移门禁覆盖这条流程，依赖人工照抄历史条目。

---

## 四、打包与体积

| 指标 | 实测值（2026-10-30，本机） |
| --- | --- |
| `vendor/deepseek-harness` git tracked | 16,324 文件 / 约 126.9MB |
| vendor 本地磁盘 | 约 2.27GB（其中 `node_modules` 约 1.96GB） |
| 打包 `app.asar.unpacked` | 约 1.79GB |
| 其中 `@deepseek-ai` | 约 1.11GB（270 个包） |
| `app.asar` | 约 32MB |
| `release-v24` 安装包 | `Urchin-Browser-0.2.0-x64.exe` 约 618.7MB |
| 便携 Node | `node.exe` 93,882,184 字节（约 89.5MiB） |

`app.asar` 不大，但 `asarUnpack: '**/node_modules/**'`（`apps/desktop/electron-builder.yml:135-136`）把整个 `node_modules` 解包，DSH 依赖闭包是主要贡献者之一。`@deepseek-ai` 一项就占 unpacked 的约 62%。

打包链路关键点：

- `apps/desktop/package.json` 的 `package:win` 会依次执行 `build:main`、`build:preload`、`build:renderer`、`build:pi-web`、`genoffice-build.mjs`、`fetch-node.mjs`、`clean-release.mjs`、`package-win.mjs`。
- `electron-builder.yml` 将 `build/node/node.exe` 放入 `resources/node/node.exe`；缺失时打包直接失败（有意门禁）。
- `scripts/package-win.mjs` 把包管理器伪装为 `traversal`，规避 electron-builder 在 pnpm 深依赖树上的指数膨胀（该问题由 dsh 闭包触发，见 dev.110 记录）。
- 已核查 `release-v24/win-unpacked/resources/app.asar.unpacked/@deepseek-ai/`：`dsh/lib/bin.js`、`dsh-base/cordis.patch.yml`、`dsh-app-boot/lib/index.js` 均存在，说明打包布局可用。

---

## 五、休眠的 DSH 引擎代码（未接入）

`apps/pi-web/server/dsh/` 存在一套完整的 DSH 引擎适配：

- `dsh-agent-service.ts`（约 260KB）— AgentService 等价物；
- `dsh-client.ts` — stdio JSON-RPC 2.0 客户端；
- `dsh-sessions.ts` — JSONL 会话只读访问；
- `dsh-serialize.ts` — DSH 事件到 pi-web-ui 协议；
- `dsh-market-service.ts`、`preset-clones.ts`、`dsh-usage.ts`；
- `runtime/` — `launcher.mjs`、`goal-rpc.mjs`、`override.patch.yml` 等。

但该目录当前**不参与 Urchin 构建**：

- `scripts/build-pi-web.mjs` 只打包 `packages/pi-web-host/src/entry.ts`；`apps/pi-web` 侧只构建 Vite 前端。
- `apps/pi-web/tsconfig.json` 仅把 `server/protocol.ts` 纳入类型检查，`server/dsh/*` 不在其中。
- 根/桌面 `node_modules` 中都没有 `@deepseek-ai/dsh-sdk-jsonrpc-server`；该路径若要运行，需要全局安装或显式注入运行时树。
- 代码注释与回退值仍停留在旧版本：`dsh 0.1.1-rc.2`（`dsh-client.ts` / `dsh-sessions.ts` 文件头），`runtime-root.mjs` 的 `FALLBACK_DSH_VERSION` 为 `0.2.1-rc.2`。
- `apps/pi-web/src/host-bridge.ts:375-385` 固定上报 `engine: 'pi'`、`engines: []`；`packages/pi-web-host` 源码中没有 engine 概念。
- [pi-web-host-对接实施清单](./pi-web-host-对接实施清单.md) §3-5 已明确标注「DSH 引擎桥接：后端缺失」。
- AOCI 索引中没有 `apps/pi-web/server/dsh/*` 或 `packages/pi-web-host` 条目。

结论：这是从上游 pi-web-ui 继承、尚未接入 Urchin 阶段 2 的代码，与桌面启动器是两条互不相关的 DSH 路径。保留会造成「看起来已接入」的误导和维护负担。

---

## 六、测试覆盖

当前 DSH 相关自动化测试：

- `apps/desktop/tests/unit/deepseek-harness-launcher.test.ts`：6 条，覆盖双态命令形状、分块 token 解析、子进程即退、启动超时。
- `apps/desktop/tests/unit/deepseek-harness-register-handlers.test.ts`：5 条，覆盖 180s 超时、成功、失败装箱、status、stop/dispose。

缺口：

- 没有 `tab-lifecycle.ts` 的单元测试（`bindTabCloseToStop` 的 URL 前缀匹配逻辑完全未被测试）。
- 没有 DSH E2E；没有打包产物启动 smoke。
- CI 的 `pnpm e2e` 不触达 DSH 启动、重定向、关闭全链路。
- 因此 §7.1 的生命周期缺陷没有任何自动化保护。

---

## 七、问题清单

### 7.1 疑似高优先级缺陷：token URL 重定向导致前缀匹配失效（静态分析）

**证据链**：

1. dsh 服务端收到有效 token 后返回 303，`location: './'`
   （`vendor/deepseek-harness/packages/client/connection/src/browser-auth.ts:251-286`）。
2. Electron 标签最终 URL 变成 `http://127.0.0.1:<port>/`，`did-navigate` 会把 `tab.url` 更新为最终 URL
   （`apps/desktop/src/main/tabs/tab-manager.ts:588-594`）。
3. 但以下三处仍用「带 token 的完整 URL」做前缀匹配：
   - `apps/desktop/src/main/deepseek-harness/tab-lifecycle.ts:43`
     `snapshot.url.startsWith(status.url)` -> 干净 URL 不以 token URL 开头 -> 关闭标签不会 `stop()`。
   - `apps/desktop/src/renderer/App.tsx:1184`
     `tabs.find((t) => t.url?.startsWith(dshUrl))` -> 找不到已打开标签 -> 再次点击会新开重复标签，而不是激活/关闭。
   - `apps/desktop/src/main/index.ts:1019-1025`
     `sourceUrl.startsWith(dshUrl)` -> DSH 页面 `window.open` 出来的标签无法命中 pinner，图标钉定失效。

**影响**：

- 违反设计语义「关闭 web 前端即关闭 deepseek-harness 项目」；后端会一直运行到 App 退出。
- 用户可能累积多个 DSH 标签，共享同一个后端。
- token 仍有效（进程级常量 + 30 天 cookie），关闭标签后本地服务继续暴露在 loopback 上，与用户预期不符。
- favicon 端口重定向不受影响；受影响的是标签身份匹配与图标钉定。

**验证建议**（需要真实运行）：

1. 启动应用并点击 DSH 入口，确认重定向后地址栏 URL 是否已无 `?token=`。
2. 关闭该标签，查询 `deepseekHarness.status` 或观察进程是否仍存活。
3. 在服务运行且标签已打开时再次点击 DSH 图标，观察是否新开标签。
4. 若复现，修复方向：按 `origin`/端口比较，或把 launcher 暴露的 `url` 归一化为干净入口 URL，并补 `tab-lifecycle` 单测 + E2E。

> 本节为静态分析结论，尚未在真实 Electron 实例中复现；优先级判断基于代码路径与 dsh 认证实现。

### 7.2 高：版本落后且同步流程人工化

- 项目 rc.3，上游 rc.5；rc.4/rc.5 tag 已可用。
- 每次升级涉及整树替换、独立 pnpm 安装、完整构建、根依赖/lockfile 更新、打包验证，缺少 runbook 和版本漂移门禁。
- 建议：先评估 rc.4/rc.5 的 breaking change，再把同步步骤脚本化，并在 `check:docs` 或 CI 增加「vendor 版本 == 桌面依赖版本 == lockfile 版本」校验。

### 7.3 中高：bearer token 写入日志

- `apps/desktop/src/main/deepseek-harness/launcher.ts:368`
  `log.info('dsh web ready', { port, url: resolvedUrl, pid })` 记录完整 token URL。
- `apps/desktop/src/main/tabs/register-handlers.ts:57`
  `tab.create` 的 INFO 日志记录完整 URL（含 token）。
- token 可换取 30 天 cookie，属于凭据；当前实现违反 AGENTS §六「日志不得含凭据」。
- 建议：日志只记录 origin/port，或对 `token` 参数打码；`tab.create` 对 `127.0.0.1` 的带 token URL 做脱敏。

### 7.4 中：休眠代码与文档漂移

- `apps/pi-web/server/dsh` 未构建、未类型检查、未接入 host，AOCI 未覆盖。
- 旧版本契约（0.1.1-rc.2 / 0.2.1-rc.2）散落在注释与 FALLBACK 中。
- 建议二选一：删除/归档该目录，或按《新模块接入约束声明》走 ADR 后正式桥接到 pi-web-host。中间状态最危险。

### 7.5 中：模块治理与文档缺口

- 没有 DSH 专属 ADR；决策只散落在 CHANGELOG dev.118/123。
- `docs/04-模块全景`、`docs/05-路线图` 未收录 DSH；`docs/03-技术栈` 仅目录树两行（`:52`、`:113`）。
- `docs/事实登记表` 未登记 DSH 版本事实，存在文档漂移风险。
- 项目声明要求新模块走 ADR + 门禁；DSH 目前未完全满足。
- 建议：补一份 DSH ADR（集成形态、运行时、数据隔离、更新策略、安全边界），并在模块全景和事实登记表登记。

### 7.6 中：包体与仓库重量

- vendor tracked 126.9MB / 16,324 文件；本地 2.27GB。
- 打包 unpacked 1.79GB，`@deepseek-ai` 1.11GB；安装包 618.7MB。
- 建议：量化 DSH 对 unpacked 的贡献，评估收窄 `asarUnpack`、裁剪包内 docs/tests/source map，或改为按需下载运行时。

### 7.7 低：无模块级更新路径

- 安装版 DSH 版本在构建期固定，运行期无更新入口；M20 只能整包更新。
- CHANGELOG dev.123 已记录该限制，模块级更新属于新功能，需 ADR + 门禁。

### 7.8 低：测试缺口

- 无 `tab-lifecycle` 单测、无 DSH E2E、无打包 smoke。
- 这是 7.1 未被发现并拦截的直接原因。

---

## 八、建议处理顺序

1. **复现并修复 7.1**：统一按 origin/port 匹配，补 `tab-lifecycle` 单测与 DSH E2E（启动 -> 重定向 -> 关闭 -> 确认进程退出）。
2. **评估 rc.4/rc.5 升级**：核对 breaking change，形成可复用的 vendor 同步脚本与版本一致性门禁。
3. **处置休眠代码**：删除/归档 `apps/pi-web/server/dsh`，或按 ADR 正式接入 pi-web-host。
4. **日志脱敏**：移除 launcher 与 `tab.create` 中的完整 token URL。
5. **补治理文档**：DSH ADR、模块说明、版本事实登记，纳入模块全景/路线图。
6. **体积审计**：量化 DSH 对打包产物的贡献，评估 asarUnpack 收窄与资源裁剪。

---

## 九、核查命令与原始数据

本次调研使用的可复现命令（在仓库根执行）：

```powershell
# 上游版本与 tag
npm view @deepseek-ai/dsh version dist-tags --json
git ls-remote --tags https://github.com/deepseek-ai/deepseek-harness.git "refs/tags/dsh-v0.2.1-rc.*"

# vendor 跟踪规模
git ls-files vendor/deepseek-harness | Measure-Object -Line

# vendor 本地体积（含 node_modules）
(Get-ChildItem "vendor\deepseek-harness" -Recurse -File -ErrorAction SilentlyContinue |
  Measure-Object Length -Sum).Sum / 1MB

# 打包产物体积
(Get-ChildItem "apps\desktop\release-v24\win-unpacked\resources\app.asar.unpacked" -Recurse -File |
  Measure-Object Length -Sum).Sum / 1MB

# 打包内 DSH 依赖规模
(Get-ChildItem "apps\desktop\release-v24\win-unpacked\resources\app.asar.unpacked\node_modules\@deepseek-ai" -Recurse -File |
  Measure-Object Length -Sum).Sum / 1MB
```

关键事实：

- `vendor/deepseek-harness/package.json` 版本 `0.2.1-rc.3`。
- `apps/desktop/package.json` 依赖 `"@deepseek-ai/dsh": "0.2.1-rc.3"`。
- `pnpm-lock.yaml` 中 `@deepseek-ai/dsh@0.2.1-rc.3`。
- 打包产物包含 `resources/node/node.exe`、`app.asar.unpacked/@deepseek-ai/dsh/lib/bin.js`、`dsh-base`、`dsh-app-boot`。
- `apps/desktop/tests/e2e/` 下没有 DSH 相关 spec。

---

## 十、后续维护约定

- 升级 DSH 时，同步更新本文的版本、体积、上游 latest/tag 三项；若问题状态变化，更新 §七。
- 本文不复制 AGENTS / 技术栈中的规范事实；覆盖率、命令、卡点等以对应真源为准（见 [事实登记表](./事实登记表.md)）。
- 7.1 修复后，应把「按 origin 匹配」写入 `tab-lifecycle` 测试名，避免回归。
