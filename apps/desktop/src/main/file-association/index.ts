/**
 * 本地文件关联模块（默认应用）
 *
 * 职责：把浏览器注册为音视频/文档/图片文件的打开方式（HKCU 注册表），
 * 并解析 Windows 文件关联启动参数，复用本地文件查看功能打开文件。
 */
export { registerFileAssociationHandlers } from './register-handlers';
export {
  ASSOCIATION_GROUPS,
  buildDefaultBrowserRegistryEntries,
  buildOpenCommand,
  buildProgId,
  buildRegistryEntries,
  parseFileArg,
  parseUrlArg,
  getExtensionsForGroup,
  getExtensionsByGroup,
} from './associations';
export type { AssociationGroupId, AssociationGroup, RegistryEntry } from './associations';
export { registerAssociations, registerRegistryEntries, getRegisteredExtensions } from './register';
