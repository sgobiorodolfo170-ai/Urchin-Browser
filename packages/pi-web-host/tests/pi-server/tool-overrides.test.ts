/**
 * tool-overrides.ts 单元测试（移植自上游 pi-web-ui tests/unit/tool-overrides.test.ts）
 *
 * 覆盖：扩展注册表同名实现查找、fallback/composeWith 选择、注入顺序、
 * 幂等重放、结构不兼容时的静默降级，以及 onComposed 回调。
 */
/* eslint-disable @typescript-eslint/require-await -- 移植自上游 pi-web-ui 的 async 桩保持原形状 */
import { describe, expect, it, vi } from 'vitest';
import {
  extensionToolDefinition,
  installToolOverrides,
  isExtensionToolProvided,
  syncSubagentOverride,
  type AnyToolDefinition,
  type OverrideSessionLike,
} from '../../src/pi-server/tool-overrides.js';

function tool(name: string, marker = ''): AnyToolDefinition {
  return {
    name,
    label: name,
    description: `desc:${name}${marker}`,
    parameters: { type: 'object', properties: {} },
    async execute() {
      return { content: [{ type: 'text', text: `ran:${name}${marker}` }] };
    },
  };
}

function makeSession(
  extensionTools: { definition: AnyToolDefinition }[] = [],
  customTools: AnyToolDefinition[] = [],
): { session: OverrideSessionLike; refreshes: string[][] } {
  const refreshes: string[][] = [];
  const session: OverrideSessionLike = {
    extensionRunner: { getAllRegisteredTools: () => extensionTools },
    _customTools: [...customTools],
    _refreshToolRegistry() {
      refreshes.push((session._customTools ?? []).map((t) => t.name));
    },
  };
  return { session, refreshes };
}

describe('extensionToolDefinition', () => {
  it('should read the same-named implementation from the extension registry', () => {
    const ext = tool('read', ':ext');
    const { session } = makeSession([{ definition: ext }]);
    expect(extensionToolDefinition(session, 'read')).toBe(ext);
    expect(extensionToolDefinition(session, 'edit')).toBeUndefined();
  });

  it('should return undefined when the registry is missing without throwing', () => {
    expect(extensionToolDefinition({}, 'read')).toBeUndefined();
    expect(extensionToolDefinition({ extensionRunner: {} }, 'read')).toBeUndefined();
  });

  it('should detect whether an extension provides a tool', () => {
    const ext = tool('bash', ':ext');
    const { session } = makeSession([{ definition: ext }]);
    expect(isExtensionToolProvided(session, 'bash')).toBe(true);
    expect(isExtensionToolProvided(session, 'read')).toBe(false);
  });
});

describe('installToolOverrides', () => {
  it('should compose with the extension tool when one exists', () => {
    const ext = tool('read', ':ext');
    const composed = tool('read', ':composed');
    const { session, refreshes } = makeSession([{ definition: ext }]);
    const composeWith = vi.fn(() => composed);
    const names = installToolOverrides(session, [
      { name: 'read', fallback: () => tool('read', ':builtin'), composeWith },
    ]);
    expect(names).toEqual(['read']);
    expect(composeWith).toHaveBeenCalledWith(ext);
    expect(session._customTools).toEqual([composed]);
    expect(refreshes).toHaveLength(1);
  });

  it('should use the fallback when no extension tool exists', () => {
    const builtin = tool('read', ':builtin');
    const { session } = makeSession();
    const composeWith = vi.fn();
    installToolOverrides(session, [{ name: 'read', fallback: () => builtin, composeWith }]);
    expect(composeWith).not.toHaveBeenCalled();
    expect(session._customTools).toEqual([builtin]);
  });

  it('should leave the extension tool alone when no composeWith is given', () => {
    const ext = tool('read', ':ext');
    const { session } = makeSession([{ definition: ext }], [tool('bash')]);
    installToolOverrides(session, [{ name: 'read', fallback: () => tool('read', ':builtin') }]);
    expect((session._customTools ?? []).map((t) => t.name)).toEqual(['bash']);
  });

  it('should inject overrides before existing custom tools', () => {
    const { session } = makeSession([], [tool('bash'), tool('plugin_x')]);
    installToolOverrides(session, [
      { name: 'read', fallback: () => tool('read') },
      { name: 'write', fallback: () => tool('write') },
    ]);
    expect((session._customTools ?? []).map((t) => t.name)).toEqual([
      'read',
      'write',
      'bash',
      'plugin_x',
    ]);
  });

  it('should stay idempotent and refresh the registry on every install', () => {
    const { session, refreshes } = makeSession();
    installToolOverrides(session, [{ name: 'read', fallback: () => tool('read') }]);
    installToolOverrides(session, [{ name: 'read', fallback: () => tool('read') }]);
    expect((session._customTools ?? []).filter((t) => t.name === 'read')).toHaveLength(1);
    expect(refreshes).toHaveLength(2);
  });

  it('should return null when the session shape is incompatible', () => {
    expect(installToolOverrides({}, [])).toBeNull();
    expect(installToolOverrides({ _customTools: [] }, [])).toBeNull();
  });

  it('should invoke onComposed when an extension tool was composed', () => {
    const extBash = tool('bash', ':ext-reviewer');
    const composedBash = tool('bash', ':composed-reviewer');
    const { session } = makeSession([{ definition: extBash }]);
    const composeWith = vi.fn(() => composedBash);
    const onComposed = vi.fn();

    const names = installToolOverrides(
      session,
      [{ name: 'bash', fallback: () => tool('bash', ':builtin'), composeWith }],
      { onComposed },
    );

    expect(names).toEqual(['bash']);
    expect(composeWith).toHaveBeenCalledWith(extBash);
    expect(onComposed).toHaveBeenCalledWith('bash', extBash);
    expect(session._customTools).toEqual([composedBash]);
  });

  it('should not invoke onComposed when no extension tool matched', () => {
    const { session } = makeSession();
    const builtinBash = tool('bash', ':builtin');
    const onComposed = vi.fn();

    installToolOverrides(
      session,
      [{ name: 'bash', fallback: () => builtinBash, composeWith: (base) => base }],
      { onComposed },
    );

    expect(onComposed).not.toHaveBeenCalled();
    expect(session._customTools).toEqual([builtinBash]);
  });

  it('should swallow onComposed errors instead of failing the install', () => {
    const ext = tool('read', ':ext');
    const composed = tool('read', ':composed');
    const { session } = makeSession([{ definition: ext }]);
    const onComposed = vi.fn(() => {
      throw new Error('callback boom');
    });
    const names = installToolOverrides(
      session,
      [{ name: 'read', fallback: () => tool('read'), composeWith: () => composed }],
      { onComposed },
    );
    expect(names).toEqual(['read']);
    expect(session._customTools).toEqual([composed]);
  });
});

describe('syncSubagentOverride', () => {
  it('should drop both conversation overrides when subagents are disabled', () => {
    const { session, refreshes } = makeSession(
      [{ definition: tool('conversation') }, { definition: tool('subagent') }],
      [tool('conversation'), tool('subagent'), tool('bash')],
    );
    syncSubagentOverride(session, true);
    expect((session._customTools ?? []).map((t) => t.name)).toEqual(['bash']);
    expect(refreshes).toHaveLength(1);
  });

  it('should re-add freshly built overrides when subagents are enabled again', () => {
    const { session, refreshes } = makeSession(
      [{ definition: tool('conversation') }, { definition: tool('subagent') }],
      [tool('bash')],
    );
    const factory = vi.fn((name: string) => tool(name, ':rebuilt'));
    syncSubagentOverride(session, false, factory);
    expect(factory.mock.calls.map((c) => c[0])).toEqual(['conversation', 'subagent']);
    expect((session._customTools ?? []).map((t) => t.description)).toEqual([
      'desc:subagent:rebuilt',
      'desc:conversation:rebuilt',
      'desc:bash',
    ]);
    expect(refreshes).toHaveLength(1);
  });

  it('should leave the custom tools untouched when no extension provides them', () => {
    const { session, refreshes } = makeSession([], [tool('bash')]);
    const factory = vi.fn((name: string) => tool(name));
    syncSubagentOverride(session, false, factory);
    expect(factory).not.toHaveBeenCalled();
    expect((session._customTools ?? []).map((t) => t.name)).toEqual(['bash']);
    expect(refreshes).toHaveLength(0);
  });

  it('should not refresh when nothing actually changed', () => {
    const { session, refreshes } = makeSession(
      [{ definition: tool('conversation') }],
      [tool('bash')],
    );
    syncSubagentOverride(session, true);
    expect(refreshes).toHaveLength(0);
    syncSubagentOverride(session, false);
    expect(refreshes).toHaveLength(0);
  });

  it('should ignore sessions with an incompatible shape', () => {
    expect(() => syncSubagentOverride({}, true)).not.toThrow();
    expect(() => syncSubagentOverride({ _customTools: [] }, false)).not.toThrow();
  });
});
