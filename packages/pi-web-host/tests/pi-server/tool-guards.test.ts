/**
 * tool-guards.ts 单元测试
 *
 * 移植自上游 pi-web-ui：
 * - tests/unit/tool-guards.test.ts（取消传播 / 审批闸门 / 插件守卫）
 * - tests/unit/patch-permission.test.ts（patch 权限与审批）
 *
 * 追加覆盖各权限包装器（write / edit / edit_soft / bash）的 read-only、
 * workspace-write-never、用户拒绝与「用户改写」路径。
 *
 * `@earendil-works/pi-coding-agent` 是 vendored 包（构建期 esbuild 别名），
 * vitest 无法解析；这里只提供包装器在「无 base」分支才用到的工厂桩，
 * 所有用例都显式传 base，桩不会被调用。
 */
/* eslint-disable @typescript-eslint/require-await -- 移植自上游 pi-web-ui 的 async 桩保持原形状 */
import { describe, expect, it, vi } from 'vitest';
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import type { ApprovalRule } from '../../src/pi-server/approval-rules.js';
import {
  APPROVAL_GUARDED,
  isInsideWorkspaceRoots,
  makeLateToolGuard,
  withApprovalGate,
  withDelegationGate,
  withGoalReviewGate,
  withPlanModeGate,
  withToolGuard,
  wrapBashToolWithPermission,
  wrapEditSoftToolWithPermission,
  wrapEditToolWithPermission,
  wrapPatchToolWithPermission,
  wrapWriteToolWithPermission,
  type AskApprovalFn,
  type ToolGuardHook,
} from '../../src/pi-server/tool-guards.js';

vi.mock('@earendil-works/pi-coding-agent', () => ({
  createWriteToolDefinition: () => {
    throw new Error('createWriteToolDefinition stub must not be called');
  },
  createEditToolDefinition: () => {
    throw new Error('createEditToolDefinition stub must not be called');
  },
}));

const cwd = process.cwd();
const result = () => ({ content: [{ type: 'text' as const, text: 'ok' }] });
function base(name = 'write') {
  const execute = vi.fn(async () => result());
  return { tool: { name, execute } as unknown as ToolDefinition, execute };
}
function run(tool: ToolDefinition, signal: AbortSignal) {
  return tool.execute(
    'call',
    { path: '.env', content: 'x', patch: '[.env#abcd]\nPUT 1.=1:\n+x\n' },
    signal,
    undefined,
    {},
  );
}
const wrappers: Record<string, (tool: ToolDefinition, ask: AskApprovalFn) => ToolDefinition> = {
  write: (tool, ask) =>
    wrapWriteToolWithPermission(
      cwd,
      () => 'danger-full-access',
      () => [],
      () => 'en',
      ask,
      () => 'conv',
      undefined,
      tool,
    ),
  edit: (tool, ask) =>
    wrapEditToolWithPermission(
      cwd,
      () => 'danger-full-access',
      () => [],
      () => 'en',
      ask,
      () => 'conv',
      undefined,
      tool,
    ),
  edit_soft: (tool, ask) =>
    wrapEditSoftToolWithPermission(
      tool,
      cwd,
      () => 'danger-full-access',
      () => [],
      () => 'en',
      ask,
      () => 'conv',
    ),
  patch: (tool, ask) =>
    wrapPatchToolWithPermission(
      tool,
      cwd,
      () => 'danger-full-access',
      () => [],
      () => 'en',
      ask,
      () => 'conv',
    ),
  generic: (tool, ask) =>
    withApprovalGate(tool, {
      cwd: () => cwd,
      getLang: () => 'en',
      askApproval: ask,
      conversationId: () => 'conv',
    }),
  plugin: (tool, ask) =>
    withToolGuard(tool, {
      toolName: 'read',
      guard: {
        pre: async () => ({ verdict: { decision: 'ask' } }),
        post: async () => undefined,
      },
      cwd,
      getLang: () => 'en',
      askApproval: ask,
      conversationId: () => 'conv',
    }),
};

describe('tool guard cancellation', () => {
  for (const [name, wrap] of Object.entries(wrappers)) {
    it(`should never open an approval or execute an already cancelled ${name} call`, async () => {
      const controller = new AbortController();
      controller.abort();
      const { tool, execute } = base(
        name === 'generic' ? 'write' : name === 'plugin' ? 'read' : name,
      );
      const ask = vi.fn<AskApprovalFn>(async () => ({ decision: 'approve' }));
      await expect(run(wrap(tool, ask), controller.signal)).rejects.toMatchObject({
        name: 'AbortError',
      });
      expect(ask).not.toHaveBeenCalled();
      expect(execute).not.toHaveBeenCalled();
    });

    it(`should forward the signal and stop when ${name} approval resolves during cancellation`, async () => {
      const controller = new AbortController();
      const { tool, execute } = base(
        name === 'generic' ? 'write' : name === 'plugin' ? 'read' : name,
      );
      const ask = vi.fn<AskApprovalFn>(async (...args) => {
        expect(args[8]).toBe(controller.signal);
        await Promise.resolve();
        controller.abort();
        return { decision: 'approve' };
      });
      await expect(run(wrap(tool, ask), controller.signal)).rejects.toMatchObject({
        name: 'AbortError',
      });
      expect(ask).toHaveBeenCalledOnce();
      expect(execute).not.toHaveBeenCalled();
    });
  }

  for (const phase of ['pre', 'execute', 'post'] as const) {
    for (const rejects of [false, true]) {
      it(`should not swallow abort in ${phase} (rejects=${rejects})`, async () => {
        const controller = new AbortController();
        const pause = async () => {
          await Promise.resolve();
          controller.abort();
          if (rejects) throw controller.signal.reason;
        };
        const { tool, execute } = base('read');
        if (phase === 'execute') {
          execute.mockImplementation(async () => {
            await pause();
            return result();
          });
        }
        const guard: ToolGuardHook = {
          pre: vi.fn(async () => {
            if (phase === 'pre') await pause();
            return { verdict: { decision: 'allow' as const } };
          }),
          post: vi.fn(async () => {
            if (phase === 'post') await pause();
            return undefined;
          }),
        };
        await expect(
          run(
            withToolGuard(tool, { toolName: 'read', guard, getLang: () => 'en' }),
            controller.signal,
          ),
        ).rejects.toMatchObject({ name: 'AbortError' });
        if (phase === 'pre') expect(execute).not.toHaveBeenCalled();
        if (phase !== 'post') expect(guard.post).not.toHaveBeenCalled();
      });
    }
  }

  it('should not create an approval after a suspended pre hook is cancelled', async () => {
    const controller = new AbortController();
    const { tool, execute } = base('read');
    const ask = vi.fn<AskApprovalFn>(async () => ({ decision: 'approve' }));
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const guard: ToolGuardHook = {
      pre: async () => {
        await pending;
        return { verdict: { decision: 'ask' } };
      },
      post: async () => undefined,
    };
    const running = run(
      withToolGuard(tool, { toolName: 'read', guard, askApproval: ask, getLang: () => 'en' }),
      controller.signal,
    );
    controller.abort();
    release();
    await expect(running).rejects.toMatchObject({ name: 'AbortError' });
    expect(ask).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it('should reject cancelled passthroughs in mode gates and the bash wrapper', async () => {
    const controller = new AbortController();
    controller.abort();
    const { tool, execute } = base('read');
    for (const wrapped of [
      withPlanModeGate(
        tool,
        () => false,
        () => 'en',
      ),
      withGoalReviewGate(
        tool,
        () => false,
        () => 'en',
      ),
      withDelegationGate(
        tool,
        () => false,
        () => 'en',
      ),
      wrapBashToolWithPermission(
        tool,
        () => 'danger-full-access',
        () => 'en',
      ),
    ]) {
      await expect(run(wrapped, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    }
    expect(execute).not.toHaveBeenCalled();
  });
});

describe('mode gates', () => {
  it('should deny write tools inside plan mode with a plan-mode error', async () => {
    const { tool, execute } = base('write');
    const wrapped = withPlanModeGate(
      tool,
      () => true,
      () => 'en',
    );
    await expect(
      wrapped.execute('call', { path: 'src/a.ts' }, undefined, undefined, {}),
    ).rejects.toMatchObject({ details: { guardDenied: true, planModeDenied: true } });
    expect(execute).not.toHaveBeenCalled();
  });

  it('should pass read-only tools through plan mode', async () => {
    const { tool, execute } = base('read');
    const wrapped = withPlanModeGate(
      tool,
      () => true,
      () => 'en',
    );
    const res = (await wrapped.execute('call', { path: 'src/a.ts' }, undefined, undefined, {})) as {
      isError?: boolean;
    };
    expect(res.isError).toBeUndefined();
    expect(execute).toHaveBeenCalledOnce();
  });

  it('should deny user questions during a goal review round', async () => {
    const { tool, execute } = base('ask_user_question');
    const wrapped = withGoalReviewGate(
      tool,
      () => true,
      () => 'zh',
    );
    const res = (await wrapped.execute('call', { question: 'x' }, undefined, undefined, {})) as {
      isError?: boolean;
      details?: Record<string, unknown>;
    };
    expect(res.isError).toBe(true);
    expect(res.details?.goalReviewDenied).toBe(true);
    expect(execute).not.toHaveBeenCalled();
  });

  it('should deny dispatching tools in delegate mode', async () => {
    const { tool, execute } = base('write');
    const wrapped = withDelegationGate(
      tool,
      () => true,
      () => 'en',
    );
    const res = (await wrapped.execute('call', { path: 'src/a.ts' }, undefined, undefined, {})) as {
      isError?: boolean;
      details?: Record<string, unknown>;
    };
    expect(res.isError).toBe(true);
    expect(res.details?.delegateDenied).toBe(true);
    expect(execute).not.toHaveBeenCalled();
  });
});

describe('withApprovalGate', () => {
  it('should return the same definition when the tool is already guarded', async () => {
    const { tool } = base('write');
    const opts = { cwd: () => cwd, getLang: () => 'en' as const };
    const once = withApprovalGate(tool, opts);
    expect(withApprovalGate(once, opts)).toBe(once);
    expect((once as unknown as Record<symbol, unknown>)[APPROVAL_GUARDED]).toBe(true);
  });

  it('should block rule-denied calls without asking and report to the audit sink', async () => {
    const { tool, execute } = base('write');
    const ask = vi.fn<AskApprovalFn>(async () => ({ decision: 'approve' }));
    const onAudit = vi.fn();
    const denyRule: ApprovalRule = {
      id: 'test.deny-escape',
      enabled: true,
      tools: ['write'],
      field: 'path',
      match: 'contains',
      value: 'escape',
      action: 'deny',
      label: 'no escape',
      labelEn: 'no escape',
      reason: 'blocked by test rule',
      reasonEn: 'blocked by test rule',
    };
    const wrapped = withApprovalGate(tool, {
      cwd: () => cwd,
      getLang: () => 'en',
      askApproval: ask,
      getRules: () => [denyRule],
      onAudit,
    });
    const res = (await wrapped.execute(
      'call',
      { path: '../escape.txt' },
      undefined,
      undefined,
      {},
    )) as { isError?: boolean; details?: Record<string, unknown> };
    expect(res.isError).toBe(true);
    expect(res.details?.ruleDenied).toBe(true);
    expect(ask).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
    expect(onAudit).toHaveBeenCalledWith(
      expect.objectContaining({ decision: 'denied', decisionSource: 'rule_denied' }),
    );
  });

  it('should run the tool after the user approves a dangerous write', async () => {
    const { tool, execute } = base('write');
    const ask = vi.fn<AskApprovalFn>(async () => ({ decision: 'approve' }));
    const wrapped = withApprovalGate(tool, {
      cwd: () => cwd,
      getLang: () => 'en',
      askApproval: ask,
    });
    const res = (await wrapped.execute('call', { path: '.env' }, undefined, undefined, {})) as {
      isError?: boolean;
    };
    expect(ask).toHaveBeenCalledOnce();
    expect(res.isError).toBeUndefined();
    expect(execute).toHaveBeenCalledOnce();
  });

  it('should not execute when the user denies a dangerous write', async () => {
    const { tool, execute } = base('write');
    const ask = vi.fn<AskApprovalFn>(async () => ({ decision: 'deny', reason: 'nope' }));
    const wrapped = withApprovalGate(tool, {
      cwd: () => cwd,
      getLang: () => 'en',
      askApproval: ask,
    });
    const res = (await wrapped.execute('call', { path: '.env' }, undefined, undefined, {})) as {
      isError?: boolean;
      details?: Record<string, unknown>;
    };
    expect(res.isError).toBe(true);
    expect(res.details?.userDenied).toBe(true);
    expect(execute).not.toHaveBeenCalled();
  });

  it('should execute with edited params when the user edits the call', async () => {
    const { tool, execute } = base('write');
    const ask = vi.fn<AskApprovalFn>(async () => ({
      decision: 'edit',
      editedParams: { path: 'safe.txt', content: 'edited' },
    }));
    const wrapped = withApprovalGate(tool, {
      cwd: () => cwd,
      getLang: () => 'en',
      askApproval: ask,
    });
    await wrapped.execute('call', { path: '.env' }, undefined, undefined, {});
    expect(execute).toHaveBeenCalledWith(
      'call',
      { path: 'safe.txt', content: 'edited' },
      undefined,
      undefined,
      {},
    );
  });
});

describe('withToolGuard', () => {
  it('should return the original tool when there is no guard and no approval', () => {
    const { tool } = base('read');
    expect(withToolGuard(tool, { toolName: 'read', getLang: () => 'en' })).toBe(tool);
  });

  it('should block a pre-hook denial without executing', async () => {
    const { tool, execute } = base('read');
    const guard: ToolGuardHook = {
      pre: async () => ({ verdict: { decision: 'deny', reason: 'blocked', reasonEn: 'blocked' } }),
      post: async () => undefined,
    };
    const wrapped = withToolGuard(tool, { toolName: 'read', guard, getLang: () => 'en' });
    const res = (await wrapped.execute('call', {}, undefined, undefined, {})) as {
      isError?: boolean;
      details?: Record<string, unknown>;
    };
    expect(res.isError).toBe(true);
    expect(res.details?.guardDenied).toBe(true);
    expect(execute).not.toHaveBeenCalled();
  });

  it('should treat an ask verdict as a denial when no approval handler exists', async () => {
    const { tool, execute } = base('read');
    const guard: ToolGuardHook = {
      pre: async () => ({ verdict: { decision: 'ask', reason: 'confirm' } }),
      post: async () => undefined,
    };
    const wrapped = withToolGuard(tool, { toolName: 'read', guard, getLang: () => 'en' });
    const res = (await wrapped.execute('call', {}, undefined, undefined, {})) as {
      isError?: boolean;
    };
    expect(res.isError).toBe(true);
    expect(execute).not.toHaveBeenCalled();
  });

  it('should fall back to allow when the pre hook throws', async () => {
    const { tool, execute } = base('read');
    const guard: ToolGuardHook = {
      pre: async () => {
        throw new Error('boom');
      },
      post: async () => undefined,
    };
    const wrapped = withToolGuard(tool, { toolName: 'read', guard, getLang: () => 'en' });
    await wrapped.execute('call', {}, undefined, undefined, {});
    expect(execute).toHaveBeenCalledOnce();
  });

  it('should replace result content with the post hook content', async () => {
    const { tool } = base('read');
    const guard: ToolGuardHook = {
      pre: async () => ({ verdict: { decision: 'allow' } }),
      post: async () => ({ content: [{ type: 'text', text: 'rewritten' }], pluginIds: ['p'] }),
    };
    const wrapped = withToolGuard(tool, { toolName: 'read', guard, getLang: () => 'en' });
    const res = (await wrapped.execute('call', {}, undefined, undefined, {})) as {
      content: { text?: string }[];
    };
    expect(res.content[0]?.text).toBe('rewritten');
  });

  it('should ignore a throwing post hook and keep the original result', async () => {
    const { tool } = base('read');
    const guard: ToolGuardHook = {
      pre: async () => ({ verdict: { decision: 'allow' } }),
      post: async () => {
        throw new Error('post boom');
      },
    };
    const wrapped = withToolGuard(tool, { toolName: 'read', guard, getLang: () => 'en' });
    const res = (await wrapped.execute('call', {}, undefined, undefined, {})) as {
      content: { text?: string }[];
    };
    expect(res.content[0]?.text).toBe('ok');
  });

  it('should record user-edited params on the result details', async () => {
    const { tool } = base('read');
    const guard: ToolGuardHook = {
      pre: async () => ({ verdict: { decision: 'ask' } }),
      post: async () => undefined,
    };
    const ask = vi.fn<AskApprovalFn>(async () => ({
      decision: 'edit',
      editedParams: { path: 'other.txt' },
    }));
    const wrapped = withToolGuard(tool, {
      toolName: 'read',
      guard,
      getLang: () => 'en',
      askApproval: ask,
    });
    const res = (await wrapped.execute('call', { path: 'a.txt' }, undefined, undefined, {})) as {
      details?: Record<string, unknown>;
    };
    expect(res.details?.userEdited).toBe(true);
    expect(res.details?.originalParams).toEqual({ path: 'a.txt' });
    expect(res.details?.executedParams).toEqual({ path: 'other.txt' });
  });
});

describe('makeLateToolGuard', () => {
  it('should allow and return undefined when no guard is registered yet', async () => {
    const late = makeLateToolGuard(() => undefined);
    await expect(late.pre({ toolName: 'read', params: {} }, 'en')).resolves.toEqual({
      verdict: { decision: 'allow' },
    });
    await expect(
      late.post({ toolName: 'read', params: {}, result: undefined }, 'en'),
    ).resolves.toBeUndefined();
  });

  it('should delegate to the late-registered guard', async () => {
    const pre = vi.fn(async () => ({ verdict: { decision: 'deny' as const } }));
    const late = makeLateToolGuard(() => ({ pre, post: async () => undefined }));
    await expect(late.pre({ toolName: 'bash', params: {} }, 'en')).resolves.toEqual({
      verdict: { decision: 'deny' },
    });
    expect(pre).toHaveBeenCalledOnce();
  });
});

describe('isInsideWorkspaceRoots', () => {
  it('should accept paths inside the cwd and declared extra roots', () => {
    expect(isInsideWorkspaceRoots('src/a.ts', cwd)).toBe(true);
    expect(isInsideWorkspaceRoots('.', cwd)).toBe(true);
    expect(isInsideWorkspaceRoots('../outside.txt', cwd)).toBe(false);
  });

  it('should treat sibling directories of extra roots correctly', () => {
    const root = process.platform === 'win32' ? 'C:\\ws\\extra' : '/ws/extra';
    expect(isInsideWorkspaceRoots(`${root}/nested/a.ts`, cwd, [root])).toBe(true);
    expect(isInsideWorkspaceRoots(`${root}-evil/a.ts`, cwd, [root])).toBe(false);
  });
});

const CWD = process.platform === 'win32' ? 'C:\\ws\\proj' : '/ws/proj';

function makeBaseTool(name = 'patch') {
  const execute = vi.fn<(...args: unknown[]) => Promise<unknown>>(() =>
    Promise.resolve({ content: [{ type: 'text' as const, text: 'patch applied' }] }),
  );
  return { tool: { name, execute } as unknown as ToolDefinition, execute };
}

function wrapPatch(
  tool: ToolDefinition,
  opts: {
    permission?: string;
    roots?: string[];
    askApproval?: Parameters<typeof wrapPatchToolWithPermission>[5];
    rules?: ApprovalRule[];
  },
) {
  return wrapPatchToolWithPermission(
    tool,
    CWD,
    () => opts.permission ?? 'workspace-write-never',
    () => (opts.roots ?? []).map((r) => `${CWD}${r}`),
    () => 'zh',
    opts.askApproval,
    () => 'conv-1',
    opts.rules === undefined ? undefined : () => opts.rules!,
  );
}

async function runPatch(tool: ToolDefinition, patch: string) {
  const res = (await (
    tool as unknown as { execute: (id: string, p: unknown) => Promise<unknown> }
  ).execute('call-1', { patch })) as { isError?: boolean; content?: { text?: string }[] };
  return res;
}

const PATCH_OUTSIDE = '[../outside/evil.txt]\nPUT 1.=1:\n+x\n';
const PATCH_MV_OUTSIDE = '[src/a.ts#abcd]\nMV ../moved/a.ts\nPUT 1.=1:\n+x\n';
const PATCH_NORMAL = '[src/a.ts#abcd]\nPUT 1.=1:\n+x\n';

describe('wrapPatchToolWithPermission', () => {
  it('should deny the whole patch in read-only mode without touching the base tool', async () => {
    const { tool, execute } = makeBaseTool();
    const res = await runPatch(wrapPatch(tool, { permission: 'read-only' }), PATCH_NORMAL);
    expect(res.isError).toBe(true);
    expect(execute).not.toHaveBeenCalled();
  });

  it('should reject an out-of-workspace section header and name the path', async () => {
    const { tool, execute } = makeBaseTool();
    const res = await runPatch(wrapPatch(tool, {}), PATCH_OUTSIDE);
    expect(res.isError).toBe(true);
    expect(res.content?.[0]?.text).toContain('../outside/evil.txt');
    expect(execute).not.toHaveBeenCalled();
  });

  it('should reject an out-of-workspace MV target', async () => {
    const { tool, execute } = makeBaseTool();
    const res = await runPatch(wrapPatch(tool, {}), PATCH_MV_OUTSIDE);
    expect(res.isError).toBe(true);
    expect(res.content?.[0]?.text).toContain('../moved/a.ts');
    expect(execute).not.toHaveBeenCalled();
  });

  it('should apply a normal in-workspace patch directly', async () => {
    const { tool, execute } = makeBaseTool();
    const res = await runPatch(wrapPatch(tool, {}), PATCH_NORMAL);
    expect(res.isError).toBeUndefined();
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('should ask before patching a sensitive file and stop when denied', async () => {
    const { tool, execute } = makeBaseTool();
    const ask = vi.fn<AskApprovalFn>(async () => ({ decision: 'deny' }));
    const res = await runPatch(
      wrapPatch(tool, { permission: 'danger-full-access', askApproval: ask }),
      '[.env#abcd]\nPUT 1.=1:\n+x\n',
    );
    expect(ask).toHaveBeenCalledTimes(1);
    expect(ask.mock.calls[0][1]).toBe('patch');
    expect(res.isError).toBe(true);
    expect(execute).not.toHaveBeenCalled();
  });

  it('should block immediately on a custom deny rule without asking', async () => {
    const { tool, execute } = makeBaseTool();
    const denyRule: ApprovalRule = {
      id: 'custom.test',
      enabled: true,
      tools: ['patch'],
      field: 'path',
      match: 'contains',
      value: 'secret.txt',
      action: 'deny',
      label: 'test',
      labelEn: 'test',
    };
    const ask = vi.fn(async () => ({ decision: 'approve' as const }));
    const res = await runPatch(
      wrapPatch(tool, { permission: 'danger-full-access', askApproval: ask, rules: [denyRule] }),
      '[config/secret.txt]\nPUT 1.=1:\n+x\n',
    );
    expect(res.isError).toBe(true);
    expect(ask).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it('should apply the patch after approval', async () => {
    const { tool, execute } = makeBaseTool();
    const ask = vi.fn(async () => ({ decision: 'approve' as const }));
    const res = await runPatch(
      wrapPatch(tool, { permission: 'danger-full-access', askApproval: ask }),
      '[.env#abcd]\nPUT 1.=1:\n+x\n',
    );
    expect(ask).toHaveBeenCalledTimes(1);
    expect(res.isError).toBeUndefined();
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('should use an edited patch and mark the result as user-edited', async () => {
    const { tool, execute } = makeBaseTool();
    const ask = vi.fn(async () => ({
      decision: 'edit' as const,
      editedParams: { patch: '[src/safe.ts#abcd]\nPUT 1.=1:\n+x\n' },
    }));
    const res = (await runPatch(
      wrapPatch(tool, { permission: 'danger-full-access', askApproval: ask }),
      '[.env#abcd]\nPUT 1.=1:\n+x\n',
    )) as { details?: Record<string, unknown> };
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0][1]).toEqual({
      patch: '[src/safe.ts#abcd]\nPUT 1.=1:\n+x\n',
    });
    expect(res.details?.userEdited).toBe(true);
  });

  it('should still pass an empty patch through to the engine', async () => {
    const { tool, execute } = makeBaseTool();
    const res = await runPatch(wrapPatch(tool, {}), '');
    expect(res.isError).toBeUndefined();
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('should fail closed when a non-empty patch cannot be parsed in workspace-write-never mode', async () => {
    // D2 回归：parseHashlinePatch 对畸形文本不抛错而是返回 []，targets 为空会让越界检查
    // 整体跳过；此时无法证明目标位于工作区内，必须拒绝而不是透传给引擎。
    const { tool, execute } = makeBaseTool();
    const res = await runPatch(wrapPatch(tool, {}), 'not a valid patch');
    expect(res.isError).toBe(true);
    expect(res.content?.[0]?.text).toContain('无法解析');
    expect(execute).not.toHaveBeenCalled();
  });

  it('should let an unparsable patch reach the engine outside workspace-write-never mode', async () => {
    const { tool, execute } = makeBaseTool();
    const res = await runPatch(
      wrapPatch(tool, { permission: 'danger-full-access' }),
      'not a valid patch',
    );
    expect(res.isError).toBeUndefined();
    expect(execute).toHaveBeenCalledTimes(1);
  });
});

function makeWriteLikeTool(name: string) {
  const execute = vi.fn<(...args: unknown[]) => Promise<unknown>>(() =>
    Promise.resolve({ content: [{ type: 'text' as const, text: `${name} applied` }] }),
  );
  return { tool: { name, execute } as unknown as ToolDefinition, execute };
}

async function runWriteLike(tool: ToolDefinition, params: unknown) {
  const res = (await (
    tool as unknown as { execute: (id: string, p: unknown) => Promise<unknown> }
  ).execute('call-1', params)) as {
    isError?: boolean;
    content?: { text?: string }[];
    details?: Record<string, unknown>;
  };
  return res;
}

describe('file tool permission wrappers', () => {
  const cases: {
    name: string;
    permission: string;
    wrap: (tool: ToolDefinition, permission: string, ask?: AskApprovalFn) => ToolDefinition;
  }[] = [
    {
      name: 'write',
      permission: 'read-only',
      wrap: (tool, permission, ask) =>
        wrapWriteToolWithPermission(
          CWD,
          () => permission,
          () => [],
          () => 'zh',
          ask,
          () => 'conv',
          undefined,
          tool,
        ),
    },
    {
      name: 'edit',
      permission: 'read-only',
      wrap: (tool, permission, ask) =>
        wrapEditToolWithPermission(
          CWD,
          () => permission,
          () => [],
          () => 'zh',
          ask,
          () => 'conv',
          undefined,
          tool,
        ),
    },
    {
      name: 'edit_soft',
      permission: 'read-only',
      wrap: (tool, permission, ask) =>
        wrapEditSoftToolWithPermission(
          tool,
          CWD,
          () => permission,
          () => [],
          () => 'zh',
          ask,
          () => 'conv',
        ),
    },
  ];

  for (const c of cases) {
    it(`should deny ${c.name} in read-only mode without executing`, async () => {
      const { tool, execute } = makeWriteLikeTool(c.name);
      const res = await runWriteLike(c.wrap(tool, c.permission), {
        path: 'src/a.ts',
        content: 'x',
      });
      expect(res.isError).toBe(true);
      expect(res.content?.[0]?.text).toContain('read-only');
      expect(execute).not.toHaveBeenCalled();
    });

    it(`should deny ${c.name} outside the workspace in workspace-write-never mode`, async () => {
      const { tool, execute } = makeWriteLikeTool(c.name);
      const res = await runWriteLike(c.wrap(tool, 'workspace-write-never'), {
        path: '../escape.txt',
        content: 'x',
      });
      expect(res.isError).toBe(true);
      expect(execute).not.toHaveBeenCalled();
    });

    it(`should run ${c.name} inside the workspace in workspace-write-never mode`, async () => {
      const { tool, execute } = makeWriteLikeTool(c.name);
      const res = await runWriteLike(c.wrap(tool, 'workspace-write-never'), {
        path: 'src/a.ts',
        content: 'x',
      });
      expect(res.isError).toBeUndefined();
      expect(execute).toHaveBeenCalledOnce();
    });

    it(`should ask before ${c.name} on a sensitive file and honour deny`, async () => {
      const { tool, execute } = makeWriteLikeTool(c.name);
      const ask = vi.fn<AskApprovalFn>(async () => ({ decision: 'deny', reason: 'no' }));
      const res = await runWriteLike(c.wrap(tool, 'danger-full-access', ask), {
        path: '.env',
        content: 'x',
      });
      expect(ask).toHaveBeenCalledOnce();
      expect(res.isError).toBe(true);
      expect(res.details?.userDenied).toBe(true);
      expect(execute).not.toHaveBeenCalled();
    });

    it(`should run ${c.name} after the user approves`, async () => {
      const { tool, execute } = makeWriteLikeTool(c.name);
      const ask = vi.fn<AskApprovalFn>(async () => ({ decision: 'approve' }));
      const res = await runWriteLike(c.wrap(tool, 'danger-full-access', ask), {
        path: '.env',
        content: 'x',
      });
      expect(res.isError).toBeUndefined();
      expect(execute).toHaveBeenCalledOnce();
    });
  }

  it('should deny bash in read-only mode and pass through otherwise', async () => {
    const { tool, execute } = makeBaseTool('bash');
    const denied = await runWriteLike(
      wrapBashToolWithPermission(
        tool,
        () => 'read-only',
        () => 'en',
      ),
      { command: 'ls' },
    );
    expect(denied.isError).toBe(true);
    expect(execute).not.toHaveBeenCalled();

    const allowed = await runWriteLike(
      wrapBashToolWithPermission(
        tool,
        () => 'danger-full-access',
        () => 'en',
      ),
      { command: 'ls' },
    );
    expect(allowed.isError).toBeUndefined();
    expect(execute).toHaveBeenCalledOnce();
  });

  it('should block write when a custom rule denies the target path', async () => {
    const rule: ApprovalRule = {
      id: 'custom.deny-write',
      enabled: true,
      tools: ['write'],
      field: 'path',
      match: 'prefix',
      value: 'secrets/',
      action: 'deny',
      label: 'secrets',
      labelEn: 'secrets',
    };
    const { tool, execute } = makeWriteLikeTool('write');
    const res = await runWriteLike(
      wrapWriteToolWithPermission(
        CWD,
        () => 'danger-full-access',
        () => [],
        () => 'en',
        vi.fn<AskApprovalFn>(async () => ({ decision: 'approve' })),
        () => 'conv',
        () => [rule],
        tool,
      ),
      { path: 'secrets/token.txt', content: 'x' },
    );
    expect(res.isError).toBe(true);
    expect(res.details?.ruleDenied).toBe(true);
    expect(execute).not.toHaveBeenCalled();
  });
});

describe('extra guard and wrapper branches', () => {
  it('should block a rule-denied call inside withToolGuard without executing', async () => {
    const { tool, execute } = base('bash');
    const guard: ToolGuardHook = {
      pre: async () => ({ verdict: { decision: 'allow' } }),
      post: async () => undefined,
    };
    const denyRule: ApprovalRule = {
      id: 'test.deny-rm',
      enabled: true,
      tools: ['bash'],
      field: 'command',
      match: 'contains',
      value: 'rm -rf',
      action: 'deny',
      label: 'no rm -rf',
      labelEn: 'no rm -rf',
    };
    const wrapped = withToolGuard(tool, {
      toolName: 'bash',
      guard,
      cwd,
      getLang: () => 'en',
      askApproval: vi.fn<AskApprovalFn>(async () => ({ decision: 'approve' })),
      getRules: () => [denyRule],
    });
    const res = (await (wrapped.execute as (...args: unknown[]) => Promise<unknown>)(
      'call',
      { command: 'rm -rf /tmp/x' },
      undefined,
      undefined,
      {},
    )) as { isError?: boolean; details?: Record<string, unknown> };
    expect(res.isError).toBe(true);
    expect(res.details?.ruleDenied).toBe(true);
    expect(execute).not.toHaveBeenCalled();
  });

  it('should ask for a dangerous bash call inside withToolGuard and honour denial', async () => {
    const { tool, execute } = base('bash');
    const guard: ToolGuardHook = {
      pre: async () => ({ verdict: { decision: 'allow' } }),
      post: async () => undefined,
    };
    const ask = vi.fn<AskApprovalFn>(async () => ({ decision: 'deny', reason: 'too risky' }));
    const wrapped = withToolGuard(tool, {
      toolName: 'bash',
      guard,
      cwd,
      getLang: () => 'en',
      askApproval: ask,
    });
    const res = (await (wrapped.execute as (...args: unknown[]) => Promise<unknown>)(
      'call',
      { command: 'rm -rf /' },
      undefined,
      undefined,
      {},
    )) as { isError?: boolean; details?: Record<string, unknown> };
    expect(ask).toHaveBeenCalledOnce();
    expect(res.isError).toBe(true);
    expect(res.details?.userDenied).toBe(true);
    expect(execute).not.toHaveBeenCalled();
  });

  it('should run write with edited params and record them on the result', async () => {
    const { tool, execute } = makeWriteLikeTool('write');
    const ask = vi.fn<AskApprovalFn>(async () => ({
      decision: 'edit',
      editedParams: { path: 'safe.txt', content: 'edited' },
    }));
    const wrapped = wrapWriteToolWithPermission(
      CWD,
      () => 'danger-full-access',
      () => [],
      () => 'en',
      ask,
      () => 'conv',
      undefined,
      tool,
    );
    const res = (await runWriteLike(wrapped, { path: '.env', content: 'x' })) as {
      details?: Record<string, unknown>;
    };
    expect(execute.mock.calls[0]?.[1]).toEqual({ path: 'safe.txt', content: 'edited' });
    expect(res.details?.userEdited).toBe(true);
  });

  it('should block edit when a custom rule denies the target path', async () => {
    const rule: ApprovalRule = {
      id: 'custom.deny-edit',
      enabled: true,
      tools: ['edit'],
      field: 'path',
      match: 'prefix',
      value: 'secrets/',
      action: 'deny',
      label: 'secrets',
      labelEn: 'secrets',
    };
    const { tool, execute } = makeWriteLikeTool('edit');
    const res = await runWriteLike(
      wrapEditToolWithPermission(
        CWD,
        () => 'danger-full-access',
        () => [],
        () => 'en',
        vi.fn<AskApprovalFn>(async () => ({ decision: 'approve' })),
        () => 'conv',
        () => [rule],
        tool,
      ),
      { path: 'secrets/token.txt', content: 'x' },
    );
    expect(res.isError).toBe(true);
    expect(res.details?.ruleDenied).toBe(true);
    expect(execute).not.toHaveBeenCalled();
  });
});
