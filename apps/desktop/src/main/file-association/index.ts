/**
 * 本地文件关联模块（默认应用）
 *
 * 职责：把浏览器登记为音视频/文档/图片文件的打开方式（HKCU 注册表，非侵入模型：
 * 只登记能力与 OpenWithProgids，不改写 `.ext` 默认值），解析 Windows 文件关联
 * 启动参数（URL / 多个本地文件），并支持幂等清理本应用写过登记项。
 */
export { registerFileAssociationHandlers } from './register-handlers';
export type { FileAssociationHandlersDeps } from './register-handlers';
export {
  ASSOCIATION_GROUPS,
  DEFAULT_BROWSER_CLIENT_KEY,
  DEFAULT_BROWSER_PROG_ID,
  buildAllRegistryEntries,
  buildAppRegistryEntries,
  buildAppRemovals,
  buildDefaultAppsSettingsUri,
  buildDefaultBrowserRegistryEntries,
  buildExtensionEntries,
  buildExtensionRemovals,
  buildOpenCommand,
  buildProgId,
  buildRegistryEntries,
  exeBaseName,
  getExtensionsByGroup,
  getExtensionsForGroup,
  parseFileArg,
  parseOpenArgs,
  parseUrlArg,
} from './associations';
export type {
  AssociationGroup,
  AssociationGroupId,
  OpenRequest,
  RegistryEntry,
  RegistryRemoval,
} from './associations';
export {
  buildRegAddArgs,
  buildRegDeleteArgs,
  getRegisteredExtensions,
  getRegistrationState,
  parseCapabilityExtensions,
  registerAssociations,
  registerRegistryEntries,
  unregisterAssociations,
} from './register';
export type {
  AssociationDeps,
  RegistrationState,
  RegExec,
  UnregisterOptions,
  UnregisterResult,
  UnregisterScope,
} from './register';
