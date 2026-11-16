/** OAuth 协议直接复用 oauth4webapi（MIT）；邮箱认证复用 ImapFlow / Nodemailer。 */
import * as oauth from 'oauth4webapi';
import { createServer } from 'node:http';
import { z } from 'zod';
import type { SecretStore } from '../storage/types';

export type OAuthMailProvider = 'gmail' | 'outlook';
const configSchema = z.object({ clientId: z.string().min(1), clientSecret: z.string().optional() });
const tokenSchema = configSchema.extend({
  provider: z.enum(['gmail', 'outlook']),
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1),
  expiresAt: z.number(),
});
export type MailOAuthCredential = z.infer<typeof tokenSchema>;
export const mailOAuthKey = (id: string) => `mail-account/${id}/oauth`;
const configKey = (provider: OAuthMailProvider) => `mail-oauth/${provider}/client`;
export const MAIL_OAUTH_PROVIDERS = {
  gmail: {
    issuer: 'https://accounts.google.com',
    authorization_endpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
    token_endpoint: 'https://oauth2.googleapis.com/token',
    scope: 'https://mail.google.com/',
    host: 'imap.gmail.com',
    smtp: 'smtp.gmail.com',
    smtpPort: 465,
  },
  outlook: {
    issuer: 'https://login.microsoftonline.com/common/v2.0',
    authorization_endpoint: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
    token_endpoint: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
    scope:
      'offline_access https://outlook.office.com/IMAP.AccessAsUser.All https://outlook.office.com/SMTP.Send',
    host: 'outlook.office365.com',
    smtp: 'smtp-mail.outlook.com',
    smtpPort: 587,
  },
} as const;

/** 仅监听 loopback；无效 state 不消耗合法会话；关闭/超时释放端口。 */
export async function createMailOAuthCallback(
  provider: OAuthMailProvider,
  state: string,
  timeoutMs = 180_000,
) {
  let settle: (url: URL) => void = () => undefined;
  let fail: (error: Error) => void = () => undefined;
  const result = new Promise<URL>((resolve, reject) => {
    settle = resolve;
    fail = reject;
  });
  // 调用者在浏览器打开失败时也会等待 finally 清理，提前绑定拒绝处理避免未处理拒绝。
  void result.catch(() => undefined);
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (
      req.method !== 'GET' ||
      url.pathname !== '/callback' ||
      url.searchParams.get('state') !== state
    ) {
      res.writeHead(400);
      res.end('Invalid OAuth callback');
      return;
    }
    res.writeHead(200, {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store',
      'Content-Security-Policy': "default-src 'none'",
    });
    res.end('授权已收到，请返回顽童浏览器。');
    settle(url);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    server.close();
    throw new Error('无法启动授权回调');
  }
  const redirectUri = `http://${provider === 'gmail' ? '127.0.0.1' : 'localhost'}:${address.port}/callback`;
  const timer = setTimeout(() => {
    fail(new Error('授权超时，请重新登录'));
    server.close();
  }, timeoutMs);
  const close = () => {
    clearTimeout(timer);
    server.close();
    server.closeAllConnections();
  };
  server.on('error', () => fail(new Error('授权回调服务异常')));
  return { redirectUri, result, close };
}

export class MailOAuthService {
  private pendingLogin = false;
  private readonly removed = new Set<string>();
  async removeCredential(accountId: string): Promise<void> {
    this.removed.add(accountId);
    await this.secrets.delete(mailOAuthKey(accountId));
  }
  private readonly refreshing = new Map<string, Promise<string>>();
  constructor(private readonly secrets: SecretStore) {}
  async storeCredential(accountId: string, credential: MailOAuthCredential): Promise<void> {
    // 重新授权优先于旧刷新，防止旧请求覆盖新 refresh token。
    await this.refreshing.get(accountId)?.catch(() => undefined);
    if (this.removed.has(accountId)) throw new Error('账号已删除');
    await this.secrets.set(mailOAuthKey(accountId), JSON.stringify(credential));
  }
  async getConfig(provider: OAuthMailProvider) {
    const raw = await this.secrets.get(configKey(provider));
    const config = raw ? configSchema.parse(JSON.parse(raw)) : null;
    return { clientId: config?.clientId ?? '', hasClientSecret: Boolean(config?.clientSecret) };
  }
  async setConfig(provider: OAuthMailProvider, clientId: string, clientSecret?: string) {
    const previous = await this.secrets.get(configKey(provider));
    const old = previous ? configSchema.parse(JSON.parse(previous)) : null;
    await this.secrets.set(
      configKey(provider),
      JSON.stringify(
        configSchema.parse({
          clientId: clientId.trim(),
          clientSecret:
            clientSecret === undefined && old?.clientId === clientId.trim()
              ? old.clientSecret
              : clientSecret,
        }),
      ),
    );
  }
  async authorize(
    provider: OAuthMailProvider,
    email: string,
    openExternal: (url: string) => Promise<void>,
  ): Promise<MailOAuthCredential> {
    if (this.pendingLogin) throw new Error('已有邮箱授权正在进行，请完成或等待超时后重试');
    this.pendingLogin = true;
    try {
      const raw = await this.secrets.get(configKey(provider));
      if (!raw) throw new Error('请先配置本项目的 OAuth Client ID');
      const config = configSchema.parse(JSON.parse(raw));
      const as = MAIL_OAUTH_PROVIDERS[provider];
      const client = { client_id: config.clientId };
      const verifier = oauth.generateRandomCodeVerifier();
      const state = oauth.generateRandomState();
      const challenge = await oauth.calculatePKCECodeChallenge(verifier);
      const callback = await createMailOAuthCallback(provider, state);
      try {
        const url = new URL(as.authorization_endpoint);
        const query = {
          client_id: config.clientId,
          response_type: 'code',
          redirect_uri: callback.redirectUri,
          scope: as.scope,
          state,
          code_challenge: challenge,
          code_challenge_method: 'S256',
          login_hint: email,
          prompt: 'consent',
          ...(provider === 'gmail' ? { access_type: 'offline' } : {}),
        };
        url.search = new URLSearchParams(query).toString();
        await openExternal(url.href);
        const params = oauth.validateAuthResponse(as, client, await callback.result, state);
        const auth = config.clientSecret
          ? oauth.ClientSecretPost(config.clientSecret)
          : oauth.None();
        const response = await oauth.authorizationCodeGrantRequest(
          as,
          client,
          auth,
          params,
          callback.redirectUri,
          verifier,
          { signal: AbortSignal.timeout(30_000) },
        );
        const tokens = await oauth.processAuthorizationCodeResponse(as, client, response);
        if (!tokens.refresh_token)
          throw new Error('服务商未返回刷新令牌，请撤销该应用授权后重新同意离线访问');
        return tokenSchema.parse({
          ...config,
          provider,
          accessToken: tokens.access_token,
          refreshToken: tokens.refresh_token,
          expiresAt: Date.now() + (tokens.expires_in ?? 3600) * 1000,
        });
      } finally {
        callback.close();
      }
    } catch {
      throw new Error(
        '邮箱 OAuth 授权未完成。请检查应用配置、邮件权限、网络或重新授权（等待超时约3分钟）。',
      );
    } finally {
      this.pendingLogin = false;
    }
  }
  async accessToken(accountId: string): Promise<string> {
    if (this.removed.has(accountId)) throw new Error('账号已删除');
    const pending = this.refreshing.get(accountId);
    if (pending) return pending;
    const task = this.refresh(accountId);
    this.refreshing.set(accountId, task);
    try {
      return await task;
    } finally {
      this.refreshing.delete(accountId);
    }
  }
  private async refresh(accountId: string): Promise<string> {
    const raw = await this.secrets.get(mailOAuthKey(accountId));
    if (!raw) throw new Error('OAuth凭据缺失，请重新授权');
    const credential = tokenSchema.parse(JSON.parse(raw));
    if (credential.expiresAt > Date.now() + 60_000) return credential.accessToken;
    const as = MAIL_OAUTH_PROVIDERS[credential.provider];
    const client = { client_id: credential.clientId };
    try {
      const auth = credential.clientSecret
        ? oauth.ClientSecretPost(credential.clientSecret)
        : oauth.None();
      const response = await oauth.refreshTokenGrantRequest(
        as,
        client,
        auth,
        credential.refreshToken,
        { additionalParameters: { scope: as.scope }, signal: AbortSignal.timeout(30_000) },
      );
      const tokens = await oauth.processRefreshTokenResponse(as, client, response);
      const next = {
        ...credential,
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token ?? credential.refreshToken,
        expiresAt: Date.now() + (tokens.expires_in ?? 3600) * 1000,
      };
      if (this.removed.has(accountId)) throw new Error('账号已删除');
      await this.secrets.set(mailOAuthKey(accountId), JSON.stringify(next));
      return next.accessToken;
    } catch {
      throw new Error('邮箱授权刷新失败，请检查网络或重新授权');
    }
  }
}
