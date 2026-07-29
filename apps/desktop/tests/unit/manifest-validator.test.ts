/**
 * M10 Extension Loader · Manifest 校验器单元测试
 *
 * 验证 manifest v3 解析与校验规则。
 */
import { describe, it, expect } from 'vitest';
import { parseManifest } from '../../src/main/extensions/manifest-validator';

/** 有效的最小 manifest。 */
const VALID_MANIFEST = JSON.stringify({
  manifest_version: 3,
  name: 'Test Extension',
  version: '1.0.0',
});

/** 带权限的完整 manifest。 */
const FULL_MANIFEST = JSON.stringify({
  manifest_version: 3,
  name: 'Full Extension',
  version: '2.0.0',
  description: 'A test extension',
  permissions: ['activeTab', 'storage', 'tabs'],
  content_scripts: [
    {
      matches: ['https://*.example.com/*'],
      js: ['content.js'],
      runAt: 'document_idle',
    },
  ],
  background: {
    service_worker: 'background.js',
    type: 'module',
  },
});

describe('parseManifest', () => {
  it('should parse valid minimal manifest', () => {
    const result = parseManifest(VALID_MANIFEST);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
    expect(result.manifest?.manifest_version).toBe(3);
    expect(result.manifest?.name).toBe('Test Extension');
    expect(result.manifest?.version).toBe('1.0.0');
  });

  it('should parse full manifest with permissions and scripts', () => {
    const result = parseManifest(FULL_MANIFEST);
    expect(result.valid).toBe(true);
    expect(result.manifest?.permissions).toEqual(['activeTab', 'storage', 'tabs']);
    expect(result.manifest?.content_scripts).toHaveLength(1);
    expect(result.manifest?.background?.service_worker).toBe('background.js');
  });

  it('should reject invalid JSON', () => {
    const result = parseManifest('{ invalid json }');
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain('Invalid JSON');
  });

  it('should reject non-object JSON', () => {
    const result = parseManifest('"just a string"');
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain('JSON object');
  });

  it('should reject array JSON', () => {
    const result = parseManifest('[]');
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain('JSON object');
  });

  it('should reject missing manifest_version', () => {
    const result = parseManifest(JSON.stringify({ name: 'Test', version: '1.0.0' }));
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('manifest_version'))).toBe(true);
  });

  it('should reject manifest_version other than 3', () => {
    const result = parseManifest(
      JSON.stringify({ manifest_version: 2, name: 'Test', version: '1.0.0' }),
    );
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('must be 3'))).toBe(true);
  });

  it('should reject missing name', () => {
    const result = parseManifest(JSON.stringify({ manifest_version: 3, version: '1.0.0' }));
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('name'))).toBe(true);
  });

  it('should reject empty name', () => {
    const result = parseManifest(
      JSON.stringify({ manifest_version: 3, name: '  ', version: '1.0.0' }),
    );
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('non-empty'))).toBe(true);
  });

  it('should reject missing version', () => {
    const result = parseManifest(JSON.stringify({ manifest_version: 3, name: 'Test' }));
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('version'))).toBe(true);
  });

  it('should reject empty version', () => {
    const result = parseManifest(
      JSON.stringify({ manifest_version: 3, name: 'Test', version: '' }),
    );
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('non-empty'))).toBe(true);
  });

  it('should reject unknown permission', () => {
    const result = parseManifest(
      JSON.stringify({
        manifest_version: 3,
        name: 'Test',
        version: '1.0.0',
        permissions: ['activeTab', 'unknownPermission'],
      }),
    );
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('unknownPermission'))).toBe(true);
  });

  it('should reject permissions that is not an array', () => {
    const result = parseManifest(
      JSON.stringify({
        manifest_version: 3,
        name: 'Test',
        version: '1.0.0',
        permissions: 'activeTab',
      }),
    );
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('permissions must be an array'))).toBe(true);
  });

  it('should reject content_scripts without matches', () => {
    const result = parseManifest(
      JSON.stringify({
        manifest_version: 3,
        name: 'Test',
        version: '1.0.0',
        content_scripts: [{ js: ['content.js'] }],
      }),
    );
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('matches'))).toBe(true);
  });

  it('should reject content_scripts with empty matches', () => {
    const result = parseManifest(
      JSON.stringify({
        manifest_version: 3,
        name: 'Test',
        version: '1.0.0',
        content_scripts: [{ matches: [], js: ['content.js'] }],
      }),
    );
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('matches'))).toBe(true);
  });

  it('should accept all known permissions', () => {
    const allPerms = [
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
    const result = parseManifest(
      JSON.stringify({
        manifest_version: 3,
        name: 'Test',
        version: '1.0.0',
        permissions: allPerms,
      }),
    );
    expect(result.valid).toBe(true);
  });
});
