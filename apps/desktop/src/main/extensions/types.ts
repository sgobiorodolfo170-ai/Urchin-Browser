/**
 * M10 Extension Loader · Manifest v3 类型定义
 *
 * 依据：04-模块全景 M10 / Chrome Extension Manifest V3 规范
 * v0.1 lite：仅支持解压扩展目录加载、manifest v3 解析与校验。
 */

/** Manifest V3 类型。 */
export type ManifestType = 'manifest' | 'theme' | 'locale';

/** 扩展权限。 */
export type ExtensionPermission =
  | 'activeTab'
  | 'tabs'
  | 'storage'
  | 'cookies'
  | 'history'
  | 'bookmarks'
  | 'webRequest'
  | 'scripting'
  | 'contextMenus'
  | 'notifications'
  | 'downloads';

/** Content Script 匹配模式。 */
export interface ContentScript {
  readonly matches: readonly string[];
  readonly js?: readonly string[];
  readonly css?: readonly string[];
  readonly runAt?: 'document_start' | 'document_end' | 'document_idle';
}

/** Background Service Worker 配置。 */
export interface BackgroundServiceWorker {
  readonly service_worker: string;
  readonly type?: 'module' | 'classic';
}

/** Manifest V3 结构（子集）。 */
export interface ManifestV3 {
  readonly manifest_version: 3;
  readonly name: string;
  readonly version: string;
  readonly description?: string;
  readonly type?: ManifestType;
  readonly permissions?: readonly ExtensionPermission[];
  readonly host_permissions?: readonly string[];
  readonly content_scripts?: readonly ContentScript[];
  readonly background?: BackgroundServiceWorker;
  readonly icons?: Record<string, string>;
  readonly action?: {
    readonly default_popup?: string;
    readonly default_icon?: Record<string, string>;
  };
  readonly options_page?: string;
  readonly options_ui?: {
    readonly page: string;
    readonly open_in_tab?: boolean;
  };
}

/** 已加载的扩展信息。 */
export interface LoadedExtension {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly path: string;
  readonly manifest: ManifestV3;
  readonly enabled: boolean;
  readonly loadedAt: number;
}

/** Manifest 校验结果。 */
export interface ManifestValidationResult {
  readonly valid: boolean;
  readonly errors: readonly string[];
  readonly manifest?: ManifestV3;
}
