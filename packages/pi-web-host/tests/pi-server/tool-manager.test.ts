/**
 * tool-manager.ts 单元测试（移植自上游 pi-web-ui tests/unit/tool-manager.test.ts）
 *
 * 覆盖：工具目录声明（核心 / 可开关 / 群组）、平台感知、默认禁用集合、
 * 旧存档开关迁移、tool_manage 出入口、预设语义与终端引导注入判定。
 */
import { describe, expect, it } from 'vitest';
import {
  AGENT_TOOL_CATALOG,
  ASK_USER_QUESTION_TOOL_NAME,
  CLAIM_FILES_TOOL_NAME,
  CODEMODE_TOOL_NAME,
  COMPACT_CONTEXT_TOOL_NAME,
  CONVERSATION_READ_TOOL_NAME,
  LSP_TOOL_NAME,
  MCP_MANAGE_TOOL_NAME,
  SANDBOX_TOOL_NAME,
  PATCH_TOOL_NAME,
  PLAN_UPDATE_TOOL_NAME,
  PRESENT_FILES_TOOL_NAME,
  SKILL_TOOL_NAME,
  ALL_AGENT_TOOL_ENTRIES,
  CORE_BUILTIN_TOOL_NAMES,
  CORE_TOOL_CATALOG,
  getAgentToolEntry,
  isToolSupportedOnPlatform,
  applyAgentToolsGating,
  defaultDisabledAgentTools,
  deriveLegacy,
  effectiveDisabledAgentTools,
  EVAL_TOOL_NAME,
  GROUP_BOT_TOOL_CATALOG,
  foldLegacyIntoDisabled,
  isAgentToolEnabled,
  isKnownAgentTool,
  isHostManagedTool,
  isConfigurableAgentTool,
  isCoreBuiltinTool,
  lazyLoadingDisabledTools,
  localizedDescription,
  localizedName,
  isTerminalGuidanceOn,
  legacyToDisabled,
  normalizeDisabledAgentTools,
  filterToolsByPreset,
  presetAllowsPluginTools,
  presetHasQuestionnaire,
  presetShowsSkillCatalog,
  setAgentToolEnabled,
  setAgentToolsEnabled,
  SUBAGENT_TOOL_NAMES,
  TERMINAL_TOOL_NAMES,
  LEGACY_TERMINAL_TOOL_NAMES,
  resolveDisabledAgentToolsFromEnabled,
  resolveEnabledAgentTools,
  TOOL_SEARCH_TOOL_NAME,
} from '../../src/pi-server/tool-manager.js';

describe('legacy terminal allowlists', () => {
  it('should migrate legacy terminal switches and explicit allowlists conservatively', () => {
    for (const name of LEGACY_TERMINAL_TOOL_NAMES) {
      expect(normalizeDisabledAgentTools([name])).toEqual(['terminal']);
      expect(resolveEnabledAgentTools([name])).not.toContain('terminal');
      expect(resolveDisabledAgentToolsFromEnabled([name])).toContain('terminal');
    }
    expect(resolveDisabledAgentToolsFromEnabled([...LEGACY_TERMINAL_TOOL_NAMES])).not.toContain(
      'terminal',
    );
    expect(resolveDisabledAgentToolsFromEnabled(['terminal'])).not.toContain('terminal');
  });
});

function fakeSet(initial: string[] = []) {
  let names = [...initial];
  return {
    getActiveToolNames: () => [...names],
    getAllTools: () => [...initial].map((name) => ({ name })),
    setActiveToolsByName: (next: string[]) => {
      names = [...next];
    },
    peek: () => names,
  };
}

describe('catalog', () => {
  it('should declare all 8 core tools with powershell off by default', () => {
    expect(CORE_TOOL_CATALOG).toHaveLength(8);
    expect(CORE_TOOL_CATALOG.map((c) => c.name)).toEqual([...CORE_BUILTIN_TOOL_NAMES]);
    const ps = CORE_TOOL_CATALOG.find((c) => c.name === 'powershell');
    expect(ps?.defaultOn).toBe(false);
    expect(CORE_TOOL_CATALOG.filter((c) => c.name !== 'powershell').every((c) => c.defaultOn)).toBe(
      true,
    );
  });

  it('should aggregate core, togglable and group catalogs and derive defaults declaratively', () => {
    expect(ALL_AGENT_TOOL_ENTRIES.map((tool) => tool.name)).toEqual(
      [...CORE_TOOL_CATALOG, ...AGENT_TOOL_CATALOG, ...GROUP_BOT_TOOL_CATALOG].map(
        (tool) => tool.name,
      ),
    );
    const expectedOff = ALL_AGENT_TOOL_ENTRIES.filter((t) => !t.defaultOn).map((t) => t.name);
    expect(defaultDisabledAgentTools()).toEqual(expectedOff);
  });

  it('should gate powershell to win32 and keep other tools cross-platform', () => {
    expect(isToolSupportedOnPlatform('powershell', 'win32')).toBe(true);
    expect(isToolSupportedOnPlatform('powershell', 'linux')).toBe(false);
    expect(isToolSupportedOnPlatform('powershell', 'darwin')).toBe(false);
    expect(isToolSupportedOnPlatform('bash', 'linux')).toBe(true);
    expect(isToolSupportedOnPlatform('bash', 'win32')).toBe(true);
    expect(getAgentToolEntry('powershell')?.platform).toBe('win32');
    expect(getAgentToolEntry('bash')?.platform).toBeUndefined();
  });

  it('should mark core tools as not agent-togglable to prevent self-lockout', () => {
    expect(getAgentToolEntry('bash')?.allowAgentToggle).toBe(false);
    expect(getAgentToolEntry('read')?.allowAgentToggle).toBe(false);
    expect(getAgentToolEntry('powershell')?.allowAgentToggle).toBe(false);
    expect(isKnownAgentTool('bash')).toBe(false);
    expect(isKnownAgentTool('powershell')).toBe(false);
    expect(isKnownAgentTool('subagent')).toBe(true);
    expect(isKnownAgentTool('edit_soft')).toBe(true);
  });

  it('should register unique names and keep conversation compatibility aliases', () => {
    expect(new Set(AGENT_TOOL_CATALOG.map((tool) => tool.name)).size).toBe(
      AGENT_TOOL_CATALOG.length,
    );
    expect(TERMINAL_TOOL_NAMES).toEqual(['terminal']);
    expect(SUBAGENT_TOOL_NAMES).toEqual(['conversation', 'subagent']);
  });

  it('should keep terminal group, edit_soft and eval off by default', () => {
    const off = new Set(defaultDisabledAgentTools());
    for (const n of TERMINAL_TOOL_NAMES) expect(off.has(n)).toBe(true);
    expect(off.has('edit_soft')).toBe(true);
    expect(off.has(EVAL_TOOL_NAME)).toBe(true);
    expect(off.has(LSP_TOOL_NAME)).toBe(true);
    expect(off.has(CODEMODE_TOOL_NAME)).toBe(true);
    expect(off.has(TOOL_SEARCH_TOOL_NAME)).toBe(true);
    expect(off.has(MCP_MANAGE_TOOL_NAME)).toBe(true);
    expect(off.has('powershell')).toBe(true);
    expect(off.has(PATCH_TOOL_NAME)).toBe(false);
    expect(off.has(SANDBOX_TOOL_NAME)).toBe(false);
    for (const n of SUBAGENT_TOOL_NAMES) expect(off.has(n)).toBe(false);
    expect(off.has('delegate_task')).toBe(false);
    expect(off.has(ASK_USER_QUESTION_TOOL_NAME)).toBe(false);
    expect(off.has(CONVERSATION_READ_TOOL_NAME)).toBe(false);
    expect(off.has(SKILL_TOOL_NAME)).toBe(false);
    expect(off.has(PRESENT_FILES_TOOL_NAME)).toBe(false);
    expect(off.has(CLAIM_FILES_TOOL_NAME)).toBe(false);
    expect(off.has(PLAN_UPDATE_TOOL_NAME)).toBe(false);
    expect(off.has(COMPACT_CONTEXT_TOOL_NAME)).toBe(false);
  });
});

describe('normalize', () => {
  it('should fall back to defaults for non-arrays and keep only known unique names', () => {
    expect(normalizeDisabledAgentTools(undefined)).toEqual(defaultDisabledAgentTools());
    expect(normalizeDisabledAgentTools(['edit_soft', 'nope', 'edit_soft', 42])).toEqual([
      'edit_soft',
    ]);
  });

  it('should migrate the three legacy schedule tools into the merged schedule tool', () => {
    for (const legacy of ['schedule_task', 'schedule_list', 'schedule_cancel']) {
      expect(normalizeDisabledAgentTools([legacy])).toEqual(['schedule']);
    }
    expect(normalizeDisabledAgentTools(['schedule_task', 'schedule_list'])).toEqual(['schedule']);
    expect(normalizeDisabledAgentTools(['schedule'])).toEqual(['schedule']);
  });

  it('should distinguish host-managed tools from external ones', () => {
    expect(isHostManagedTool('bash')).toBe(true);
    expect(isHostManagedTool('read')).toBe(true);
    expect(isHostManagedTool('edit_soft')).toBe(true);
    expect(isHostManagedTool('subagent')).toBe(true);
    expect(isHostManagedTool('url_context')).toBe(false);
    expect(isHostManagedTool('unknown_external_tool')).toBe(false);

    expect(isConfigurableAgentTool('bash')).toBe(true);
    expect(isConfigurableAgentTool('url_context')).toBe(false);
  });

  it('should resolve isKnownAgentTool and isAgentToolEnabled consistently', () => {
    expect(isKnownAgentTool('subagent')).toBe(true);
    expect(isKnownAgentTool('bash')).toBe(false);
    expect(isAgentToolEnabled('edit_soft', ['edit_soft'])).toBe(false);
    expect(isAgentToolEnabled('edit_soft', [])).toBe(true);
  });
});

describe('legacy sync', () => {
  it('should fold legacy-only switches exactly like before the merge', () => {
    const d = legacyToDisabled({});
    for (const n of TERMINAL_TOOL_NAMES) expect(d).toContain(n);
    expect(d).toContain('edit_soft');
    expect(d).toContain('powershell');
    expect(d).not.toContain(ASK_USER_QUESTION_TOOL_NAME);
    expect(legacyToDisabled({ disabledAgentTools: [], terminalToolsEnabled: false })).toEqual([]);
  });

  it('should backfill legacy flags requiring the whole terminal group to be on', () => {
    expect(deriveLegacy([])).toEqual({
      terminalToolsEnabled: true,
      editSoftEnabled: true,
      questionnaireEnabled: true,
    });
    const partial = deriveLegacy([TERMINAL_TOOL_NAMES[0]]);
    expect(partial.terminalToolsEnabled).toBe(false);
    expect(partial.editSoftEnabled).toBe(true);
  });

  it('should only touch the groups covered by foldLegacyIntoDisabled', () => {
    const cur = ['edit_soft', 'subagent'];
    expect(foldLegacyIntoDisabled(cur, { terminalToolsEnabled: false })).toEqual([
      'edit_soft',
      'conversation',
      'subagent',
      ...TERMINAL_TOOL_NAMES,
    ]);
    expect(foldLegacyIntoDisabled(['edit_soft'], { editSoftEnabled: true })).toEqual([]);
    expect(foldLegacyIntoDisabled(['edit_soft'], {})).toEqual(['edit_soft']);
  });

  it('should merge the questionnaire alias as a double safeguard', () => {
    expect(
      effectiveDisabledAgentTools({ disabledAgentTools: [], questionnaireEnabled: false }),
    ).toContain(ASK_USER_QUESTION_TOOL_NAME);
    expect(effectiveDisabledAgentTools({ disabledAgentTools: [] })).not.toContain(
      ASK_USER_QUESTION_TOOL_NAME,
    );
  });

  it('should inject terminal guidance only when the group has an enabled tool', () => {
    expect(isTerminalGuidanceOn([])).toBe(true);
    expect(isTerminalGuidanceOn([...TERMINAL_TOOL_NAMES])).toBe(false);
    expect(isTerminalGuidanceOn([TERMINAL_TOOL_NAMES[0]])).toBe(false);
  });
});

describe('tool_manage entry points', () => {
  it('should toggle a single tool and reject unknown names or broken sessions', () => {
    const s = fakeSet(['edit_soft', 'bash']);
    expect(setAgentToolEnabled(s, 'edit_soft', false)).toBe(true);
    expect(s.peek()).toEqual(['bash']);
    expect(setAgentToolEnabled(s, 'edit_soft', true)).toBe(true);
    expect(s.peek()).toEqual(['bash', 'edit_soft']);
    expect(setAgentToolEnabled(s, 'bash', false)).toBe(false);
    expect(setAgentToolEnabled(s, 'nope', true)).toBe(false);
    const broken = {
      getActiveToolNames: () => {
        throw new Error('not ready');
      },
      getAllTools: () => {
        throw new Error('not ready');
      },
      setActiveToolsByName: () => undefined,
    };
    expect(setAgentToolEnabled(broken, 'edit_soft', true)).toBe(false);
  });

  it('should toggle tool groups in bulk and return the processed count', () => {
    const s = fakeSet();
    expect(setAgentToolsEnabled(s, [...TERMINAL_TOOL_NAMES], true)).toBe(1);
    expect(s.peek()).toEqual([...TERMINAL_TOOL_NAMES]);
    expect(setAgentToolsEnabled(s, ['bash'], true)).toBe(0);
  });

  it('should replay the full catalog while leaving external tools untouched', () => {
    const s = fakeSet(['bash', 'read']);
    applyAgentToolsGating(s, []);
    const names = s.peek();
    expect(names).toContain('bash');
    expect(names).toContain('read');
    for (const t of AGENT_TOOL_CATALOG) expect(names).toContain(t.name);
    const s2 = fakeSet(['bash', 'edit_soft', 'subagent']);
    applyAgentToolsGating(
      s2,
      AGENT_TOOL_CATALOG.map((t) => t.name),
    );
    expect(s2.peek()).toEqual(['bash']);

    let activeWithExtension = ['bash', 'read'];
    const sessionWithExtension = {
      getActiveToolNames: () => [...activeWithExtension],
      getAllTools: () => ['bash', 'read', 'url_context'].map((name) => ({ name })),
      setActiveToolsByName: (next: string[]) => {
        activeWithExtension = [...next];
      },
    };
    applyAgentToolsGating(sessionWithExtension, []);
    expect(activeWithExtension).not.toContain('url_context');
    expect(activeWithExtension).toContain('bash');
    expect(activeWithExtension).toContain('read');
  });

  it('should apply lazy-loading exclusions without reactivating extension-disabled tools', () => {
    let active = ['bash', 'read', 'mcp__files__read', 'url_context', 'loaded_tool'];
    const all = [...active, 'extension_disabled', 'load_tools'];
    const session = {
      getAllTools: () => all.map((name) => ({ name })),
      getActiveToolNames: () => [...active],
      setActiveToolsByName: (names: string[]) => {
        active = names;
      },
    };
    const disabled = lazyLoadingDisabledTools(all, ['loaded_tool']);
    applyAgentToolsGating(session, disabled, undefined, { forceActive: ['load_tools'] });
    expect(active).toContain('loaded_tool');
    expect(active).toContain('load_tools');
    expect(active).not.toContain('mcp__files__read');
    expect(active).not.toContain('url_context');
    expect(active).not.toContain('extension_disabled');
    applyAgentToolsGating(session, []);
    expect(active).not.toContain('extension_disabled');
  });

  it('should force-activate tools outside the preset whitelist but not when disabled', () => {
    const s = fakeSet(['bash', 'read', 'load_tools']);
    applyAgentToolsGating(s, [], 'code');
    expect(s.peek()).not.toContain('load_tools');
    const s2 = fakeSet(['bash', 'read', 'load_tools']);
    applyAgentToolsGating(s2, [], 'code', { forceActive: ['load_tools'] });
    expect(s2.peek()).toContain('load_tools');

    const s3 = fakeSet(['bash', 'read', 'load_tools']);
    applyAgentToolsGating(s3, []);
    expect(s3.peek()).not.toContain('load_tools');

    const s4 = fakeSet(['bash', 'read', 'load_tools']);
    applyAgentToolsGating(s4, [], undefined, { forceActive: ['load_tools'] });
    expect(s4.peek()).toContain('load_tools');

    const s5 = fakeSet(['bash', 'read', 'load_tools']);
    applyAgentToolsGating(s5, ['load_tools'], undefined, { forceActive: ['load_tools'] });
    expect(s5.peek()).not.toContain('load_tools');
  });

  it('should treat everything except core, loaded and load_tools as temporarily disabled', () => {
    const all = ['bash', 'read', 'edit', 'write', 'load_tools', 'patch', 'lsp'];
    expect(lazyLoadingDisabledTools(all, [])).toEqual(['patch', 'lsp']);
    expect(lazyLoadingDisabledTools(all, ['patch'])).toEqual(['lsp']);
    expect(lazyLoadingDisabledTools(all, ['patch', 'lsp'])).toEqual([]);
    expect(lazyLoadingDisabledTools(['bash'], ['patch'])).toEqual([]);
  });
});

describe('preset semantics', () => {
  it('should allow plugin tools only in standard mode', () => {
    expect(presetAllowsPluginTools(undefined)).toBe(true);
    expect(presetAllowsPluginTools('standard')).toBe(true);
    for (const p of ['minimal', 'code', 'reader', 'ask'])
      expect(presetAllowsPluginTools(p)).toBe(false);
    expect(presetAllowsPluginTools('nope')).toBe(true);
  });

  it('should derive skill catalog visibility from the same single filter', () => {
    expect(presetShowsSkillCatalog(undefined)).toBe(true);
    expect(presetShowsSkillCatalog('standard')).toBe(true);
    expect(presetShowsSkillCatalog('reader')).toBe(true);
    for (const p of ['minimal', 'code', 'ask']) expect(presetShowsSkillCatalog(p)).toBe(false);
    for (const p of [undefined, 'standard', 'minimal', 'code', 'reader', 'ask']) {
      expect(presetShowsSkillCatalog(p)).toBe(
        filterToolsByPreset([SKILL_TOOL_NAME], p).includes(SKILL_TOOL_NAME),
      );
    }
  });

  it('should offer the questionnaire only in standard and reader presets', () => {
    expect(presetHasQuestionnaire(undefined)).toBe(true);
    expect(presetHasQuestionnaire('standard')).toBe(true);
    expect(presetHasQuestionnaire('reader')).toBe(true);
    for (const p of ['minimal', 'code', 'ask']) expect(presetHasQuestionnaire(p)).toBe(false);
    expect(presetHasQuestionnaire('nope')).toBe(true);
  });

  it('should skip terminal guidance when the preset removes terminal tools', () => {
    expect(isTerminalGuidanceOn([])).toBe(true);
    expect(isTerminalGuidanceOn([], 'minimal')).toBe(false);
    expect(isTerminalGuidanceOn([], 'code')).toBe(false);
    expect(isTerminalGuidanceOn([], 'ask')).toBe(false);
    expect(isTerminalGuidanceOn([], 'reader')).toBe(true);
    expect(isTerminalGuidanceOn([...TERMINAL_TOOL_NAMES], 'standard')).toBe(false);
    expect(isTerminalGuidanceOn([...TERMINAL_TOOL_NAMES], 'reader')).toBe(false);
    expect(isTerminalGuidanceOn([TERMINAL_TOOL_NAMES[0]])).toBe(false);
  });

  it('should filter tools by each preset exactly as documented', () => {
    const all = [
      'bash',
      'read',
      'edit',
      'write',
      'edit_soft',
      'powershell',
      'terminal',
      'codemode',
      'skill',
    ];
    expect(filterToolsByPreset(all, undefined)).toEqual(all);
    expect(filterToolsByPreset(all, 'standard')).toEqual(all);
    expect(filterToolsByPreset(all, 'ask')).toEqual([]);
    expect(filterToolsByPreset(all, 'minimal')).toEqual(['bash', 'read']);
    expect(filterToolsByPreset(all, 'code')).toEqual([
      'bash',
      'read',
      'edit',
      'write',
      'edit_soft',
    ]);
    expect(filterToolsByPreset(all, 'reader')).toEqual(['read', 'terminal', 'skill']);
    expect(filterToolsByPreset(all, 'nope')).toEqual(all);
  });
});

describe('localization helpers', () => {
  it('should pick the zh name and fall back through nameEn', () => {
    expect(localizedName({ name: '中文', nameEn: 'EN' }, 'zh')).toBe('中文');
    expect(localizedName({ nameEn: 'EN' }, 'zh')).toBe('EN');
    expect(localizedName({ name: '中文' }, 'zh')).toBe('中文');
    expect(localizedName(undefined, 'zh', 'fallback')).toBe('fallback');
    expect(localizedName({}, 'zh', 'fallback')).toBe('fallback');
  });

  it('should pick the en name and fall back through name', () => {
    expect(localizedName({ name: '中文', nameEn: 'EN' }, 'en')).toBe('EN');
    expect(localizedName({ name: '中文' }, 'en')).toBe('中文');
    expect(localizedName(undefined, 'en', 'fallback')).toBe('fallback');
  });

  it('should resolve descriptions the same way', () => {
    expect(localizedDescription(undefined, 'zh')).toBeUndefined();
    expect(localizedDescription({ description: '中文', descriptionEn: 'EN' }, 'zh')).toBe('中文');
    expect(localizedDescription({ descriptionEn: 'EN' }, 'zh')).toBe('EN');
    expect(localizedDescription({ description: '中文', descriptionEn: 'EN' }, 'en')).toBe('EN');
    expect(localizedDescription({ description: '中文' }, 'en')).toBe('中文');
  });
});

describe('aliases and core detection', () => {
  it('should expand conversation aliases into the whole subagent group', () => {
    expect(normalizeDisabledAgentTools(['conversation'])).toEqual(['conversation', 'subagent']);
    expect(normalizeDisabledAgentTools(['subagent'])).toEqual(['conversation', 'subagent']);
    expect(normalizeDisabledAgentTools(['conversation_read'])).toEqual([
      'conversation',
      'subagent',
    ]);
    expect(normalizeDisabledAgentTools(['conversation', 'subagent'])).toEqual([
      'conversation',
      'subagent',
    ]);
  });

  it('should recognize core builtin tool names', () => {
    expect(isCoreBuiltinTool('bash')).toBe(true);
    expect(isCoreBuiltinTool('powershell')).toBe(true);
    expect(isCoreBuiltinTool('find')).toBe(true);
    expect(isCoreBuiltinTool('edit_soft')).toBe(false);
    expect(isCoreBuiltinTool('')).toBe(false);
  });

  it('should fall back to all tools for unknown presets in filterToolsByPreset', () => {
    expect(filterToolsByPreset([], 'minimal')).toEqual([]);
    expect(filterToolsByPreset([], undefined)).toEqual([]);
    expect(filterToolsByPreset([], 'ask')).toEqual([]);
  });
});

describe('gating edge cases', () => {
  it('should keep disabled conversation tools that an extension still provides', () => {
    let active: string[] = ['bash'];
    const session = {
      getActiveToolNames: () => [...active],
      getAllTools: () => ['bash', 'conversation', 'subagent'].map((name) => ({ name })),
      setActiveToolsByName: (names: string[]) => {
        active = [...names];
      },
      extensionRunner: {
        getAllRegisteredTools: () => [{ definition: { name: 'conversation' } }],
      },
    };
    applyAgentToolsGating(session, ['conversation', 'subagent']);
    expect(active).toContain('conversation');
    expect(active).not.toContain('subagent');
  });

  it('should defer MCP tools but keep tool_search, and keep direct-exposure MCP tools', () => {
    let active: string[] = [];
    const tools = [
      { name: 'bash' },
      { name: 'read' },
      { name: 'tool_search' },
      { name: 'mcp__deferred__x', namespace: { name: 'mcp__deferred' }, exposure: 'deferred' },
      { name: 'mcp__direct__y', namespace: { name: 'mcp__direct' }, exposure: 'direct' },
    ];
    const session = {
      getActiveToolNames: () => [
        'bash',
        'read',
        'tool_search',
        'mcp__deferred__x',
        'mcp__direct__y',
      ],
      getAllTools: () => tools,
      setActiveToolsByName: (names: string[]) => {
        active = [...names];
      },
    };
    applyAgentToolsGating(session, []);
    expect(active).toContain('tool_search');
    expect(active).toContain('mcp__direct__y');
    expect(active).not.toContain('mcp__deferred__x');
  });

  it('should swallow errors from a broken session when gating', () => {
    const session = {
      getActiveToolNames: () => [],
      getAllTools: () => {
        throw new Error('not ready');
      },
      setActiveToolsByName: () => undefined,
    };
    expect(() => applyAgentToolsGating(session, [])).not.toThrow();
  });

  it('should return 0 from setAgentToolsEnabled when every name is unknown', () => {
    const s = fakeSet();
    expect(setAgentToolsEnabled(s, ['nope', 'still-nope'], true)).toBe(0);
    expect(s.peek()).toEqual([]);
  });
});
