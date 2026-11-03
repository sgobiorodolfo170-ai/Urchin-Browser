# 构建与打包完整度审计报告

- 日期：2026-11-03
- 触发：用户指令「检查项目的构建与打包完整度，确认构建流程可正常完成、打包产物齐全且无缺失文件或依赖，并指出构建、打包过程中出现的错误、警告及潜在问题，给出必要的修复建议，并进行修复」
- 版本：0.3.0-dev.144（dev 通道）
- 审计人：Agent

## 1. 审计范围

| 环节 | 命令 | 产物目录 |
|------|------|----------|
| 构建 | `pnpm build` | `apps/desktop/dist/{main,preload,renderer,pi-web}` + `dist/main/pi-web-host.js` |
| GenOffice 嵌入构建 | `node scripts/genoffice-build.mjs` | `vendor/genoffice/apps/*/out/` + `vendor/genoffice/THIRD-PARTY-NOTICES.txt` |
| 打包 | `node scripts/package-win.mjs`（electron-builder） | `apps/desktop/release-v24/` |

## 2. 发现的问题

### 2.1 [已修复] THIRD-PARTY-NOTICES.txt 缺失（P0）

**现象**：打包日志两次出现 `file source doesn't exist from=...THIRD-PARTY-NOTICES.txt`；win-unpacked/resources/genoffice/ 下缺少该文件。

**根因**：`scripts/genoffice-build.mjs` 既未调用 `npm run notices` 生成该文件，也未将 `apps/shell/build/THIRD-PARTY-NOTICES.txt`（`tools/gen-third-party-notices.mjs` 的实际输出路径）复制到 `vendor/genoffice/THIRD-PARTY-NOTICES.txt`（`electron-builder.yml` extraResources 声明的源路径）。electron-builder.yml 注释虽提到「由 vendor `npm run notices` 生成后复制到 vendor 根」，但该复制步骤此前从未在自动化流程中执行。

**影响**：Apache-2.0 NOTICE 传播合规缺口——安装包未携带第三方许可声明文件。

**修复**：`scripts/genoffice-build.mjs` 新增 3.6 步骤（`npm run notices` + `copyFileSync` 到 vendor 根），并将该文件加入产物校验清单（缺失即非零退出）。

**验证**：修复后打包日志不再出现该 warning；win-unpacked/resources/genoffice/THIRD-PARTY-NOTICES.txt 存在（1,443.5 KB，571 npm packages + 112 Rust crates）。

### 2.2 [已知·非问题] signtool 签名日志但实际 NotSigned

**现象**：打包日志多次输出 `signing with signtool.exe path=...`，但 `Get-AuthenticodeSignature` 返回 `Status: NotSigned`。

**判定**：electron-builder 26 在 Windows 上默认调用 signtool 尝试签名所有 exe；无代码签名证书时 signtool 静默跳过（不阻塞打包）。与 CON-07（v0.1 不引入签名基础设施）一致，非问题。v0.4+ 引入正式签名后此行为会改变。

### 2.3 [已知·非阻塞] chunk size > 500 kB warnings

**现象**：构建阶段多个 chunk 超过 500 kB：

| chunk | 大小 | 来源 |
|-------|------|------|
| `pi-agent-factory-*.cjs` | 2,077 kB | main（pi-agent 依赖闭包） |
| `index-D3hFsWGB.js` | 2,976 kB | pi-web frontend |
| `index.js`（urchin-embed） | 11,585 kB | genoffice embed（含 pdf.worker） |
| `clipper-panel-app-*.js` | 760 kB | renderer（剪藏面板） |

**判定**：Vite/Rollup 性能优化建议，不影响功能。首版不处理；后续可按需用 `manualChunks` 拆分。

### 2.4 [已知·非阻塞] import.meta 在 cjs 输出中为空

**现象**：`build-pi-web.mjs` 打包 pi-web-host.js 时 esbuild warning：`"import.meta" is not available with the "cjs" output format`。

**判定**：pi-web-host 的 `loader.ts` 用 `import.meta.resolve(specifier)` 解析路径；cjs 输出下 `import.meta` 为空对象。实测 pi-web 运行正常（系统 Node 子进程加载），不影响功能。上游 pi 代码问题，不在本项目修复范围。

### 2.5 [已知·非阻塞] notices 脚本 warning

**现象**：`gen-third-party-notices.mjs` 输出 `no license file published: ...`（17 个包）和 `not installed, skipped: list, available, bold`（3 个 optional deps）。

**判定**：17 个包未发布 license 文件（脚本 fallback 到 package.json license 字段 + repository URL）；3 个包是跨平台 optional deps 未安装（正常）。文件仍成功生成，内容完整。

## 3. 产物完整性验证（修复后）

### 3.1 构建产物（dist/）

| 目录 | 文件数 | 状态 |
|------|--------|------|
| `dist/main` | 43 | OK（含 pi-web-host.js 8.2 MB） |
| `dist/preload` | 2 | OK |
| `dist/renderer` | 966 | OK |
| `dist/pi-web` | 102 | OK |

### 3.2 打包产物（release-v24/）

| 文件 | 大小 | 状态 |
|------|------|------|
| `Urchin-Browser-0.3.0-dev.144-x64.exe` | 322.63 MB | OK（NSIS 安装包） |
| `Urchin-Browser-0.3.0-dev.144-x64.exe.blockmap` | 0.29 MB | OK（增量更新） |
| `dev.yml` | — | OK（更新清单） |
| `win-unpacked/顽童浏览器.exe` | 228.7 MB | OK（解压版） |

### 3.3 extraResources 完整性（electron-builder.yml 声明 vs 产物）

全部 19 项 extraResources 在 win-unpacked/resources/ 下存在，包括修复后的 `genoffice/THIRD-PARTY-NOTICES.txt`。

### 3.4 validateArtifacts 校验

`package-win.mjs` 内置的产物校验通过：version/channel/releaseType/manifest/exe/blockmap/app-update.yml 全部匹配。

## 4. 修改文件清单

| 文件 | 修改内容 |
|------|----------|
| `scripts/genoffice-build.mjs` | 新增 import `copyFileSync`/`relative`；新增 3.6 步骤（notices 生成+复制）；artifacts 清单加入 THIRD-PARTY-NOTICES.txt |
| `apps/desktop/electron-builder.yml` | 更新许可合规段注释（注明 notices 现由 genoffice-build.mjs 自动生成+复制，记录 2026-11-03 修复） |

## 5. 遗留项与建议

| 项 | 优先级 | 建议 |
|----|--------|------|
| 代码签名（CON-07） | v0.4+ | v0.4 引入 Authenticode 签名基础设施 |
| chunk size 优化 | 低 | 后续按需用 manualChunks 拆分大 chunk |
| notices 脚本 17 包无 license 文件 | 低 | 上游问题，无法在本项目修复 |
