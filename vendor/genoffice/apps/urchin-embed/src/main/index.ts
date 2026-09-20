/**
 * @genoffice/urchin-embed — main-process embedding layer for Urchin Browser.
 *
 * Goal: expose GenOffice editor views (one `WebContentsView` per open file) to a
 * foreign Electron host without touching GenOffice app sources. The host owns
 * tabs, content-area layout, window chrome, theme/language bootstrap and the
 * close-guard UX; GenOffice owns the editor UI, per-view file access allowlists,
 * dirty tracking and save flows.
 *
 * Lifecycle (all calls run in the host's main process):
 *   1. before app ready — read `GENOFFICE_SCHEME_PRIVILEGES` and spread them into
 *      the host's own `protocol.registerSchemesAsPrivileged` call. Electron only
 *      accepts this call once per process, and Urchin already registers its own
 *      `urchin` scheme, so the embed deliberately does NOT register anything.
 *   2. after app ready  — `initGenOfficeEmbed({ rendererRoots, preloads, ... })`
 *      installs the `genoffice-app://` handler and configures each editor.
 *   3. per open file    — `createGenOfficeView(kind, filePath)` returns the view
 *      to mount into the host window (host manages bounds/visibility).
 *   4. close guard      — `genOfficeIsDirty(kind, wc)` and
 *      `requestGenOfficeClose(kind, wc, parent)` reuse GenOffice's own
 *      Save / Don't Save / Cancel flow.
 *
 * Wired kinds (phase 4 complete): `markdown`, `pdf`, `html`, `docs` (docx).
 * Every kind follows the same three-call shape — a per-kind `configure*Runtime`,
 * `create*View` and close guard, all exported by the GenOffice app mains.
 */
import type { BrowserWindow, CustomScheme, WebContents, WebContentsView } from 'electron'
import { ipcMain } from 'electron'
import { resolve } from 'node:path'
import { writeFile } from 'node:fs/promises'
import {
  AI_MEDIA_PROVIDERS,
  AI_PROVIDERS,
  AI_SEARCH_PROVIDERS,
  getProviderAdapter,
} from '@genoffice/ai-provider/browser'
import {
  DOCX_MEDIA_SCHEME_PRIVILEGE,
  RENDERER_SCHEME_PRIVILEGE,
  installRendererProtocol,
} from '@genoffice/electron-utils'
import { setUiLang, isLang } from '@genoffice/i18n'
import { PDFDocument } from 'pdf-lib'
import {
  configureMarkdownRuntime,
  createMarkdownView,
  markdownIsDirty,
  requestMarkdownClose,
} from '../../../markdown/src/main/markdown-main'
import {
  configurePdfRuntime,
  createPdfView,
  pdfIsDirty,
  requestPdfClose,
} from '../../../pdf/src/main/pdf-main'
import {
  configureHtmlRuntime,
  createHtmlView,
  htmlIsDirty,
  requestHtmlClose,
} from '../../../html/src/main/html-main'
import { ASSET_SCHEME, PREVIEW_SCHEME } from '../../../html/src/main/preview-document'
import {
  configureDocsRuntime,
  createDocsView,
  docsQueryDirty,
  markDocsNewBlank,
  registerAiIpc,
  registerDocsIpc,
  registerProjectIpc,
  requestDocsClose,
} from '../../../docs/src/main/docs-main'

/** Editor modules the embed can host. */
export type GenOfficeKind = 'markdown' | 'pdf' | 'html' | 'docs'

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

export interface GenOfficeEmbedOptions {
  /** Absolute path of each editor's built renderer directory (served as
   * `genoffice-app://<kind>/index.html`). */
  readonly rendererRoots: Partial<Record<GenOfficeKind, string>>
  /** Absolute path of each editor's built preload bundle. */
  readonly preloads: Partial<Record<GenOfficeKind, string>>
  /** Optional electron-vite dev-server URLs; take precedence over rendererRoots
   * for the matching kind (renderer HMR during development). */
  readonly devRendererUrls?: Partial<Record<GenOfficeKind, string>>
  /** Host router for files the editor exports (e.g. Markdown → PDF). Return true
   * when the host opened the file, false to let GenOffice fall back to revealing
   * it in the OS file manager. */
  readonly openGeneratedPath?: (path: string) => boolean
  /**
   * Extra renderer roots served over `genoffice-app://<host>/index.html`
   * beyond the editor kinds — the Urchin host uses this for the GenOffice
   * shell Home renderer (`shell`), which it mounts with its own preload.
   */
  readonly extraRendererRoots?: Record<string, string>
}

/** True once the GenOffice AI + project IPC pair has been registered. */
let aiInitialized = false

/** True once the docs IPC surface has been registered (upstream has no guard). */
let docsIpcRegistered = false

/**
 * GenOffice AI catalogs, shaped exactly like the GenOffice shell preload's
 * `getAiProviders` / `getAiMediaProviders` / `getAiSearchProviders` so a host
 * settings UI can consume one payload:
 * - `providers` carries `defaultBaseUrl` resolved through the provider adapter
 *   (genspark routes by model and custom has no default → empty string).
 */
function buildAiCatalogs(): {
  providers: unknown[]
  mediaProviders: unknown
  searchProviders: unknown
} {
  return {
    providers: AI_PROVIDERS.map((meta) => {
      let defaultBaseUrl = ''
      if (meta.id !== 'genspark' && !meta.needsBaseUrl && !meta.needsCliPath) {
        defaultBaseUrl = getProviderAdapter(meta.id).resolveEndpoint({
          apiKey: '',
          model: meta.defaultModel,
        }).baseUrl
      }
      return { ...meta, defaultBaseUrl }
    }),
    mediaProviders: AI_MEDIA_PROVIDERS,
    searchProviders: AI_SEARCH_PROVIDERS,
  }
}

/**
 * After app ready: register GenOffice's native AI stack (`ai:*`) and project
 * chat store (`project:*`) exactly once, then expose the AI catalogs to the
 * host settings UI through `genoffice:ai-catalogs`.
 *
 * Notes:
 * - `registerAiIpc` has no idempotency guard upstream, so the module-level
 *   flag is set BEFORE the calls: a throw mid-registration must never lead to
 *   a retry (duplicate `ipcMain.handle` would throw "second handler").
 * - The AI settings file lives at `<userData>/ai-settings.json` of the host
 *   process (Urchin's userData), which is exactly where the settings UI reads
 *   and writes through `ai:get-settings` / `ai:set-settings`.
 */
export function initGenOfficeAi(): void {
  if (aiInitialized) return
  aiInitialized = true
  registerAiIpc()
  registerProjectIpc()
  ipcMain.handle('genoffice:ai-catalogs', () => buildAiCatalogs())
}

/**
 * After app ready: install the renderer scheme handler and configure every
 * editor that has a preload/renderer pair in `opts`. Idempotent — calling it
 * twice with the same paths is harmless (`protocol.handle` is per-scheme, so
 * repeat calls replace the handler with an identical one).
 */
export function initGenOfficeEmbed(opts: GenOfficeEmbedOptions): void {
  const roots: Record<string, string> = {}
  for (const [kind, root] of Object.entries(opts.rendererRoots)) {
    // Normalize through path.resolve: on Windows `resolveRendererFile` compares
    // the candidate file (built with backslashes) against the configured root
    // with `startsWith(root + path.sep)`, so a forward-slash root silently
    // 404s every asset. GenOffice's own shell passes path.join() results and
    // never hits this; a foreign host can.
    if (typeof root === 'string' && root.length > 0) roots[kind] = resolve(root)
  }
  for (const [host, root] of Object.entries(opts.extraRendererRoots ?? {})) {
    if (typeof root === 'string' && root.length > 0) roots[host] = resolve(root)
  }
  if (Object.keys(roots).length > 0) installRendererProtocol(roots)

  const rendererFileOf = (kind: GenOfficeKind): string | undefined => {
    const root = roots[kind]
    return root ? resolve(root, 'index.html') : undefined
  }
  const openGeneratedPath = opts.openGeneratedPath

  const markdownPreload = opts.preloads.markdown
  if (markdownPreload) {
    configureMarkdownRuntime({
      preloadPath: resolve(markdownPreload),
      rendererUrl: opts.devRendererUrls?.markdown,
      rendererFile: rendererFileOf('markdown'),
      openGeneratedPath,
    })
  }

  const pdfPreload = opts.preloads.pdf
  if (pdfPreload) {
    configurePdfRuntime({
      preloadPath: resolve(pdfPreload),
      rendererUrl: opts.devRendererUrls?.pdf,
      rendererFile: rendererFileOf('pdf'),
      openGeneratedPath,
    })
  }

  const htmlPreload = opts.preloads.html
  if (htmlPreload) {
    configureHtmlRuntime({
      preloadPath: resolve(htmlPreload),
      rendererUrl: opts.devRendererUrls?.html,
      rendererFile: rendererFileOf('html'),
      openGeneratedPath,
    })
  }

  const docsPreload = opts.preloads.docs
  const docsRendererFile = rendererFileOf('docs')
  if (docsPreload && docsRendererFile) {
    // Docs renderer file operations / lazy media / app-wide channels are
    // registered by registerDocsIpc (upstream has no idempotency guard).
    if (!docsIpcRegistered) {
      docsIpcRegistered = true
      registerDocsIpc()
    }
    configureDocsRuntime({
      preloadPath: resolve(docsPreload),
      rendererUrl: opts.devRendererUrls?.docs,
      rendererFile: docsRendererFile,
    })
  }
}

/**
 * Create the editor view for `filePath`. The caller grants file access through
 * this call (GenOffice queues the path per webContents and its file IPC is
 * allowlisted against it) and owns mounting, bounds and visibility.
 */
export function createGenOfficeView(kind: GenOfficeKind, filePath: string | null): WebContentsView {
  switch (kind) {
    case 'markdown':
      return createMarkdownView(filePath)
    case 'pdf':
      return createPdfView(filePath)
    case 'html':
      return createHtmlView(filePath)
    case 'docs':
      return createDocsView(filePath ?? undefined)
    default: {
      const exhaustive: never = kind
      throw new Error(`GenOffice kind not wired yet: ${String(exhaustive)}`)
    }
  }
}

/**
 * Create a view for a NEW (unsaved) document of `kind` — used by the host's
 * GenOffice Home "new file" actions. Docs is opened at its start screen via
 * `markDocsNewBlank`; Markdown/HTML/PDF open in their in-memory blank modes
 * (PDF included: the app shows its empty state until a save-as picks a path).
 */
export function createGenOfficeBlankView(kind: GenOfficeKind): WebContentsView {
  switch (kind) {
    case 'docs': {
      const view = createDocsView(undefined)
      markDocsNewBlank(view.webContents.id)
      return view
    }
    case 'markdown':
      return createMarkdownView(null)
    case 'html':
      return createHtmlView(null)
    case 'pdf':
      return createPdfView(null)
    default: {
      const exhaustive: never = kind
      throw new Error(`GenOffice kind not wired yet: ${String(exhaustive)}`)
    }
  }
}

/** Write a blank single-page PDF (Home "new PDF" action; pdf-lib is already in
 * the bundle through the PDF editor main). */
export async function writeBlankPdfFile(filePath: string): Promise<void> {
  const doc = await PDFDocument.create()
  doc.addPage([595.28, 841.89])
  await writeFile(filePath, await doc.save())
}

/** Switch the GenOffice UI language (main-process dictionaries + native dialogs). */
export function setGenOfficeLanguage(lang: string): void {
  if (isLang(lang)) setUiLang(lang)
}

/**
 * Whether the view has unsaved changes (drives the host's tab dirty mark).
 *
 * Async because the docs editor reports dirtiness through its own close-check
 * handshake (`docsQueryDirty`) instead of a dirty-changed push; the other three
 * kinds answer synchronously from their in-process state.
 */
export async function genOfficeIsDirty(
  kind: GenOfficeKind,
  contents: WebContents,
): Promise<boolean> {
  switch (kind) {
    case 'markdown':
      return markdownIsDirty(contents.id)
    case 'pdf':
      return pdfIsDirty(contents.id)
    case 'html':
      return htmlIsDirty(contents.id)
    case 'docs':
      return docsQueryDirty(contents)
    default: {
      const exhaustive: never = kind
      throw new Error(`GenOffice kind not wired yet: ${String(exhaustive)}`)
    }
  }
}

/**
 * Run the editor's own close guard (Save / Don't Save / Cancel). Resolves true
 * when the host may destroy the view. The dialog is parented to `parent` when
 * given so it stays modal to the host window.
 */
export function requestGenOfficeClose(
  kind: GenOfficeKind,
  contents: WebContents,
  parent?: BrowserWindow | null,
): Promise<boolean> {
  switch (kind) {
    case 'markdown':
      return requestMarkdownClose(contents, parent)
    case 'pdf':
      return requestPdfClose(contents, parent)
    case 'html':
      return requestHtmlClose(contents, parent)
    case 'docs':
      return requestDocsClose(contents, parent)
    default: {
      const exhaustive: never = kind
      throw new Error(`GenOffice kind not wired yet: ${String(exhaustive)}`)
    }
  }
}
