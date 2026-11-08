/**
 * tool-prompt-overrides.ts 单元测试（移植自上游 pi-web-ui tests/unit/tool-prompt-overrides.test.ts）
 *
 * 覆盖：单条覆盖归一化（裁剪/去空/上限）、覆盖表归一化（旧版 terminal 迁移、
 * 未知工具过滤、条数上限）、覆盖查找、有效提示词合成，以及向会话打补丁
 * （description / snippet / guidelines + 活跃集重建）与结构不兼容降级。
 */
import { describe, expect, it } from 'vitest';
import {
  TOOL_PROMPT_DESCRIPTION_CAP,
  TOOL_PROMPT_GUIDELINE_CAP,
  TOOL_PROMPT_GUIDELINE_MAX,
  TOOL_PROMPT_OVERRIDE_MAX,
  applyToolPromptOverrides,
  effectiveToolPrompt,
  normalizeToolPromptOverride,
  normalizeToolPromptOverrides,
  toolPromptOverrideOf,
  type ToolPromptSessionLike,
} from '../../src/pi-server/tool-prompt-overrides.js';

describe('legacy migration', () => {
  it('should migrate legacy terminal overrides deterministically before filtering known names', () => {
    expect(
      normalizeToolPromptOverrides(
        { terminal_read: { description: 'read' }, terminal_create: { description: 'create' } },
        ['terminal'],
      ),
    ).toEqual({ terminal: { description: 'create' } });
    expect(
      normalizeToolPromptOverrides(
        { terminal: { description: 'merged' }, terminal_create: { description: 'create' } },
        ['terminal'],
      ),
    ).toEqual({ terminal: { description: 'merged' } });
  });

  it('should mirror conversation overrides onto the subagent alias and back', () => {
    expect(
      normalizeToolPromptOverrides({ subagent: { description: 'shared' } }, [
        'conversation',
        'subagent',
      ]),
    ).toEqual({
      conversation: { description: 'shared' },
      subagent: { description: 'shared' },
    });
  });
});

function fakeSession() {
  const registry = new Map<string, { name?: string; description?: string }>([
    ['bash', { name: 'bash', description: 'default bash' }],
    ['read', { name: 'read', description: 'default read' }],
  ]);
  const definitions = new Map<
    string,
    { definition: { description?: string; promptSnippet?: string; promptGuidelines?: string[] } }
  >([
    [
      'bash',
      {
        definition: {
          description: 'default bash',
          promptSnippet: 'run shell',
          promptGuidelines: ['g1'],
        },
      },
    ],
    [
      'read',
      {
        definition: {
          description: 'default read',
          promptSnippet: 'read files',
          promptGuidelines: ['r1'],
        },
      },
    ],
  ]);
  const snippets = new Map<string, string>([
    ['bash', 'run shell'],
    ['read', 'read files'],
  ]);
  const guidelines = new Map<string, string[]>([
    ['bash', ['g1']],
    ['read', ['r1']],
  ]);
  return {
    session: {
      _toolRegistry: registry,
      _toolDefinitions: definitions,
      _toolPromptSnippets: snippets,
      _toolPromptGuidelines: guidelines,
    } as ToolPromptSessionLike,
    registry,
    snippets,
    guidelines,
  };
}

describe('normalizeToolPromptOverride', () => {
  it('should keep only non-empty fields and return null for an all-empty object', () => {
    expect(
      normalizeToolPromptOverride({
        description: '  x  ',
        promptSnippet: '',
        promptGuidelines: [],
      }),
    ).toEqual({ description: 'x' });
    expect(normalizeToolPromptOverride({ description: '   ' })).toBeNull();
    expect(normalizeToolPromptOverride(null)).toBeNull();
    expect(normalizeToolPromptOverride('x')).toBeNull();
  });

  it('should trim guidelines, drop blanks and keep order', () => {
    expect(
      normalizeToolPromptOverride({ promptGuidelines: [' a ', '', 'b'] })?.promptGuidelines,
    ).toEqual(['a', 'b']);
  });

  it('should truncate an over-long description to the cap', () => {
    const long = 'x'.repeat(TOOL_PROMPT_DESCRIPTION_CAP + 100);
    expect(normalizeToolPromptOverride({ description: long })?.description?.length).toBe(
      TOOL_PROMPT_DESCRIPTION_CAP,
    );
  });

  it('should cap the guideline count', () => {
    const many = Array.from({ length: TOOL_PROMPT_GUIDELINE_MAX + 20 }, (_, i) => `g${i}`);
    expect(
      normalizeToolPromptOverride({ promptGuidelines: many })?.promptGuidelines?.length,
    ).toBeLessThanOrEqual(TOOL_PROMPT_GUIDELINE_MAX);
  });

  it('should stop collecting guidelines once the total length cap is reached', () => {
    const half = 'x'.repeat(TOOL_PROMPT_GUIDELINE_CAP - 10);
    const out = normalizeToolPromptOverride({ promptGuidelines: [half, half] });
    expect(out?.promptGuidelines).toEqual([half]);
  });
});

describe('normalizeToolPromptOverrides', () => {
  it('should drop empty entries, blank keys and invalid values', () => {
    expect(
      normalizeToolPromptOverrides({
        bash: { description: 'b' },
        read: {},
        '  ': { description: 'x' },
        '': { description: 'y' },
        bad: 3,
      }),
    ).toEqual({ bash: { description: 'b' } });
  });

  it('should return an empty map for non-objects', () => {
    expect(normalizeToolPromptOverrides(null)).toEqual({});
    expect(normalizeToolPromptOverrides(['a'])).toEqual({});
  });

  it('should filter against a known-tool allowlist', () => {
    expect(
      normalizeToolPromptOverrides(
        { bash: { description: 'b' }, read: { description: 'r' } },
        new Set(['bash']),
      ),
    ).toEqual({ bash: { description: 'b' } });
  });

  it('should cap the number of normalized overrides', () => {
    const raw: Record<string, unknown> = {};
    for (let i = 0; i < TOOL_PROMPT_OVERRIDE_MAX + 5; i++)
      raw[`tool_${i}`] = { description: `d${i}` };
    expect(Object.keys(normalizeToolPromptOverrides(raw))).toHaveLength(TOOL_PROMPT_OVERRIDE_MAX);
  });
});

describe('toolPromptOverrideOf', () => {
  it('should return null for missing or empty overrides and the override otherwise', () => {
    expect(toolPromptOverrideOf(undefined, 'bash')).toBeNull();
    expect(toolPromptOverrideOf({}, 'bash')).toBeNull();
    expect(toolPromptOverrideOf({ bash: {} }, 'bash')).toBeNull();
    expect(toolPromptOverrideOf({ bash: { description: 'x' } }, 'bash')).toEqual({
      description: 'x',
    });
  });
});

describe('effectiveToolPrompt', () => {
  it('should prefer override fields and fall back to defaults', () => {
    const base = { description: 'd', promptSnippet: 's', promptGuidelines: ['a'] };
    expect(effectiveToolPrompt(base, null)).toEqual(base);
    expect(effectiveToolPrompt(base, { description: 'D' })).toEqual({
      description: 'D',
      promptSnippet: 's',
      promptGuidelines: ['a'],
    });
  });

  it('should copy the guideline array instead of aliasing the override', () => {
    const base = { description: 'd' };
    const override = { promptGuidelines: ['a'] };
    const out = effectiveToolPrompt(base, override);
    out.promptGuidelines?.push('b');
    expect(override.promptGuidelines).toEqual(['a']);
  });
});

describe('applyToolPromptOverrides', () => {
  it('should patch description, snippet and guidelines in one pass', () => {
    const { session, registry, snippets, guidelines } = fakeSession();
    const applied = applyToolPromptOverrides(session, {
      bash: { description: 'custom bash', promptSnippet: 'run it', promptGuidelines: ['gg'] },
    });
    expect(applied).toEqual(['bash']);
    expect(registry.get('bash')!.description).toBe('custom bash');
    expect(snippets.get('bash')).toBe('run it');
    expect(guidelines.get('bash')).toEqual(['gg']);
    expect(registry.get('read')!.description).toBe('default read');
    expect(snippets.get('read')).toBe('read files');
  });

  it('should be idempotent and restore factory defaults when overrides are cleared', () => {
    const { session, registry, snippets, guidelines } = fakeSession();
    applyToolPromptOverrides(session, { bash: { description: 'custom' } });
    applyToolPromptOverrides(session, { bash: { description: 'custom2', promptSnippet: 's2' } });
    expect(registry.get('bash')!.description).toBe('custom2');
    expect(snippets.get('bash')).toBe('s2');
    applyToolPromptOverrides(session, {});
    expect(registry.get('bash')!.description).toBe('default bash');
    expect(snippets.get('bash')).toBe('run shell');
    expect(guidelines.get('bash')).toEqual(['g1']);
  });

  it('should return null when the session internals do not match', () => {
    expect(applyToolPromptOverrides({}, { bash: { description: 'x' } })).toBeNull();
    expect(applyToolPromptOverrides(undefined, { bash: { description: 'x' } })).toBeNull();
    expect(applyToolPromptOverrides({ _toolRegistry: new Map() }, {})).toBeNull();
  });

  it('should rebuild system-prompt options from the current active set', () => {
    const { session } = fakeSession();
    const setCalls: string[][] = [];
    session.getActiveToolNames = () => ['bash', 'read'];
    session.setActiveToolsByName = (names) => setCalls.push(names);
    applyToolPromptOverrides(session, { bash: { promptSnippet: 's' } });
    expect(setCalls).toEqual([['bash', 'read']]);
  });

  it('should swallow errors thrown while rebuilding the active set', () => {
    const { session } = fakeSession();
    session.getActiveToolNames = () => {
      throw new Error('not ready');
    };
    session.setActiveToolsByName = () => undefined;
    expect(applyToolPromptOverrides(session, { bash: { promptSnippet: 's' } })).toEqual(['bash']);
  });
});

describe('alias lookup and factory reset of empty prompts', () => {
  it('should resolve legacy terminal overrides through the alias-aware lookup', () => {
    expect(toolPromptOverrideOf({ terminal_create: { description: 'x' } }, 'terminal')).toEqual({
      description: 'x',
    });
    expect(toolPromptOverrideOf({ conversation: { description: 'c' } }, 'subagent')).toEqual({
      description: 'c',
    });
  });

  it('should delete stale snippet/guideline entries when neither override nor base provides them', () => {
    const registry = new Map<string, { name?: string; description?: string }>([
      ['bare', { name: 'bare' }],
    ]);
    const definitions = new Map<
      string,
      { definition: { description?: string; promptSnippet?: string; promptGuidelines?: string[] } }
    >([['bare', { definition: { description: 'd' } }]]);
    const snippets = new Map<string, string>([['bare', 'stale']]);
    const guidelines = new Map<string, string[]>([['bare', ['stale']]]);
    const applied = applyToolPromptOverrides(
      {
        _toolRegistry: registry,
        _toolDefinitions: definitions,
        _toolPromptSnippets: snippets,
        _toolPromptGuidelines: guidelines,
      },
      {},
    );
    expect(applied).toEqual([]);
    expect(snippets.has('bare')).toBe(false);
    expect(guidelines.has('bare')).toBe(false);
    expect(registry.get('bare')?.description).toBe('d');
  });
});
