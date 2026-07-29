/**
 * M10 Extension Loader · 模块入口
 *
 * 依据：04-模块全景 M10 v0.1 lite
 */
export { ExtensionLoader } from './extension-loader';
export { parseManifest } from './manifest-validator';
export type {
  ManifestV3,
  ManifestType,
  ExtensionPermission,
  ContentScript,
  BackgroundServiceWorker,
  LoadedExtension,
  ManifestValidationResult,
} from './types';
