/**
 * plugin-permissions.ts 单元测试
 */
import { describe, it, expect } from 'vitest';
import {
  validatePluginManifest,
  extractCapabilities,
  canUse,
  declarationWantsDom,
} from '../src/plugin-permissions';

describe('validatePluginManifest', () => {
  it('should pass for a valid manifest with permissions', () => {
    const result = validatePluginManifest({
      id: 'test-plugin',
      permissions: ['fs', 'tools'],
      apiVersion: 2,
    });
    expect(result.errors).toHaveLength(0);
  });

  it('should fail when apiVersion 2 has no permissions', () => {
    const result = validatePluginManifest({
      id: 'test-plugin',
      apiVersion: 2,
    });
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]).toContain('permissions');
  });

  it('should warn for unknown permission families', () => {
    const result = validatePluginManifest({
      id: 'test',
      permissions: ['fs', 'unknown-family'],
      apiVersion: 2,
    });
    expect(result.warnings).toContain('unknown permission family: unknown-family');
  });

  it('should fail when no id or name', () => {
    const result = validatePluginManifest({});
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it('should pass for apiVersion 1 without permissions (legacy mode)', () => {
    const result = validatePluginManifest({
      id: 'legacy-plugin',
      apiVersion: 1,
    });
    expect(result.errors).toHaveLength(0);
  });
});

describe('extractCapabilities', () => {
  it('should extract families from manifest', () => {
    const caps = extractCapabilities({
      permissions: ['fs', 'tools', 'llm'],
      apiVersion: 2,
      netAllowlist: ['example.com'],
    });
    expect(caps.families.has('fs')).toBe(true);
    expect(caps.families.has('tools')).toBe(true);
    expect(caps.families.has('llm')).toBe(true);
    expect(caps.apiVersion).toBe(2);
    expect(caps.netAllowlist).toEqual(['example.com']);
  });

  it('should default to apiVersion 1 and empty families', () => {
    const caps = extractCapabilities({});
    expect(caps.apiVersion).toBe(1);
    expect(caps.families.size).toBe(0);
    expect(caps.netAllowlist).toEqual([]);
  });
});

describe('canUse', () => {
  it('should allow everything in legacy mode (apiVersion 1, no permissions)', () => {
    const caps = extractCapabilities({ apiVersion: 1 });
    expect(canUse(caps, 'fs')).toBe(true);
    expect(canUse(caps, 'tools')).toBe(true);
    expect(canUse(caps, 'llm')).toBe(true);
  });

  it('should deny unlisted families in strict mode', () => {
    const caps = extractCapabilities({ permissions: ['fs'], apiVersion: 2 });
    expect(canUse(caps, 'tools')).toBe(false);
    expect(canUse(caps, 'llm')).toBe(false);
  });

  it('should allow listed families in strict mode', () => {
    const caps = extractCapabilities({ permissions: ['fs', 'tools'], apiVersion: 2 });
    expect(canUse(caps, 'fs')).toBe(true);
    expect(canUse(caps, 'tools')).toBe(true);
  });

  it('should allow fs:read when fs is declared', () => {
    const caps = extractCapabilities({ permissions: ['fs'], apiVersion: 2 });
    expect(canUse(caps, 'fs:read')).toBe(true);
    expect(canUse(caps, 'fs:write')).toBe(true);
  });

  it('should allow dom:anchor when dom is declared', () => {
    const caps = extractCapabilities({ permissions: ['dom'], apiVersion: 2 });
    expect(canUse(caps, 'dom:anchor')).toBe(true);
  });
});

describe('declarationWantsDom', () => {
  it('should return true when dom is in permissions', () => {
    expect(declarationWantsDom(['fs', 'dom'])).toBe(true);
  });

  it('should return true when dom:anchor is in permissions', () => {
    expect(declarationWantsDom(['dom:anchor'])).toBe(true);
  });

  it('should return false when dom is not in permissions', () => {
    expect(declarationWantsDom(['fs', 'tools'])).toBe(false);
  });

  it('should return false for undefined permissions', () => {
    expect(declarationWantsDom(undefined)).toBe(false);
  });
});
