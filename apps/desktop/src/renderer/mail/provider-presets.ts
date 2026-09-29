/**
 * M25 邮箱模块 · 服务商预设表
 *
 * 依据：用户指令「自建多邮箱服务商预设 + 登录向导」（2026-09-25）
 * 职责：
 * 1. 内置常见邮箱服务商的 IMAP/SMTP 配置（host/port/secure）
 * 2. 域名自动识别：输入邮箱地址 → 匹配 domains → 建议对应服务商
 * 3. 认证方式提示：密码 / 授权码 / OAuth2（v0.3）
 *
 * 数据来源说明：各服务商公开文档（2026-09 核对的公开 IMAP 配置）。
 * 渲染进程纯数据层——无副作用、无 IPC、无网络请求，可单测。
 */

/** 认证方式：password=账户密码；app-password=授权码/应用专用密码；oauth2=OAuth2 授权（v0.3） */
export type MailAuthType = 'password' | 'app-password' | 'oauth2';

/** 服务商预设 */
export interface MailProviderPreset {
  /** 唯一标识（如 'gmail' / 'qq'） */
  readonly id: string;
  /** 显示名（如 'Gmail' / 'QQ邮箱'） */
  readonly name: string;
  /** 邮箱域名列表（用于自动识别，如 ['gmail.com', 'googlemail.com']） */
  readonly domains: readonly string[];
  /** IMAP 配置 */
  readonly imap: {
    readonly host: string;
    readonly port: number;
    readonly secure: boolean;
  };
  /** SMTP 配置（W2 发信用；W1 仅收信可为空） */
  readonly smtp?: {
    readonly host: string;
    readonly port: number;
    readonly secure: boolean;
  };
  /** 认证方式 */
  readonly authType: MailAuthType;
  /** 认证提示（如「QQ邮箱需使用授权码而非登录密码」） */
  readonly authHint?: string;
  /** 附加说明（如「需先在网页版设置中开启 IMAP 服务」） */
  readonly note?: string;
  /** 是否支持 OAuth2（v0.3 能力标记，W1 不使用） */
  readonly oauth2Supported?: boolean;
}

/**
 * 内置服务商预设表。
 *
 * 排序策略：国内常用在前（QQ/163/126 等），国际常用随后（Gmail/Outlook 等），
 * 小众与企业邮箱居后。custom（自定义）不在此表内——由 UI 单独追加入口。
 */
export const MAIL_PROVIDER_PRESETS: readonly MailProviderPreset[] = [
  {
    id: 'qq',
    name: 'QQ邮箱',
    domains: ['qq.com', 'foxmail.com'],
    imap: { host: 'imap.qq.com', port: 993, secure: true },
    smtp: { host: 'smtp.qq.com', port: 465, secure: true },
    authType: 'app-password',
    authHint: '使用授权码（非 QQ 密码）',
    note: '需先在 QQ邮箱网页版「设置 → 账户」中开启 IMAP/SMTP 服务并生成授权码',
  },
  {
    id: '163',
    name: '网易163邮箱',
    domains: ['163.com'],
    imap: { host: 'imap.163.com', port: 993, secure: true },
    smtp: { host: 'smtp.163.com', port: 465, secure: true },
    authType: 'app-password',
    authHint: '使用客户端授权码（非登录密码）',
    note: '需先在网页版「设置 → POP3/SMTP/IMAP」中开启服务并获取授权码',
  },
  {
    id: '126',
    name: '网易126邮箱',
    domains: ['126.com'],
    imap: { host: 'imap.126.com', port: 993, secure: true },
    smtp: { host: 'smtp.126.com', port: 465, secure: true },
    authType: 'app-password',
    authHint: '使用客户端授权码（非登录密码）',
    note: '需先在网页版开启 IMAP/SMTP 服务并获取授权码',
  },
  {
    id: 'gmail',
    name: 'Gmail',
    domains: ['gmail.com', 'googlemail.com'],
    imap: { host: 'imap.gmail.com', port: 993, secure: true },
    smtp: { host: 'smtp.gmail.com', port: 465, secure: true },
    authType: 'app-password',
    authHint: '使用应用专用密码（需开启两步验证）',
    note: 'Google 已停用「低安全性应用」——须开启两步验证后生成应用专用密码；OAuth2 将于 v0.3 支持',
    oauth2Supported: true,
  },
  {
    id: 'outlook',
    name: 'Outlook / Hotmail',
    domains: ['outlook.com', 'hotmail.com', 'live.com', 'msn.com'],
    imap: { host: 'outlook.office365.com', port: 993, secure: true },
    smtp: { host: 'smtp.office365.com', port: 587, secure: false },
    authType: 'app-password',
    authHint: '微软已停用基本认证——如密码不可用，请使用 OAuth2（v0.3）',
    note: 'Microsoft 365 已全面停用基本认证（2026），个人账户密码可能失效',
    oauth2Supported: true,
  },
  {
    id: 'sina',
    name: '新浪邮箱',
    domains: ['sina.com', 'sina.cn'],
    imap: { host: 'imap.sina.com', port: 993, secure: true },
    smtp: { host: 'smtp.sina.com', port: 465, secure: true },
    authType: 'app-password',
    authHint: '使用授权码（非登录密码）',
    note: '需先在网页版开启 IMAP 服务并获取授权码',
  },
  {
    id: 'sohu',
    name: '搜狐邮箱',
    domains: ['sohu.com'],
    imap: { host: 'imap.sohu.com', port: 993, secure: true },
    smtp: { host: 'smtp.sohu.com', port: 465, secure: true },
    authType: 'password',
  },
  {
    id: '139',
    name: '移动139邮箱',
    domains: ['139.com'],
    imap: { host: 'imap.139.com', port: 993, secure: true },
    smtp: { host: 'smtp.139.com', port: 465, secure: true },
    authType: 'app-password',
    authHint: '使用授权码（非登录密码）',
  },
  {
    id: '189',
    name: '电信189邮箱',
    domains: ['189.cn'],
    imap: { host: 'imap.189.cn', port: 993, secure: true },
    smtp: { host: 'smtp.189.cn', port: 465, secure: true },
    authType: 'password',
  },
  {
    id: 'aliyun',
    name: '阿里云邮',
    domains: ['aliyun.com'],
    imap: { host: 'imap.aliyun.com', port: 993, secure: true },
    smtp: { host: 'smtp.aliyun.com', port: 465, secure: true },
    authType: 'password',
  },
  {
    id: 'exmail',
    name: '腾讯企业邮箱',
    domains: [], // 企业邮箱域名不定，不提供自动识别
    imap: { host: 'imap.exmail.qq.com', port: 993, secure: true },
    smtp: { host: 'smtp.exmail.qq.com', port: 465, secure: true },
    authType: 'password',
    authHint: '企业邮箱完整地址 + 密码（或客户端专用密码）',
  },
  {
    id: 'yeah',
    name: '网易Yeah邮箱',
    domains: ['yeah.net'],
    imap: { host: 'imap.yeah.net', port: 993, secure: true },
    smtp: { host: 'smtp.yeah.net', port: 465, secure: true },
    authType: 'app-password',
    authHint: '使用客户端授权码（非登录密码）',
  },
  {
    id: 'icloud',
    name: 'iCloud Mail',
    domains: ['icloud.com', 'me.com', 'mac.com'],
    imap: { host: 'imap.mail.me.com', port: 993, secure: true },
    smtp: { host: 'smtp.mail.me.com', port: 587, secure: false },
    authType: 'app-password',
    authHint: '使用 App 专用密码（appleid.apple.com 生成）',
    note: '需开启 Apple ID 两步验证后生成 App 专用密码',
  },
  {
    id: 'yahoo',
    name: 'Yahoo Mail',
    domains: ['yahoo.com', 'yahoo.cn', 'ymail.com'],
    imap: { host: 'imap.mail.yahoo.com', port: 993, secure: true },
    smtp: { host: 'smtp.mail.yahoo.com', port: 465, secure: true },
    authType: 'app-password',
    authHint: '使用应用密码（Yahoo 账户安全页生成）',
  },
  {
    id: 'zoho',
    name: 'Zoho Mail',
    domains: ['zoho.com', 'zohomail.com'],
    imap: { host: 'imap.zoho.com', port: 993, secure: true },
    smtp: { host: 'smtp.zoho.com', port: 465, secure: true },
    authType: 'password',
    note: '部分地区数据中心为 imap.zoho.eu / imap.zoho.in，连接失败时改用自定义配置',
  },
  {
    id: 'aol',
    name: 'AOL Mail',
    domains: ['aol.com'],
    imap: { host: 'imap.aol.com', port: 993, secure: true },
    smtp: { host: 'smtp.aol.com', port: 465, secure: true },
    authType: 'app-password',
    authHint: '使用应用密码',
  },
];

/**
 * 按邮箱地址自动识别服务商。
 *
 * 匹配规则：取 @ 后的域名小写化，与预设 domains 精确匹配（不含子域——
 * mail.qq.com 这类网页域名不用于邮箱地址识别，qq.com 才是邮箱域名）。
 *
 * @param email 邮箱地址（允许前后空白，自动 trim）
 * @returns 匹配的预设；无匹配返回 undefined
 */
export function detectProviderByEmail(email: string): MailProviderPreset | undefined {
  const trimmed = email.trim();
  const at = trimmed.lastIndexOf('@');
  if (at < 0 || at === trimmed.length - 1) return undefined;
  const domain = trimmed.slice(at + 1).toLowerCase();
  return MAIL_PROVIDER_PRESETS.find((p) => p.domains.includes(domain));
}

/**
 * 按 ID 查预设。
 *
 * @param id 预设 ID（如 'gmail'）；'custom' 返回 undefined（自定义不在预设表内）
 */
export function getPresetById(id: string): MailProviderPreset | undefined {
  return MAIL_PROVIDER_PRESETS.find((p) => p.id === id);
}
