/**
 * 本地文件关联 · 纯函数与常量（file-association）
 *
 * 职责：生成 Windows 注册表关联条目、解析启动命令行文件参数、定义关联分组。
 * 注册表写入/查询由 register.ts 执行（经 reg.exe），本模块保持纯函数便于单测。
 *
 * 关联机制（HKCU 用户级，无需管理员权限）——非侵入模型（与 Chrome / Edge / Quark 一致）：
 *   1. 应用级：`Applications\<exe>`（FriendlyAppName + DefaultIcon + shell\open\command）
 *      + `Clients\StartMenuInternet\UrchinBrowser\Capabilities`（ApplicationName 等）
 *      + `RegisteredApplications`（把能力挂到系统「默认应用」）
 *   2. 扩展名级：`Software\Classes\UrchinBrowser.<ext>` ProgID（描述 + Application
 *      + DefaultIcon + shell\open\command）+ `.ext\OpenWithProgids` 登记
 *      + `Capabilities\FileAssociations` 的 `.ext = ProgID`
 * **不写 `.ext` 的默认值**：那等于静默劫持系统行为、无法回滚，且 Win10/11 有
 * UserChoice（带 hash）时该值会被忽略。用户需在系统「打开方式 / 默认应用」里
 * 确认一次，由系统自己写 UserChoice。
 * 说明：不直接写 UserChoice 键——Win10/11 该键带 hash 校验，直接写入会被系统
 * 忽略且易触发行为判定（WinRT security mitigation），官方「打开方式」路径更可靠。
 */
import type { FileKind } from '@urchin/ipc-contract';
import { getExtensionsForKind, isAssociableExtension } from '../files/file-kind';
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
    description: 'MP3 / MP4 / WAV / FLAC 等音频视频文件',
    kinds: ['audio', 'video'],
  },
  {
    id: 'documents',
    label: '文档',
    description: 'PDF / Word / Excel / PPT / Markdown / 文本 / JSON 等文档文件',
    // html / mhtml 不在此组：网页与网页快照归「默认浏览器」能力（UrchinHTML），
    // 两组共用同一扩展会产生两个 ProgID 抢同一个 .ext，系统「打开方式」里出现重复项。
    kinds: ['pdf', 'docx', 'pptx', 'xlsx', 'markdown', 'json', 'text'],
  },
  {
    id: 'images',
    label: '图片',
    description: 'PNG / JPG / GIF / SVG 等图片文件',
    kinds: ['image'],
  },
];

/**
 * 取某分组覆盖的扩展名清单（源自 EXT_KIND 分类表单一真源，字母序去重）。
 *
 * 经 ASSOCIABLE_EXTENSIONS 白名单过滤：只登记本浏览器确实能渲染、且不会
 * 抢走系统关键行为的扩展名（代码 / 脚本 / 配置类不登记）。
 */
export function getExtensionsForGroup(group: AssociationGroup): readonly string[] {
  const set = new Set<string>();
  for (const kind of group.kinds) {
    for (const ext of getExtensionsForKind(kind)) {
      if (isAssociableExtension(ext)) set.add(ext);
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

/** 取可执行文件名（`Applications\<exe>` 键名必须与 exe 文件名一致）。 */
export function exeBaseName(exePath: string): string {
  const parts = exePath.split(/[\\/]/);
  return parts[parts.length - 1] ?? exePath;
}

/** 应用级登记键：Applications\<exe> + StartMenuInternet 客户端 + RegisteredApplications。 */
const CAPABILITIES_KEY = `HKCU\\Software\\Clients\\StartMenuInternet\\${DEFAULT_BROWSER_CLIENT_KEY}\\Capabilities`;

/**
 * 生成应用级登记条目（一次写全，与具体扩展名无关）。
 *
 * 为什么需要 `Applications\<exe>`：Windows 10/11 的「打开方式」「默认应用」
 * 按**应用**分组展示可选应用，仅登记 ProgID 时系统只认「某个 ProgID」，
 * 在「默认应用 → 按文件类型」里选不到本浏览器（Quark/Chrome 均登记此键）。
 */
export function buildAppRegistryEntries(
  exePath: string,
  launchArgs: readonly string[] = [],
): readonly RegistryEntry[] {
  const clientKey = `HKCU\\Software\\Clients\\StartMenuInternet\\${DEFAULT_BROWSER_CLIENT_KEY}`;
  const appKey = `HKCU\\Software\\Classes\\Applications\\${exeBaseName(exePath)}`;
  const command = buildOpenCommand(exePath, launchArgs);
  return [
    { key: appKey, valueName: '/d', value: BROWSER_NAME_ZH },
    { key: appKey, valueName: 'FriendlyAppName', value: BROWSER_NAME_ZH },
    { key: `${appKey}\\DefaultIcon`, valueName: '/d', value: `"${exePath}",0` },
    { key: `${appKey}\\shell\\open\\command`, valueName: '/d', value: command },
    { key: clientKey, valueName: '/d', value: BROWSER_NAME_ZH },
    { key: `${clientKey}\\DefaultIcon`, valueName: '/d', value: `"${exePath}",0` },
    { key: `${clientKey}\\shell\\open\\command`, valueName: '/d', value: command },
    { key: CAPABILITIES_KEY, valueName: 'ApplicationName', value: BROWSER_NAME_ZH },
    {
      key: CAPABILITIES_KEY,
      valueName: 'ApplicationDescription',
      value: `${BROWSER_NAME_ZH} - AI 原生桌面浏览器`,
    },
    { key: CAPABILITIES_KEY, valueName: 'ApplicationIcon', value: `"${exePath}",0` },
    {
      key: 'HKCU\\Software\\RegisteredApplications',
      valueName: DEFAULT_BROWSER_CLIENT_KEY,
      value: `Software\\Clients\\StartMenuInternet\\${DEFAULT_BROWSER_CLIENT_KEY}\\Capabilities`,
    },
  ];
}

/**
 * 生成单个扩展名的登记条目。
 *
 * 与旧实现的关键差异：**不再写 `HKCU\Software\Classes\.ext` 的默认值**。
 * - 直接改 `.ext` 默认值 = 静默劫持系统行为（改坏且无备份，无法回滚）；
 * - Win10/11 有 `UserChoice`（带 hash）时该值会被忽略，写了也不生效；
 * - 正确做法（Chrome / Edge / Quark 一致）：登记能力 + OpenWithProgids，
 *   由用户在系统「默认应用 / 打开方式」里确认一次，系统自己写 UserChoice。
 */
export function buildExtensionEntries(
  ext: string,
  exePath: string,
  launchArgs: readonly string[] = [],
): readonly RegistryEntry[] {
  const cleanExt = ext.toLowerCase().replace(/^\./, '');
  const progId = buildProgId(cleanExt);
  const progIdKey = `HKCU\\Software\\Classes\\${progId}`;
  return [
    // ProgID 描述（「打开方式」列表里显示的名称）
    { key: progIdKey, valueName: '/d', value: BROWSER_NAME_ZH },
    // ProgID 归属应用：系统据此把 ProgID 归到「顽童浏览器」名下
    { key: `${progIdKey}\\Application`, valueName: 'ApplicationName', value: BROWSER_NAME_ZH },
    { key: `${progIdKey}\\DefaultIcon`, valueName: '/d', value: `"${exePath}",0` },
    {
      key: `${progIdKey}\\shell\\open\\command`,
      valueName: '/d',
      value: buildOpenCommand(exePath, launchArgs),
    },
    // 传统「打开方式 → 选择其他应用」列表（非侵入：不改变默认值）
    {
      key: `HKCU\\Software\\Classes\\.${cleanExt}\\OpenWithProgids`,
      valueName: progId,
      value: '',
    },
    // Windows 10/11「默认应用 → 按文件类型」候选（Capabilities 才认应用）
    { key: `${CAPABILITIES_KEY}\\FileAssociations`, valueName: `.${cleanExt}`, value: progId },
  ];
}

/** 生成某扩展名所需的注册表条目（兼容旧名称，等价 buildExtensionEntries）。 */
export function buildRegistryEntries(
  ext: string,
  exePath: string,
  launchArgs: readonly string[] = [],
): readonly RegistryEntry[] {
  return buildExtensionEntries(ext, exePath, launchArgs);
}

/**
 * 生成「设为默认浏览器」所需的注册表能力项。
 *
 * Windows 10/11 不允许直接改写 UserChoice（带哈希校验），因此这里按
 * Chrome/Edge 的做法登记 RegisteredApplications + StartMenuInternet 能力，
 * 让本浏览器出现在系统「默认应用」候选列表，再由用户在该页确认。
 *
 * 复用 buildAppRegistryEntries 的应用级条目（Applications\<exe> / StartMenuInternet /
 * RegisteredApplications），再补默认浏览器专属项（UrchinHTML ProgID + URL/文件关联能力）。
 * 两处共用同一组键应保持值一致，重复写入在 reg.exe 下是幂等的。
 */
export function buildDefaultBrowserRegistryEntries(
  exePath: string,
  launchArgs: readonly string[] = [],
): readonly RegistryEntry[] {
  const progIdKey = `HKCU\\Software\\Classes\\${DEFAULT_BROWSER_PROG_ID}`;
  const capabilitiesKey = `${CAPABILITIES_KEY}`;
  const command = buildOpenCommand(exePath, launchArgs);
  return [
    ...buildAppRegistryEntries(exePath, launchArgs),
    { key: progIdKey, valueName: '/d', value: BROWSER_NAME_ZH },
    {
      key: `${progIdKey}\\Application`,
      valueName: 'ApplicationName',
      value: BROWSER_NAME_ZH,
    },
    { key: `${progIdKey}\\shell\\open\\command`, valueName: '/d', value: command },
    { key: `${progIdKey}\\DefaultIcon`, valueName: '/d', value: `"${exePath}",0` },
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
  ];
}

/** 生成多个扩展名的全部注册表条目（应用级条目 + 各扩展名条目）。 */
export function buildAllRegistryEntries(
  exts: readonly string[],
  exePath: string,
  launchArgs: readonly string[] = [],
): readonly RegistryEntry[] {
  const seen = new Set<string>();
  const entries: RegistryEntry[] = [...buildAppRegistryEntries(exePath, launchArgs)];
  for (const ext of exts) {
    const key = ext.toLowerCase().replace(/^\./, '');
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push(...buildExtensionEntries(key, exePath, launchArgs));
  }
  return entries;
}

/**
 * 注册表删除目标。
 *
 * valueName 语义：`null` = 删除整个键；`'/ve'` = 删除 (默认) 值；
 * 其它字符串 = 删除同名值。
 */
export interface RegistryRemoval {
  readonly key: string;
  readonly valueName: string | null;
}

/**
 * 单个扩展名的删除目标（「清除本应用关联」用）。
 *
 * 只删本应用自己写过的项：
 * - `Capabilities\FileAssociations` 下的值
 * - `.ext\OpenWithProgids` 下本应用 ProgID 的值（不动别人的值）
 * - `HKCU\Software\Classes\UrchinBrowser.<ext>` 整个 ProgID 键
 * `.ext` 默认值**不在此列**——旧版本曾把它改成我们的 ProgID，是否清理要
 * 先查询确认（见 register.ts 的 unregisterAssociations）。
 */
export function buildExtensionRemovals(ext: string): readonly RegistryRemoval[] {
  const cleanExt = ext.toLowerCase().replace(/^\./, '');
  const progId = buildProgId(cleanExt);
  return [
    { key: `${CAPABILITIES_KEY}\\FileAssociations`, valueName: `.${cleanExt}` },
    { key: `HKCU\\Software\\Classes\\.${cleanExt}\\OpenWithProgids`, valueName: progId },
    { key: `HKCU\\Software\\Classes\\${progId}`, valueName: null },
  ];
}

/** 应用级删除目标（「移除本应用登记」用：含默认浏览器能力）。 */
export function buildAppRemovals(exePath: string): readonly RegistryRemoval[] {
  return [
    { key: `HKCU\\Software\\Classes\\Applications\\${exeBaseName(exePath)}`, valueName: null },
    {
      key: 'HKCU\\Software\\RegisteredApplications',
      valueName: DEFAULT_BROWSER_CLIENT_KEY,
    },
    {
      key: `HKCU\\Software\\Clients\\StartMenuInternet\\${DEFAULT_BROWSER_CLIENT_KEY}`,
      valueName: null,
    },
    { key: `HKCU\\Software\\Classes\\${DEFAULT_BROWSER_PROG_ID}`, valueName: null },
  ];
}

/** 命令行打开请求解析结果（URL 与本地文件分离，均可能为空）。 */
export interface OpenRequest {
  readonly urls: readonly string[];
  readonly files: readonly string[];
}

/**
 * 路径比较用的归一化：反斜杠统一、去尾部斜杠、小写（Windows 大小写不敏感）。
 *
 * 只做字符串层面归一，不解析相对路径——调用方传入的 appPath 恒为绝对路径，
 * 相对形态（'.' / '..'）在 parseOpenArgs 里单独排除。
 */
function normalizePathForCompare(p: string): string {
  return p.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
}

/**
 * 解析启动 / 第二实例命令行中的打开请求（URL + 本地文件）。
 *
 * 必须显式传入 appPath（主进程用 `app.getAppPath()`）：
 * 开发模式（以及 `pnpm start` 生产模式）由 `electron <appDir> <file>` 启动，
 * `argv[1]` 是**应用目录**而不是用户文件；旧实现只跳过 argv[0]，于是把 appDir
 * 当成文件交给查看器——表现为「右键用本浏览器打开图片/视频一律报错」。
 *
 * 规则：
 * - 跳过 argv[0]、空参数、`-`/`--` 开关、`.`/`..`、与 appPath 等值的参数
 * - `http(s)://` → urls
 * - `file://` → 本地路径（decodeURI，畸形编码回退原串）
 * - 含分隔符或盘符的裸路径 → files（相对文件名不猜，避免误收 Electron 内部参数）
 * - 顺序保留、去重
 */
export function parseOpenArgs(argv: readonly string[], appPath?: string): OpenRequest {
  const urls: string[] = [];
  const files: string[] = [];
  const appKey = appPath ? normalizePathForCompare(appPath) : null;
  const seen = new Set<string>();

  const push = (list: string[], value: string): void => {
    const key = `v:${value}`;
    if (seen.has(key)) return;
    seen.add(key);
    list.push(value);
  };

  for (const raw of argv.slice(1)) {
    if (!raw) continue;
    if (raw === '--') continue;
    if (raw.startsWith('-')) continue;
    if (raw === '.' || raw === '..') continue;

    if (/^https?:\/\//i.test(raw)) {
      push(urls, raw);
      continue;
    }

    if (/^file:\/\//i.test(raw)) {
      // file:///C:/x → C:/x；file://C:/x → C:/x
      const rest = raw.slice('file://'.length);
      const path = rest.replace(/^\/+/, '');
      let decoded: string;
      try {
        decoded = decodeURI(path);
      } catch {
        decoded = path;
      }
      const filePath = decoded.replace(/\//g, '\\');
      if (!appKey || normalizePathForCompare(filePath) !== appKey) push(files, filePath);
      continue;
    }

    // 裸路径（含分隔符或盘符）才视为文件；不带分隔符的相对名不猜
    if (!raw.includes('\\') && !raw.includes('/') && !/^[a-zA-Z]:/.test(raw)) continue;
    if (appKey && normalizePathForCompare(raw) === appKey) continue;
    push(files, raw);
  }

  return { urls, files };
}

/**
 * 取命令行里的首个 http(s) URL（保留旧签名；新代码用 parseOpenArgs）。
 */
export function parseUrlArg(argv: readonly string[]): string | null {
  return parseOpenArgs(argv).urls[0] ?? null;
}

/**
 * 取命令行里的首个本地文件（保留旧签名）。
 *
 * @param appPath 应用目录（开发/生产模式 `electron <appDir>` 启动时必须传，
 *   否则应用目录会被误判为用户文件——见 parseOpenArgs 注释）
 */
export function parseFileArg(argv: readonly string[], appPath?: string): string | null {
  return parseOpenArgs(argv, appPath).files[0] ?? null;
}
