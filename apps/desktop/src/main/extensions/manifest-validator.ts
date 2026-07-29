/**
 * M10 Extension Loader · Manifest 校验器
 *
 * 依据：04-模块全景 M10 v0.1 lite / Chrome Extension Manifest V3 规范
 * 职责：
 * 1. 解析 manifest.json 为 ManifestV3 对象
 * 2. 校验必填字段（manifest_version、name、version）
 * 3. 校验 manifest_version 必须为 3
 * 4. 校验 name/version 非空
 * 5. 校验 permissions 为已知权限列表
 *
 * 设计理由（agents.md §七.2）：
 * 纯函数，无副作用，便于单元测试。
 */

import type { ManifestV3, ManifestValidationResult, ExtensionPermission } from './types';

/** 已知权限白名单。 */
const KNOWN_PERMISSIONS: readonly ExtensionPermission[] = [
  'activeTab',
  'tabs',
  'storage',
  'cookies',
  'history',
  'bookmarks',
  'webRequest',
  'scripting',
  'contextMenus',
  'notifications',
  'downloads',
];

/**
 * 将 unknown 值安全转换为字符串描述，用于错误信息。
 *
 * 避免 `@typescript-eslint/no-base-to-string`：不直接 String(unknown)。
 */
function describeValue(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  if (typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}

/**
 * 解析并校验 manifest JSON 字符串。
 *
 * @param jsonStr manifest.json 文件内容
 * @returns 校验结果
 */
export function parseManifest(jsonStr: string): ManifestValidationResult {
  const errors: string[] = [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonStr);
  } catch {
    return { valid: false, errors: ['Invalid JSON: failed to parse manifest.json'] };
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { valid: false, errors: ['Manifest must be a JSON object'] };
  }

  const obj = parsed as Record<string, unknown>;

  // 校验 manifest_version
  if (obj.manifest_version === undefined) {
    errors.push('Missing required field: manifest_version');
  } else if (obj.manifest_version !== 3) {
    errors.push(`manifest_version must be 3, got: ${describeValue(obj.manifest_version)}`);
  }

  // 校验 name
  if (obj.name === undefined) {
    errors.push('Missing required field: name');
  } else if (typeof obj.name !== 'string' || obj.name.trim() === '') {
    errors.push('name must be a non-empty string');
  }

  // 校验 version
  if (obj.version === undefined) {
    errors.push('Missing required field: version');
  } else if (typeof obj.version !== 'string' || obj.version.trim() === '') {
    errors.push('version must be a non-empty string');
  }

  // 校验 permissions（如果存在）
  if (obj.permissions !== undefined) {
    if (!Array.isArray(obj.permissions)) {
      errors.push('permissions must be an array');
    } else {
      for (const perm of obj.permissions) {
        if (typeof perm !== 'string' || !KNOWN_PERMISSIONS.includes(perm as ExtensionPermission)) {
          errors.push(`Unknown permission: ${describeValue(perm)}`);
        }
      }
    }
  }

  // 校验 content_scripts（如果存在）
  if (obj.content_scripts !== undefined) {
    if (!Array.isArray(obj.content_scripts)) {
      errors.push('content_scripts must be an array');
    } else {
      for (let i = 0; i < obj.content_scripts.length; i++) {
        const cs = obj.content_scripts[i] as Record<string, unknown> | undefined;
        if (!cs || !Array.isArray(cs.matches) || cs.matches.length === 0) {
          errors.push(`content_scripts[${i}] must have non-empty matches array`);
        }
      }
    }
  }

  if (errors.length > 0) {
    return { valid: false, errors };
  }

  return { valid: true, errors: [], manifest: obj as unknown as ManifestV3 };
}
