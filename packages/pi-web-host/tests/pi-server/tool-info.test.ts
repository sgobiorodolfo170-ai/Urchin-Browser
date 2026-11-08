/**
 * tool-info.ts 单元测试
 *
 * 覆盖 tool_info 载荷的归一化：空定义 / 字段裁剪（label 200、description 与
 * promptSnippet 8000、guidelines 总量 8000）、parameters 超限丢弃标记、
 * active 只认布尔、sourceInfo 提取，以及 unsupported 载荷语义。
 */
import { describe, expect, it } from 'vitest';
import {
  TOOL_DESCRIPTION_CAP,
  TOOL_GUIDELINES_CAP,
  TOOL_PARAMETERS_CAP,
  normalizeToolInfo,
  unsupportedToolInfo,
} from '../../src/pi-server/tool-info.js';

describe('normalizeToolInfo', () => {
  it('should report found=false for missing or non-object definitions', () => {
    expect(normalizeToolInfo('bash')).toEqual({ name: 'bash', found: false });
    expect(normalizeToolInfo('bash', null)).toEqual({ name: 'bash', found: false });
    expect(normalizeToolInfo('bash', 'nope' as never)).toEqual({ name: 'bash', found: false });
  });

  it('should trim the tool name and fall back to an empty string', () => {
    expect(normalizeToolInfo('  bash  ', {}).name).toBe('bash');
    expect(normalizeToolInfo(42 as never, {}).name).toBe('');
    expect(normalizeToolInfo('   ', {}).name).toBe('');
  });

  it('should keep label, description and promptSnippet when non-empty', () => {
    const payload = normalizeToolInfo('bash', {
      label: ' Shell ',
      description: ' run commands ',
      promptSnippet: ' bash: run ',
    });
    expect(payload).toEqual({
      name: 'bash',
      found: true,
      label: 'Shell',
      description: 'run commands',
      promptSnippet: 'bash: run',
    });
  });

  it('should omit empty string fields', () => {
    const payload = normalizeToolInfo('bash', {
      label: '   ',
      description: '\n',
      promptSnippet: '',
    });
    expect(payload).toEqual({ name: 'bash', found: true });
    expect('label' in payload).toBe(false);
    expect('description' in payload).toBe(false);
    expect('promptSnippet' in payload).toBe(false);
  });

  it('should truncate the label to 200 characters with an ellipsis', () => {
    const payload = normalizeToolInfo('bash', { label: 'L'.repeat(250) });
    expect(payload.label).toHaveLength(201);
    expect(payload.label?.endsWith('…')).toBe(true);
  });

  it('should truncate description and promptSnippet to their caps', () => {
    const long = 'D'.repeat(TOOL_DESCRIPTION_CAP + 50);
    const payload = normalizeToolInfo('bash', { description: long, promptSnippet: long });
    expect(payload.description?.length).toBe(TOOL_DESCRIPTION_CAP + 1);
    expect(payload.promptSnippet?.length).toBe(TOOL_DESCRIPTION_CAP + 1);
  });

  it('should drop blank guidelines and keep order', () => {
    const payload = normalizeToolInfo('bash', { promptGuidelines: [' g1 ', '', 42, 'g2'] });
    expect(payload.promptGuidelines).toEqual(['g1', 'g2']);
  });

  it('should stop collecting guidelines once the total cap would be exceeded', () => {
    const half = 'x'.repeat(Math.floor(TOOL_GUIDELINES_CAP / 2) + 10);
    const payload = normalizeToolInfo('bash', { promptGuidelines: [half, half, half] });
    expect(payload.promptGuidelines).toEqual([half]);
  });

  it('should omit promptGuidelines when nothing usable is left', () => {
    expect(
      normalizeToolInfo('bash', { promptGuidelines: ['  ', ''] }).promptGuidelines,
    ).toBeUndefined();
    expect(
      normalizeToolInfo('bash', { promptGuidelines: 'nope' }).promptGuidelines,
    ).toBeUndefined();
  });

  it('should keep parameters that serialize within the cap', () => {
    const parameters = { type: 'object', properties: { a: { type: 'string' } } };
    expect(normalizeToolInfo('bash', { parameters }).parameters).toEqual(parameters);
    expect(normalizeToolInfo('bash', { parameters }).parametersDropped).toBeUndefined();
  });

  it('should drop parameters that exceed the cap and set parametersDropped', () => {
    const parameters = { blob: 'x'.repeat(TOOL_PARAMETERS_CAP) };
    const payload = normalizeToolInfo('bash', { parameters });
    expect(payload.parameters).toBeUndefined();
    expect(payload.parametersDropped).toBe(true);
  });

  it('should mark parametersDropped when parameters cannot be serialized', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const payload = normalizeToolInfo('bash', { parameters: circular });
    expect(payload.parametersDropped).toBe(true);
  });

  it('should ignore null or undefined parameters entirely', () => {
    expect('parameters' in normalizeToolInfo('bash', { parameters: null })).toBe(false);
    expect('parametersDropped' in normalizeToolInfo('bash', { parameters: undefined })).toBe(false);
  });

  it('should only accept boolean active flags', () => {
    expect(normalizeToolInfo('bash', { active: true }).active).toBe(true);
    expect(normalizeToolInfo('bash', { active: false }).active).toBe(false);
    expect('active' in normalizeToolInfo('bash', { active: 'yes' })).toBe(false);
    expect('active' in normalizeToolInfo('bash', { active: 1 })).toBe(false);
  });

  it('should extract source and scope from sourceInfo', () => {
    const payload = normalizeToolInfo('bash', {
      sourceInfo: { source: ' builtin ', scope: ' user ' },
    });
    expect(payload.source).toBe('builtin');
    expect(payload.scope).toBe('user');
  });

  it('should ignore malformed sourceInfo', () => {
    expect('source' in normalizeToolInfo('bash', { sourceInfo: 'nope' })).toBe(false);
    expect('source' in normalizeToolInfo('bash', { sourceInfo: {} })).toBe(false);
    expect('scope' in normalizeToolInfo('bash', { sourceInfo: { source: 1, scope: null } })).toBe(
      false,
    );
  });
});

describe('unsupportedToolInfo', () => {
  it('should mark the payload as not found and unsupported', () => {
    expect(unsupportedToolInfo('bash')).toEqual({ name: 'bash', found: false, unsupported: true });
  });

  it('should trim the name and tolerate junk values', () => {
    expect(unsupportedToolInfo('  read ').name).toBe('read');
    expect(unsupportedToolInfo(undefined as never).name).toBe('');
    expect(unsupportedToolInfo(7 as never).name).toBe('');
  });
});

describe('caps', () => {
  it('should expose the documented cap constants', () => {
    expect(TOOL_PARAMETERS_CAP).toBe(64_000);
    expect(TOOL_DESCRIPTION_CAP).toBe(8_000);
    expect(TOOL_GUIDELINES_CAP).toBe(8_000);
  });
});
