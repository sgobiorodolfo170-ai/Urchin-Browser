/**
 * 本地文件关联 · 纯函数与常量（file-association）
 *
 * 职责：生成 Windows 注册表关联条目、解析启动命令行文件参数、定义关联分组。
 * 注册表写入/查询由 register.ts 执行（经 reg.exe），本模块保持纯函数便于单测。
 *
 * 关联机制（HKCU 用户级，无需管理员权限）：
 * 每个扩展名 .ext 注册两个键：
 *   1. HKCU\Software\Classes\.ext → 默认值 = ProgID，并登记 OpenWithProgids
 *   2. HKCU\Software\Classes\UrchinBrowser.ext → shell\open\command = "<exe>" "%1"
 * 注册后该浏览器出现在资源管理器「打开方式 → 选择其他应用」列表；
 * 用户勾选「始终使用此应用」后由 Windows 系统写入 UserChoice 完成永久默认。
 * 说明：不直接写 UserChoice 键——Win10/11 该键带 hash 校验，直接写入会被系统
 * 忽略且易触发行为判定（WinRT security mitigation），官方「打开方式」路径更可靠。
 */
import type { FileKind } from '@urchin/ipc-contract';
import { getExtensionsForKind } from '../files/file-kind';
import { BROWSER_NAME_ZH } from '../../shared/brand';

/** ProgID 前缀（与 appId 语义一致；ext 小写）。 */
const PROGID_PREFIX = 'UrchinBrowser';

/** 默认浏览器 ProgID / 客户端键（http/https 与网页文件共用）。 */
export const DEFAULT_BROWSER_PROG_ID = 'UrchinHTML';
export const DEFAULT_BROWSER_CLIENT_KEY = 'UrchinBrowser';

/**
 * Windows「默认应用」中本应用专属页的 URI。
 *
 * Win11 21H2（2023-04 累积更新）起支持 `registeredAppUser` 参数，取值必须是
 * RegisteredApplications 的值名（即 DEFAULT_BROWSER_CLIENT_KEY），而不是显示名；
 * 旧系统会忽略参数仍落到「默认应用」总览页，因此可作为首选入口。
 */
export function buildDefaultAppsSettingsUri(): string {
  return `ms-settings:defaultapps?registeredAppUser=${encodeURIComponent(DEFAULT_BROWSER_CLIENT_KEY)}`;
}

/** 关联分组标识。 */
export type AssociationGroupId = 'media' | 'documents' | 'images';

/** 分组定义：展示名 + 覆盖的 kind 集合。 */
export interface AssociationGroup {
  readonly id: AssociationGroupId;
  readonly label: string;
  readonly description: string;
  readonly kinds: readonly FileKind[];
}

/** 三组文件关联（设置页「默认应用」卡片数据源）。 */
export const ASSOCIATION_GROUPS: readonly AssociationGroup[] = [
  {
    id: 'media',
    label: '音视频',
    description: 'MP3 / MP4 / WAV 等音频视频文件',
    kinds: ['audio', 'video'],
  },
  {
    id: 'documents',
    label: '文档',
    description: 'PDF / Word / Markdown / MHTML / 文本 / JSON 等文档文件',
    kinds: ['pdf', 'docx', 'markdown', 'json', 'text', 'html', 'mhtml'],
  },
  {
    id: 'images',
    label: '图片',
    description: 'PNG / JPG / GIF / SVG 等图片文件',
    kinds: ['image'],
  },
];

/** 取某分组覆盖的扩展名清单（源自 EXT_KIND 分类表单一真源，字母序去重）。 */
export function getExtensionsForGroup(group: AssociationGroup): readonly string[] {
  const set = new Set<string>();
  for (const kind of group.kinds) {
    for (const ext of getExtensionsForKind(kind)) {
      set.add(ext);
    }
  }
  return [...set].sort();
}

/** 取全部关联分组各自的扩展名清单（key = 分组 id）。 */
export function getExtensionsByGroup(): Readonly<Record<AssociationGroupId, readonly string[]>> {
  return Object.fromEntries(
    ASSOCIATION_GROUPS.map((g) => [g.id, getExtensionsForGroup(g)]),
  ) as Readonly<Record<AssociationGroupId, readonly string[]>>;
}

/** 生成某扩展名的 ProgID（如 mp3 → UrchinBrowser.mp3）。 */
export function buildProgId(ext: string): string {
  return `${PROGID_PREFIX}.${ext.toLowerCase()}`;
}

/** 注册表键值条目：reg.exe add 的参数。 */
export interface RegistryEntry {
  /** 键路径（HKCU\Software\Classes\...）。 */
  readonly key: string;
  /** 值名称；'/d' 表示默认值。 */
  readonly valueName: string;
  readonly value: string;
}

/** 构建 shell 打开命令（dev 模式需把应用目录作为首个参数传给 Electron）。 */
export function buildOpenCommand(exePath: string, launchArgs: readonly string[] = []): string {
  const args = launchArgs.map((arg) => `"${arg}"`).join(' ');
  return args ? `"${exePath}" ${args} "%1"` : `"${exePath}" "%1"`;
}

/** 生成某扩展名所需的注册表条目（ProgID 命令 + 扩展名 OpenWithProgids 登记）。 */
export function buildRegistryEntries(
  ext: string,
  exePath: string,
  launchArgs: readonly string[] = [],
): readonly RegistryEntry[] {
  const cleanExt = ext.toLowerCase().replace(/^\./, '');
  const progId = buildProgId(cleanExt);
  const extKey = `HKCU\\Software\\Classes\\.${cleanExt}`;
  const progIdKey = `HKCU\\Software\\Classes\\${progId}`;
  return [
    // .ext 默认值 = ProgID（资源管理器用 ProgID 找到打开命令）
    { key: extKey, valueName: '/d', value: progId },
    // .ext 的 OpenWithProgids 子键登记（使本浏览器出现在「打开方式」列表）
    { key: `${extKey}\\OpenWithProgids`, valueName: progId, value: '' },
    // ProgID 默认描述（资源管理器「打开方式」里显示的名称）
    { key: progIdKey, valueName: '/d', value: BROWSER_NAME_ZH },
    // 打开命令：带引号的 exe 路径 + "%1" 文件参数
    {
      key: `${progIdKey}\\shell\\open\\command`,
      valueName: '/d',
      value: buildOpenCommand(exePath, launchArgs),
    },
    // 文件类型图标：用 exe 内置图标（模块 0）
    { key: `${progIdKey}\\DefaultIcon`, valueName: '/d', value: `"${exePath}",0` },
  ];
}

/**
 * 生成「设为默认浏览器」所需的注册表能力项。
 *
 * Windows 10/11 不允许直接改写 UserChoice（带哈希校验），因此这里按
 * Chrome/Edge 的做法登记 RegisteredApplications + StartMenuInternet 能力，
 * 让本浏览器出现在系统「默认应用」候选列表，再由用户在该页确认。
 */
export function buildDefaultBrowserRegistryEntries(
  exePath: string,
  launchArgs: readonly string[] = [],
): readonly RegistryEntry[] {
  const progIdKey = `HKCU\\Software\\Classes\\${DEFAULT_BROWSER_PROG_ID}`;
  const clientKey = `HKCU\\Software\\Clients\\StartMenuInternet\\${DEFAULT_BROWSER_CLIENT_KEY}`;
  const capabilitiesKey = `${clientKey}\\Capabilities`;
  const command = buildOpenCommand(exePath, launchArgs);
  return [
    { key: progIdKey, valueName: '/d', value: BROWSER_NAME_ZH },
    { key: `${progIdKey}\\shell\\open\\command`, valueName: '/d', value: command },
    { key: `${progIdKey}\\DefaultIcon`, valueName: '/d', value: `"${exePath}",0` },
    { key: clientKey, valueName: '/d', value: BROWSER_NAME_ZH },
    { key: `${clientKey}\\DefaultIcon`, valueName: '/d', value: `"${exePath}",0` },
    { key: `${clientKey}\\shell\\open\\command`, valueName: '/d', value: command },
    { key: capabilitiesKey, valueName: 'ApplicationName', value: BROWSER_NAME_ZH },
    {
      key: capabilitiesKey,
      valueName: 'ApplicationDescription',
      value: `${BROWSER_NAME_ZH} - AI 原生桌面浏览器`,
    },
    { key: capabilitiesKey, valueName: 'ApplicationIcon', value: `"${exePath}",0` },
    {
      key: `${capabilitiesKey}\\URLAssociations`,
      valueName: 'http',
      value: DEFAULT_BROWSER_PROG_ID,
    },
    {
      key: `${capabilitiesKey}\\URLAssociations`,
      valueName: 'https',
      value: DEFAULT_BROWSER_PROG_ID,
    },
    {
      key: `${capabilitiesKey}\\FileAssociations`,
      valueName: '.htm',
      value: DEFAULT_BROWSER_PROG_ID,
    },
    {
      key: `${capabilitiesKey}\\FileAssociations`,
      valueName: '.html',
      value: DEFAULT_BROWSER_PROG_ID,
    },
    {
      key: `${capabilitiesKey}\\FileAssociations`,
      valueName: '.mht',
      value: DEFAULT_BROWSER_PROG_ID,
    },
    {
      key: `${capabilitiesKey}\\FileAssociations`,
      valueName: '.mhtml',
      value: DEFAULT_BROWSER_PROG_ID,
    },
    {
      key: 'HKCU\\Software\\RegisteredApplications',
      valueName: DEFAULT_BROWSER_CLIENT_KEY,
      value: `Software\\Clients\\StartMenuInternet\\${DEFAULT_BROWSER_CLIENT_KEY}\\Capabilities`,
    },
  ];
}

/** 生成多个扩展名的全部注册表条目。 */
export function buildAllRegistryEntries(
  exts: readonly string[],
  exePath: string,
  launchArgs: readonly string[] = [],
): readonly RegistryEntry[] {
  const seen = new Set<string>();
  const entries: RegistryEntry[] = [];
  for (const ext of exts) {
    const key = ext.toLowerCase().replace(/^\./, '');
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push(...buildRegistryEntries(key, exePath, launchArgs));
  }
  return entries;
}

/**
 * 解析启动/第二实例命令行中的文件参数（Windows 文件关联启动）。
 *
 * 调用方传入完整 argv（含 argv[0] exe 路径），本函数跳过 argv[0]——
 * exe 路径本身含反斜杠/盘符，不跳过会被误判为文件。
 * 兼容两种文件形态：
 * - 裸路径：C:\Users\a\doc.pdf
 * - file:// URL：file:///C:/Users/a/doc.pdf（File:// 大小写亦兼容）
 * 非文件参数（以 - / -- 开头）与无文件参数时返回 null。
 */
export function parseUrlArg(argv: readonly string[]): string | null {
  for (const arg of argv.slice(1)) {
    if (!arg) continue;
    if (/^https?:\/\//i.test(arg)) return arg;
  }
  return null;
}

export function parseFileArg(argv: readonly string[]): string | null {
  // argv[0] 是 exe 路径，跳过
  for (const arg of argv.slice(1)) {
    if (!arg) continue;
    if (arg.startsWith('-')) continue;
    if (/^file:\/\//i.test(arg)) {
      // file:///C:/x → C:/x；file://C:/x → C:/x
      const rest = arg.slice('file://'.length);
      const path = rest.replace(/^\/+/, '');
      // 路径可能含百分号编码；decodeURI 遇畸形 % 会抛错，失败则回退原串
      try {
        return decodeURI(path).replace(/\//g, '\\');
      } catch {
        return path.replace(/\//g, '\\');
      }
    }
    // 裸路径（含反斜杠或盘符）视为文件
    if (arg.includes('\\') || /^[a-zA-Z]:/.test(arg)) {
      return arg;
    }
  }
  return null;
}
