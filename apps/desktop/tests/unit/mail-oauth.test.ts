// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createMailOAuthCallback,
  MailOAuthService,
  mailOAuthKey,
} from '../../src/main/mail/mail-oauth';
import type { SecretStore } from '../../src/main/storage/types';
function secrets(): SecretStore {
  const data = new Map<string, string>();
  return {
    get: vi.fn((key: string) => Promise.resolve(data.get(key) ?? null)),
    set: vi.fn((key: string, value: string) => {
      data.set(key, value);
      return Promise.resolve();
    }),
    delete: vi.fn((key: string) => {
      data.delete(key);
      return Promise.resolve();
    }),
    has: (key) => data.has(key),
  };
}
afterEach(() => vi.unstubAllGlobals());
describe('mail OAuth', () => {
  it('keeps application secrets out of renderer configuration responses', async () => {
    const store = secrets();
    const service = new MailOAuthService(store);
    await service.setConfig('gmail', 'client', 'secret');
    expect(await service.getConfig('gmail')).toEqual({ clientId: 'client', hasClientSecret: true });
    await service.setConfig('gmail', 'client');
    expect(await service.getConfig('gmail')).toEqual({ clientId: 'client', hasClientSecret: true });
  });
  it('rejects forged callback state and accepts only the intended path', async () => {
    const callback = await createMailOAuthCallback('gmail', 'expected');
    try {
      const bad = await fetch(`${callback.redirectUri}?state=wrong&code=evil`);
      expect(bad.status).toBe(400);
      const valid = await fetch(`${callback.redirectUri}?state=expected&code=good`);
      expect(valid.status).toBe(200);
      expect((await callback.result).searchParams.get('code')).toBe('good');
    } finally {
      callback.close();
    }
  });
  it('closes abandoned callbacks on timeout', async () => {
    const callback = await createMailOAuthCallback('gmail', 'expected', 20);
    try {
      await expect(callback.result).rejects.toThrow('超时');
    } finally {
      callback.close();
    }
  });
  it('reuses valid tokens without contacting the authorization server', async () => {
    const store = secrets();
    await store.set(
      mailOAuthKey('a'),
      JSON.stringify({
        provider: 'gmail',
        clientId: 'client',
        accessToken: 'valid',
        refreshToken: 'refresh',
        expiresAt: Date.now() + 3600000,
      }),
    );
    const network = vi.fn();
    vi.stubGlobal('fetch', network);
    expect(await new MailOAuthService(store).accessToken('a')).toBe('valid');
    expect(network).not.toHaveBeenCalled();
  });
  it('refreshes once for concurrent requests and persists rotating refresh tokens', async () => {
    const store = secrets();
    await store.set(
      mailOAuthKey('a'),
      JSON.stringify({
        provider: 'outlook',
        clientId: 'client',
        accessToken: 'expired',
        refreshToken: 'old',
        expiresAt: 0,
      }),
    );
    const network = vi.fn(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            access_token: 'new',
            refresh_token: 'rotated',
            token_type: 'Bearer',
            expires_in: 3600,
          }),
          { headers: { 'content-type': 'application/json' } },
        ),
      ),
    );
    vi.stubGlobal('fetch', network);
    const service = new MailOAuthService(store);
    expect(await Promise.all([service.accessToken('a'), service.accessToken('a')])).toEqual([
      'new',
      'new',
    ]);
    expect(network).toHaveBeenCalledTimes(1);
    expect(await store.get(mailOAuthKey('a'))).toContain('rotated');
  });
  it('runs browser authorization with PKCE and exchanges the callback using the configured app', async () => {
    const store = secrets();
    const service = new MailOAuthService(store);
    await service.setConfig('gmail', 'own-client', 'own-secret');
    const realFetch = globalThis.fetch;
    let verifier = '';
    vi.stubGlobal('fetch', (input: string | URL | Request, init?: RequestInit) => {
      if (
        (input instanceof Request ? input.url : input.toString()).startsWith(
          'https://oauth2.googleapis.com/',
        )
      ) {
        const body = init?.body as URLSearchParams;
        verifier = body.get('code_verifier') ?? '';
        expect(body.get('client_id')).toBe('own-client');
        expect(body.get('code')).toBe('test-code');
        return Promise.resolve(
          new Response(
            JSON.stringify({
              access_token: 'access',
              refresh_token: 'refresh',
              token_type: 'Bearer',
              expires_in: 3600,
            }),
            { headers: { 'content-type': 'application/json' } },
          ),
        );
      }
      return realFetch(input, init);
    });
    const credential = await service.authorize('gmail', 'me@gmail.com', async (url) => {
      const request = new URL(url);
      expect(request.searchParams.get('code_challenge_method')).toBe('S256');
      const callback = new URL(request.searchParams.get('redirect_uri')!);
      callback.searchParams.set('state', request.searchParams.get('state')!);
      callback.searchParams.set('code', 'test-code');
      await realFetch(callback);
    });
    expect(verifier.length).toBeGreaterThanOrEqual(43);
    expect(credential.refreshToken).toBe('refresh');
  });

  it('reports revocation without exposing response bodies or tokens', async () => {
    const store = secrets();
    await store.set(
      mailOAuthKey('a'),
      JSON.stringify({
        provider: 'gmail',
        clientId: 'client',
        accessToken: 'sensitive',
        refreshToken: 'secret-refresh',
        expiresAt: 0,
      }),
    );
    vi.stubGlobal('fetch', () =>
      Promise.resolve(
        new Response(
          JSON.stringify({ error: 'invalid_grant', error_description: 'sensitive details' }),
          { status: 400, headers: { 'content-type': 'application/json' } },
        ),
      ),
    );
    await expect(new MailOAuthService(store).accessToken('a')).rejects.toThrow('邮箱授权刷新失败');
  });
});
