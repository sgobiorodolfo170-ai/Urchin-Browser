# dev193 DeepSeek Harness 无法创建新会话 —— 阶段一排查发现

- 记录时间：2026-11-12
- 排查范围：源码仓 + `apps/desktop/release-v24/win-unpacked` 构建产物（**尚未覆盖本机实际安装版**）
- 结论状态：**根因已实证确认并完成反证验证**；未执行任何整改，构建产物已还原原状
- 本文件用途：先落盘阶段一结论，供后续与「本机安装版 + 运行日志」探查结果合并为《修复整改方案》

---

## 1. 故障现象

当前发布的 `v0.3.0-dev.193`：DeepSeek Harness（dsh）可以打开、Web 服务能启动、认证 URL 正常输出、页面能加载，但**无法创建新会话**。

## 2. 结论速览

**这不是 dev193 打包改动引入的，而是 dsh 依赖树版本错配（peer 依赖解析到旧版），开发态同样中招。**

打包产物内 `@deepseek-ai/*` 存在两个版本：

| 版本 | 包数 | 代表包 |
| --- | --- | --- |
| `0.2.1-rc.3` | 273 | `dsh`、`dsh-llm-deepseek-api-key`、`dsh-llm-deepseek-account`、`dsh-web-app` |
| **`0.2.0-rc.2`** | **22** | **`dsh-llm-deepseek`、`dsh-session-title-llm`** |

`dsh-llm-deepseek-api-key@0.2.1-rc.3` 的 `peerDependencies` 明确要求 `@deepseek-ai/dsh-llm-deepseek: 0.2.1-rc.3`，但 pnpm 的 peer 符号链接指向了 `0.2.0-rc.2`。旧版缺少 rc.3 才有的具名导出，导致依赖它的插件全部激活失败 → 没有可用 DeepSeek 模型 provider → 创建会话必然失败。

## 3. 证据链

### 3.1 真实运行产物报错（决定性证据）

用随包的便携 Node 直接运行构建产物里的 dsh（非静态读代码）：

```
release-v24/win-unpacked/resources/node/node.exe \
  release-v24/win-unpacked/resources/app.asar.unpacked/node_modules/@deepseek-ai/dsh/lib/bin.js \
  web --no-open --port 19878
```

服务能起、认证 URL 正常输出、首页 HTTP 200，但 stderr 有 **6406 字节**报错：

```
dsh: warning: 3 entries did not activate

llm-deepseek          → SyntaxError: '@deepseek-ai/dsh-llm-deepseek'
                        does not provide an export named 'ModelListingCache'
llm-deepseek-account  → 同上（依赖同一个底层包）
session-title-llm     → '@deepseek-ai/dsh-session-title-llm'
                        does not provide an export named 'executeSessionTitleLlm'
```

前两个正是 DeepSeek LLM provider（API Key / 账号两种认证方式），是创建会话的必要条件。

### 3.2 版本错配

- 产物 `dsh-llm-deepseek/package.json` → `0.2.0-rc.2`，其 `lib/index.js` 中 `ModelListingCache` 出现 0 次。
- 产物 `dsh-session-title-llm/package.json` → `0.2.0-rc.2`，`executeSessionTitleLlm` 出现 0 次。
- `pnpm-lock.yaml` 第 12206 / 12218 / 12223 行把这两个插件的依赖锁到 `0.2.0-rc.2`。
- 根 `node_modules/.pnpm` 中**只有** `@deepseek-ai+dsh-llm-deepseek@0.2.0-rc.2_*` 实体，没有 rc.3 实体。
- peer 链接实证：
  ```
  .../dsh-llm-deepseek-api-key@0.2.1-rc.3_.../node_modules/@deepseek-ai/dsh-llm-deepseek
    → .../@deepseek-ai+dsh-llm-deepseek@0.2.0-rc.2_gwno.../node_modules/...
  ```
- npm registry 上 `@deepseek-ai/dsh-llm-deepseek@0.2.1-rc.3` 与 `@deepseek-ai/dsh-session-title-llm@0.2.1-rc.3` **确实存在**；解包后确认二者分别导出 `ModelListingCache` 与 `executeSessionTitleLlm`。
- 根 `package.json` 的 `pnpm.overrides` 中无 `@deepseek-ai` 相关项，已排除「overrides 压版本」这一可能。

### 3.3 生成 profile 的旁证

`DSH_HOME/profiles/web/` 下生成 `package.json`（bundle 为 `dsh-base` + `dsh-web-app`，`dependencies: {}`）、`pnpm-workspace.yaml`、`cordis.yml`。说明 dsh 卡在插件激活阶段，而非 profile bootstrap 缺文件。

## 4. 实证修复验证（临时覆盖 + 还原）

从 registry `npm pack` 拉取两个 rc.3 正版包，严格备份后**临时覆盖**构建产物里对应的 `lib/` 与 `package.json`，重跑 dsh：

| 指标 | 覆盖前 | 覆盖 rc.3 后 |
| --- | --- | --- |
| stderr 大小 | 6406 字节报错 | **0 字节** |
| `did not activate` 条目 | **3** | **0** |
| 认证 URL 输出 | 正常 | 正常 |
| 带 token 访问首页 | HTTP 200 | HTTP 200 |

**根因 100% 坐实**：只要把这两个底层包换成 rc.3，3 个插件全部激活，创建会话的前置条件恢复。

验证完成后：产物已按备份还原为 rc.2 原状、后台探测服务已停止、**未改动任何源码或配置**。

## 5. 已排除的假设

| 假设 | 排除依据 |
| --- | --- |
| dev193 新增 `dist/providers/**` 引起 | 那是 pi-web-host 的**内置 provider**（`openai-compatible.js`）部署，与 DSH 是两条独立链路，且 `aca08ace` 的修复确实已包含在 dev193 tag 内 |
| dev191/192 剪 `.ts` / `.md` 剪掉运行时资源 | dsh 发布包内几乎不带 `.md`（源 `node_modules/@deepseek-ai` 下仅 2 个 README），`dsh-web-app` 等 bundle 在产物中完整存在（15 文件） |
| `afterPack` 钩子缺失导致 peer-only 包漏打 | 钩子在 `apps/desktop/scripts/after-pack-dsh-peers.cjs`（此前误查了根目录 `scripts/`），dev193 tag 中存在且正常补齐 peer 包；`cordis-plugin-group` 在产物里齐全 |
| 缺 `dsh-web-app` / `dsh-base` bundle | 产物中均存在 |
| 打包平铺破坏 pnpm 版本隔离 | 产物保留了嵌套 `node_modules`，且 `pnpm-lock.yaml` 本身就锁到 rc.2 → **问题在安装态/依赖解析层，不是打包平铺层**；开发态同样中招 |

## 6. 为什么一路放行到 dev193

1. `scripts/package-win.mjs` 的 DSH 打包门禁只断言 3 个文件**存在**（`node.exe`、`bin.js`、`cordis-plugin-group`），**不校验版本一致性、不做启动冒烟、不检查 stderr**。
2. 2026-11-12 的 dev.191 工作日志已记录「dsh 冒烟……**仅既有 3 entries did not activate**」——错误当时就被看见了，但被当作「既有问题」放行，一路带到 dev.193。

## 7. 阶段一修复方案（待决策，本轮不执行）

1. **重新解析 dsh 依赖闭包**：删除 `pnpm-lock.yaml` 后重新生成，或 `pnpm install --force`，让 peer 依赖解析到 `0.2.1-rc.3`；若仍复用旧 peer 变体，在根 `package.json` 的 `pnpm.overrides` 中把那 22 个 `@deepseek-ai/*` 包显式 pin 到 `0.2.1-rc.3`。
2. `pnpm verify` → 重新 `package:win` 打包。
3. **门禁补两条硬校验**：
   - `@deepseek-ai/*` 版本单一性（同一版本族内不得混版）；
   - dsh web 启动冒烟，且 stderr 不得出现 `did not activate` / `does not provide an export named`。

## 8. 验收标准（阶段一部分）

- `app.asar.unpacked/node_modules/@deepseek-ai/*` 全部为 `0.2.1-rc.3`，无 `0.2.0-rc.2` 残留。
- 启动 dsh web，stderr 为 0 字节、`did not activate` 为 0。
- 安装版中创建新会话成功、模型列表可选、可正常发起对话。
- 打包门禁在版本错配时能直接失败（回归防护）。

## 9. 现场状态

- 构建产物 `release-v24/win-unpacked`：已还原为 rc.2 原状。
- 临时目录 `/tmp/dsh-probe-*`、`/tmp/dshfix`、`/tmp/dsh-backup-verify`：探测残留，未清理（不影响工程）。
- 源码、lockfile、配置：**均未改动**。
