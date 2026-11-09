/**
 * model-admin/provider-oauth-flow.ts 单元测试
 *
 * OAuth 登录状态机：不支持的服务商、重复 start 复用、成功/失败/取消结果、
 * 交互式 prompt 往返（text / select）、notify 事件、list 快照与 dispose 语义。
 */
import { describe, it, expect, vi } from 'vitest';
import type { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { ProviderOAuthFlowManager } from '../src/model-admin/provider-oauth-flow';
import type { ModelAdminServerMessage } from '../src/model-admin/protocol-types';

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

interface Harness {
  emitted: Record<string, unknown>[];
  manager: ProviderOAuthFlowManager;
  loginCalls: number;
  onLoginSuccess: ReturnType<typeof vi.fn>;
  setDisposed: (v: boolean) => void;
}

type LoginImpl = (
  provider: string,
  mode: string,
  interaction: Record<string, unknown>,
) => Promise<void>;

function makeHarness(options: {
  supportsOAuth?: boolean;
  login?: LoginImpl;
  disposed?: boolean;
}): Harness {
  const emitted: Record<string, unknown>[] = [];
  let disposed = options.disposed ?? false;
  let loginCalls = 0;
  const onLoginSuccess = vi.fn(() => Promise.resolve());
  const runtime = {
    // 本用例只走 OAuth 流程、不触发补全与目录读取；`src/pi-shims-coding-agent.d.ts`
    // 已按 vendor 源码精确声明 `ModelRuntime`（D8 修复的一环），这里只给实际用到的
    // 成员，其余用 `as unknown as ModelRuntime` 收口，保持 fake 与真实接口的差异显式可见。
    completeSimple: () => Promise.reject(new Error('completeSimple is not used in this test')),
    getProvider: (id: string) =>
      options.supportsOAuth === false
        ? { id, auth: {} }
        : id === 'oauth-provider'
          ? { id, auth: { oauth: true } }
          : undefined,
    login: (provider: string, mode: string, interaction: Record<string, unknown>) => {
      loginCalls++;
      return options.login ? options.login(provider, mode, interaction) : Promise.resolve();
    },
  };
  const manager = new ProviderOAuthFlowManager({
    modelRuntime: () => runtime as unknown as ModelRuntime,
    emit: (msg: ModelAdminServerMessage) => emitted.push(msg),
    isDisposed: () => disposed,
    onLoginSuccess: onLoginSuccess,
  });
  return {
    emitted,
    manager,
    get loginCalls() {
      return loginCalls;
    },
    onLoginSuccess,
    setDisposed: (v: boolean) => {
      disposed = v;
    },
  };
}

function findType(emitted: Record<string, unknown>[], type: string): Record<string, unknown>[] {
  return emitted.filter((m) => m.type === type);
}

describe('start', () => {
  it('should emit a notice and return null when the provider has no OAuth', () => {
    const h = makeHarness({ supportsOAuth: false });
    expect(h.manager.start('plain-provider')).toBeNull();
    const notices = findType(h.emitted, 'notice');
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ level: 'error' });
    expect(String(notices[0]?.textEn)).toContain('does not support OAuth');
  });

  it('should reject an empty provider id', () => {
    const h = makeHarness({});
    expect(h.manager.start('   ')).toBeNull();
    expect(findType(h.emitted, 'notice')).toHaveLength(1);
  });

  it('should emit provider_oauth_started and return a flow id', () => {
    const h = makeHarness({});
    const flowId = h.manager.start('oauth-provider');
    expect(typeof flowId).toBe('string');
    expect(flowId).toHaveLength(36);
    expect(findType(h.emitted, 'provider_oauth_started')[0]).toMatchObject({
      flowId,
      provider: 'oauth-provider',
    });
  });

  it('should reuse the running flow for the same provider', () => {
    const h = makeHarness({ login: () => new Promise<void>(() => undefined) });
    const first = h.manager.start('oauth-provider');
    const second = h.manager.start('oauth-provider');
    expect(second).toBe(first);
    expect(h.loginCalls).toBe(1);
  });

  it('should return null after dispose', () => {
    const h = makeHarness({});
    h.manager.dispose();
    expect(h.manager.start('oauth-provider')).toBeNull();
  });
});

describe('run outcome', () => {
  it('should emit a success result and refresh credentials', async () => {
    const h = makeHarness({});
    const flowId = h.manager.start('oauth-provider');
    await vi.waitFor(() => expect(findType(h.emitted, 'provider_oauth_result')).toHaveLength(1));
    expect(h.onLoginSuccess).toHaveBeenCalledWith('oauth-provider');
    expect(findType(h.emitted, 'provider_oauth_result')[0]).toMatchObject({
      flowId,
      provider: 'oauth-provider',
      ok: true,
    });
  });

  it('should emit a failure result with the error message', async () => {
    const h = makeHarness({ login: () => Promise.reject(new Error('boom')) });
    h.manager.start('oauth-provider');
    await vi.waitFor(() => expect(findType(h.emitted, 'provider_oauth_result')).toHaveLength(1));
    expect(findType(h.emitted, 'provider_oauth_result')[0]).toMatchObject({
      ok: false,
      error: 'boom',
    });
  });

  it('should flag the result as cancelled when the flow is aborted', async () => {
    let aborted: AbortSignal | undefined;
    const h = makeHarness({
      login: (_p, _m, interaction) =>
        new Promise<void>((_resolve, reject) => {
          const signal = interaction.signal as AbortSignal;
          aborted = signal;
          signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        }),
    });
    const flowId = h.manager.start('oauth-provider')!;
    h.manager.cancel(flowId);
    expect(aborted?.aborted).toBe(true);
    await vi.waitFor(() => expect(findType(h.emitted, 'provider_oauth_result')).toHaveLength(1));
    expect(findType(h.emitted, 'provider_oauth_result')[0]).toMatchObject({
      ok: false,
      cancelled: true,
    });
  });

  it('should not emit a result when the manager is disposed mid-flight', async () => {
    const gate = deferred<void>();
    const h = makeHarness({ login: () => gate.promise });
    h.manager.start('oauth-provider');
    h.manager.dispose();
    gate.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(findType(h.emitted, 'provider_oauth_result')).toHaveLength(0);
  });

  it('should ignore notify events after dispose', async () => {
    let notify: ((event: Record<string, unknown>) => void) | undefined;
    const gate = deferred<void>();
    const h = makeHarness({
      login: (_p, _m, interaction) => {
        notify = interaction.notify as (event: Record<string, unknown>) => void;
        return gate.promise;
      },
    });
    h.manager.start('oauth-provider');
    await vi.waitFor(() => expect(notify).toBeDefined());
    h.manager.dispose();
    notify?.({ type: 'info', message: 'late' });
    expect(findType(h.emitted, 'provider_oauth_event')).toHaveLength(0);
    gate.resolve();
  });
});

describe('interactive prompts', () => {
  it('should round-trip a text prompt answer', async () => {
    const gate = deferred<string>();
    let answer = '';
    const h = makeHarness({
      login: async (_p, _m, interaction) => {
        const prompt = interaction.prompt as (p: unknown) => Promise<string>;
        answer = await prompt({ type: 'text', message: 'Paste the code', placeholder: 'code' });
      },
    });
    const flowId = h.manager.start('oauth-provider')!;
    await vi.waitFor(() => expect(findType(h.emitted, 'provider_oauth_prompt')).toHaveLength(1));
    const promptMsg = findType(h.emitted, 'provider_oauth_prompt')[0];
    expect(promptMsg).toMatchObject({
      flowId,
      provider: 'oauth-provider',
      prompt: { type: 'text', message: 'Paste the code', placeholder: 'code' },
    });
    h.manager.reply(flowId, String(promptMsg?.promptId), 'abc-123');
    gate.resolve('ignored');
    await vi.waitFor(() => expect(findType(h.emitted, 'provider_oauth_result')).toHaveLength(1));
    expect(answer).toBe('abc-123');
  });

  it('should copy select options into the emitted payload', async () => {
    const h = makeHarness({
      login: async (_p, _m, interaction) => {
        const prompt = interaction.prompt as (p: unknown) => Promise<string>;
        await prompt({
          type: 'select',
          message: 'Pick an account',
          options: [{ value: 'a', label: 'A' }],
        });
      },
    });
    const flowId = h.manager.start('oauth-provider')!;
    await vi.waitFor(() => expect(findType(h.emitted, 'provider_oauth_prompt')).toHaveLength(1));
    const promptMsg = findType(h.emitted, 'provider_oauth_prompt')[0];
    expect(promptMsg?.prompt).toEqual({
      type: 'select',
      message: 'Pick an account',
      options: [{ value: 'a', label: 'A' }],
    });
    h.manager.reply(flowId, String(promptMsg?.promptId), 'a');
  });

  it('should ignore a reply for a stale prompt id', async () => {
    const h = makeHarness({
      login: async (_p, _m, interaction) => {
        const prompt = interaction.prompt as (p: unknown) => Promise<string>;
        await prompt({ type: 'text', message: 'Code?' });
      },
    });
    const flowId = h.manager.start('oauth-provider')!;
    await vi.waitFor(() => expect(findType(h.emitted, 'provider_oauth_prompt')).toHaveLength(1));
    expect(() => h.manager.reply(flowId, 'wrong-id', 'x')).not.toThrow();
    const promptMsg = findType(h.emitted, 'provider_oauth_prompt')[0];
    h.manager.reply(flowId, String(promptMsg?.promptId), 'ok');
    await vi.waitFor(() => expect(findType(h.emitted, 'provider_oauth_result')).toHaveLength(1));
  });

  it('should reject a prompt when the manager is already disposed', async () => {
    let failure: unknown;
    const h = makeHarness({
      login: async (_p, _m, interaction) => {
        try {
          const prompt = interaction.prompt as (p: unknown) => Promise<string>;
          await prompt({ type: 'text', message: 'Code?' });
        } catch (error) {
          failure = error;
        }
      },
    });
    const flowId = h.manager.start('oauth-provider')!;
    h.manager.dispose();
    await vi.waitFor(() => expect(failure).toBeInstanceOf(Error));
    expect(String((failure as Error).message)).toContain('cancelled');
    expect(flowId).toBeTruthy();
  });
});

describe('notify and list', () => {
  it('should emit and remember info events with links', async () => {
    const gate = deferred<void>();
    const h = makeHarness({
      login: (_p, _m, interaction) => {
        const notify = interaction.notify as (e: unknown) => void;
        notify({
          type: 'info',
          message: 'Open the browser',
          links: [{ url: 'https://example.com/device', label: 'Open' }],
        });
        return gate.promise;
      },
    });
    h.manager.start('oauth-provider');
    await vi.waitFor(() => expect(findType(h.emitted, 'provider_oauth_event')).toHaveLength(1));
    const event = findType(h.emitted, 'provider_oauth_event')[0];
    expect(event?.event).toEqual({
      type: 'info',
      message: 'Open the browser',
      links: [{ url: 'https://example.com/device', label: 'Open' }],
    });

    h.manager.list();
    const flows = findType(h.emitted, 'provider_oauth_flows');
    expect(flows).toHaveLength(1);
    expect((flows[0]?.flows as unknown[])[0]).toMatchObject({
      provider: 'oauth-provider',
      event: { type: 'info' },
    });
    gate.resolve();
  });

  it('should include the pending prompt in the list snapshot', async () => {
    const h = makeHarness({
      login: async (_p, _m, interaction) => {
        const prompt = interaction.prompt as (p: unknown) => Promise<string>;
        await prompt({ type: 'text', message: 'Code?' });
      },
    });
    const flowId = h.manager.start('oauth-provider')!;
    await vi.waitFor(() => expect(findType(h.emitted, 'provider_oauth_prompt')).toHaveLength(1));
    const promptMsg = findType(h.emitted, 'provider_oauth_prompt')[0];
    h.manager.list();
    const flows = findType(h.emitted, 'provider_oauth_flows')[0]?.flows as Record<
      string,
      unknown
    >[];
    expect(flows[0]).toMatchObject({
      provider: 'oauth-provider',
      promptId: promptMsg?.promptId,
      prompt: { type: 'text', message: 'Code?' },
    });
    h.manager.reply(flowId, String(promptMsg?.promptId), 'x');
  });

  it('should emit an empty list after dispose', () => {
    const h = makeHarness({ login: () => new Promise<void>(() => undefined) });
    h.manager.start('oauth-provider');
    h.manager.dispose();
    h.manager.list();
    const flows = findType(h.emitted, 'provider_oauth_flows');
    expect(flows[flows.length - 1]?.flows).toEqual([]);
  });
});
