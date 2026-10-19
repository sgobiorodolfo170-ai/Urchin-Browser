/**
 * GenOffice 特权 scheme 常量（宿主 app ready 前注册用）。
 *
 * 本模块被两处消费：
 * 1. 嵌入包入口 `index.ts` re-export——公共 API 保持
 *    `GENOFFICE_SCHEME_PRIVILEGES` 不变；
 * 2. 构建期由 `scripts/genoffice-extract-scheme-privileges.mjs` 经 esbuild
 *    单独打成 `out/main/scheme-privileges.json`；Urchin 宿主在 ready 前只读
 *    该 JSON 取常量，不再为 4 条静态配置 require 整个嵌入包（启动优化：
 *    慢盘上省约 7.76MB 冷读及其解析）。
 *
 * 约束：本模块及其依赖链必须保持**零 Electron 运行时依赖**（electron 仅
 * type-only import，其余依赖为纯 TS 常量/函数），否则构建期抽取出的产物
 * 无法在普通 Node 中加载校验、宿主也无法轻量读取。
 */
import type { CustomScheme } from 'electron'
import {
  DOCX_MEDIA_SCHEME_PRIVILEGE,
  RENDERER_SCHEME_PRIVILEGE,
} from '@genoffice/electron-utils/renderer-scheme'
import { ASSET_SCHEME, PREVIEW_SCHEME } from '../../../html/src/main/preview-document'

/** Privileged schemes the embed's renderers need. Spread these into the host's
 * single `registerSchemesAsPrivileged([...])` call before `app.whenReady()`.
 *
 * - `RENDERER_SCHEME_PRIVILEGE` serves the built renderer pages and
 *   `DOCX_MEDIA_SCHEME_PRIVILEGE` carries lazily served document pictures; both
 *   come straight from GenOffice's own helpers so privileges never drift.
 * - `html-preview` / `html-asset` (scheme names from the html app's
 *   preview-document module) serve the live preview iframe and its assets. */
export const GENOFFICE_SCHEME_PRIVILEGES: readonly CustomScheme[] = [
  RENDERER_SCHEME_PRIVILEGE,
  DOCX_MEDIA_SCHEME_PRIVILEGE,
  {
    scheme: PREVIEW_SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true },
  },
  {
    scheme: ASSET_SCHEME,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true,
    },
  },
]
