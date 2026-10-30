/**
 * pi-web-host · 插件权限系统（阶段 3）
 *
 * 三层权限模型：
 * 1. 静态能力声明（manifest.permissions + apiVersion 协商）
 * 2. 目录访问授权（plugin-grants.json）
 * 3. 动态能力授权（plugin-permissions.json）
 *
 * fail-closed 设计：读坏当空表，基础族未声明直接回 false
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, resolve as pathResolve, relative, isAbsolute } from 'node:path';

const GRANTS_FILE = 'plugin-grants.json';
const PERMISSIONS_FILE = 'plugin-permissions.json';

/** 已知能力族 */
const KNOWN_FAMILIES = new Set([
  'fs',
  'fs:read',
  'fs:write',
  'ui',
  'tools',
  'http',
  'chat',
  'net',
  'llm',
  'dom',
  'dom:anchor',
  'notify',
  'storage',
  'secrets',
]);

/** manifest 校验结果 */
export interface ManifestValidationResult {
  errors: string[];
  warnings: string[];
}

/** 校验插件 manifest */
export function validatePluginManifest(manifest: {
  permissions?: string[];
  apiVersion?: number;
  id?: string;
  name?: string;
}): ManifestValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!manifest.id && !manifest.name) {
    errors.push('manifest must have id or name');
  }

  const apiVersion = manifest.apiVersion ?? 1;

  if (apiVersion === 2 && (!manifest.permissions || manifest.permissions.length === 0)) {
    errors.push('apiVersion 2 requires explicit permissions array');
  }

  if (manifest.permissions) {
    for (const perm of manifest.permissions) {
      if (!KNOWN_FAMILIES.has(perm)) {
        warnings.push(`unknown permission family: ${perm}`);
      }
    }
  }

  return { errors, warnings };
}

/** 插件能力声明快照（从 manifest 提取） */
export interface PluginCapabilities {
  families: Set<string>;
  apiVersion: number;
  netAllowlist: string[];
}

/** 从 manifest 提取能力声明 */
export function extractCapabilities(manifest: {
  permissions?: string[];
  apiVersion?: number;
  netAllowlist?: string[];
}): PluginCapabilities {
  return {
    families: new Set(manifest.permissions ?? []),
    apiVersion: manifest.apiVersion ?? 1,
    netAllowlist: manifest.netAllowlist ?? [],
  };
}

/** 权限检查（fail-closed） */
export function canUse(caps: PluginCapabilities, family: string): boolean {
  if (caps.apiVersion === 1 && caps.families.size === 0) {
    return true;
  }
  if (caps.families.has(family)) return true;
  if (family === 'fs:read' || family === 'fs:write') {
    return caps.families.has('fs');
  }
  if (family === 'dom:anchor') {
    return caps.families.has('dom') || caps.families.has('dom:anchor');
  }
  return false;
}

// ── 目录授权表（plugin-grants.json） ──

interface GrantsData {
  grants: Record<string, string[]>;
}

async function readGrants(agentDir: string): Promise<GrantsData> {
  try {
    const raw = await readFile(join(agentDir, GRANTS_FILE), 'utf8');
    return JSON.parse(raw) as GrantsData;
  } catch {
    return { grants: {} };
  }
}

async function writeGrants(agentDir: string, data: GrantsData): Promise<void> {
  await mkdir(agentDir, { recursive: true });
  await writeFile(join(agentDir, GRANTS_FILE), JSON.stringify(data, null, 2), 'utf8');
}

/** 检查插件是否有权访问指定目录 */
export async function checkDirAccess(
  agentDir: string,
  pluginId: string,
  targetPath: string,
): Promise<boolean> {
  const data = await readGrants(agentDir);
  const granted = data.grants[pluginId] ?? [];

  const resolved = pathResolve(targetPath);
  for (const dir of granted) {
    const grantedDir = pathResolve(dir);
    const rel = relative(grantedDir, resolved);
    if (!rel.startsWith('..') && !isAbsolute(rel)) {
      return true;
    }
  }
  return false;
}

/** 授权插件访问目录 */
export async function grantDirAccess(
  agentDir: string,
  pluginId: string,
  dir: string,
): Promise<void> {
  const data = await readGrants(agentDir);
  data.grants[pluginId] ??= [];
  const resolved = pathResolve(dir);
  if (!data.grants[pluginId].includes(resolved)) {
    data.grants[pluginId].push(resolved);
    await writeGrants(agentDir, data);
  }
}

/** 撤销插件的目录授权 */
export async function revokeDirAccess(
  agentDir: string,
  pluginId: string,
  dir?: string,
): Promise<void> {
  const data = await readGrants(agentDir);
  if (dir) {
    const resolved = pathResolve(dir);
    data.grants[pluginId] = (data.grants[pluginId] ?? []).filter((d) => d !== resolved);
  } else {
    delete data.grants[pluginId];
  }
  await writeGrants(agentDir, data);
}

/** 获取所有插件的目录授权 */
export async function listGrants(
  agentDir: string,
): Promise<{ pluginId: string; paths: string[] }[]> {
  const data = await readGrants(agentDir);
  return Object.entries(data.grants).map(([pluginId, paths]) => ({ pluginId, paths }));
}

// ── 动态能力授权（plugin-permissions.json） ──

interface PermissionsData {
  grants: {
    net?: { hosts: string[]; session?: boolean };
    llm?: { models: string[]; session?: boolean };
  };
}

async function readPermissions(agentDir: string): Promise<Record<string, PermissionsData>> {
  try {
    const raw = await readFile(join(agentDir, PERMISSIONS_FILE), 'utf8');
    return JSON.parse(raw) as Record<string, PermissionsData>;
  } catch {
    return {};
  }
}

async function writePermissions(
  agentDir: string,
  data: Record<string, PermissionsData>,
): Promise<void> {
  await mkdir(agentDir, { recursive: true });
  await writeFile(join(agentDir, PERMISSIONS_FILE), JSON.stringify(data, null, 2), 'utf8');
}

/** 检查网络主机是否被授权 */
export async function checkNetHost(
  agentDir: string,
  pluginId: string,
  host: string,
): Promise<boolean> {
  const data = await readPermissions(agentDir);
  const perm = data[pluginId];
  if (!perm?.grants?.net) return false;
  const hosts = perm.grants.net.hosts;
  return hosts.some((h) => host === h || host.endsWith(`.${h}`));
}

/** 授权插件访问网络主机 */
export async function grantNetHost(
  agentDir: string,
  pluginId: string,
  host: string,
): Promise<void> {
  const data = await readPermissions(agentDir);
  data[pluginId] ??= { grants: {} };
  data[pluginId].grants.net ??= { hosts: [] };
  if (!data[pluginId].grants.net.hosts.includes(host)) {
    data[pluginId].grants.net.hosts.push(host);
    await writePermissions(agentDir, data);
  }
}

/** 检查 LLM 模型是否被授权 */
export async function checkLlmModel(
  agentDir: string,
  pluginId: string,
  model: string,
): Promise<boolean> {
  const data = await readPermissions(agentDir);
  const perm = data[pluginId];
  if (!perm?.grants?.llm) return true;
  if (perm.grants.llm.models.length === 0) return true;
  return perm.grants.llm.models.includes(model);
}

/** 获取所有动态授权 */
export async function listPermissions(
  agentDir: string,
): Promise<{ pluginId: string; family: string; hosts?: string[]; models?: string[] }[]> {
  const data = await readPermissions(agentDir);
  const result: { pluginId: string; family: string; hosts?: string[]; models?: string[] }[] = [];
  for (const [pluginId, perm] of Object.entries(data)) {
    if (perm.grants.net) {
      result.push({ pluginId, family: 'net', hosts: perm.grants.net.hosts });
    }
    if (perm.grants.llm) {
      result.push({ pluginId, family: 'llm', models: perm.grants.llm.models });
    }
  }
  return result;
}

// ── DOM 授权表（plugin-dom.json） ──

const DOM_FILE = 'plugin-dom.json';

async function readDomConsent(agentDir: string): Promise<Record<string, boolean>> {
  try {
    const raw = await readFile(join(agentDir, DOM_FILE), 'utf8');
    return JSON.parse(raw) as Record<string, boolean>;
  } catch {
    return {};
  }
}

async function writeDomConsent(agentDir: string, data: Record<string, boolean>): Promise<void> {
  await mkdir(agentDir, { recursive: true });
  await writeFile(join(agentDir, DOM_FILE), JSON.stringify(data, null, 2), 'utf8');
}

/** 检查插件是否被授权访问特权 DOM */
export async function checkDomConsent(agentDir: string, pluginId: string): Promise<boolean> {
  const data = await readDomConsent(agentDir);
  return data[pluginId] === true;
}

/** 授权/撤销插件 DOM 访问 */
export async function setDomConsent(
  agentDir: string,
  pluginId: string,
  granted: boolean,
): Promise<void> {
  const data = await readDomConsent(agentDir);
  data[pluginId] = granted;
  await writeDomConsent(agentDir, data);
}

/** 检查 manifest 是否请求了特权 DOM */
export function declarationWantsDom(permissions: string[] | undefined): boolean {
  if (!permissions) return false;
  return permissions.some((p) => p === 'dom' || p === 'dom:anchor');
}
