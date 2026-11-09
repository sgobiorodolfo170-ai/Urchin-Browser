/* eslint-disable @typescript-eslint/no-explicit-any -- vendored pi 边界的 ambient shim：`any` 是刻意的宽松锚点 */
/**
 * `@earendil-works/pi-mcp/oauth` 的 ambient 类型 shim（`src` 侧正式版）。
 *
 * 背景同 `pi-shims-coding-agent.d.ts`：该包是 vendored 依赖，构建期由 esbuild 别名
 * 指向 `vendor/pi/packages/mcp/src/oauth`，`tsc` 找不到 `.d.ts`。
 *
 * 本项目只在 `mcp-oauth-login.ts` 里用到三样东西，形状逐字核对
 * `vendor/pi/packages/mcp/src/oauth/{provider,flow}.ts`（1.4.0）：
 * - `MemoryOAuthStateStore`：进程内 state 存储（`load()` 返回克隆，`save()` 覆盖）
 * - `McpOAuthProvider`：把 state store 包成 OAuth client provider
 * - `authorizeMcp()`：跑一次授权流程，返回 `"AUTHORIZED" | "REDIRECT"`
 *
 * 只声明类型，不改变任何运行时行为。
 */
declare module '@earendil-works/pi-mcp/oauth' {
  /** `oauth/types.ts` 的 `OAuthTokens` 子集（只建模本项目读取的字段）。 */
  export interface OAuthTokens {
    access_token?: string;
    refresh_token?: string;
    token_type?: string;
    expires_in?: number;
    scope?: string;
    [key: string]: unknown;
  }

  /** `oauth/provider.ts` */
  export interface McpOAuthState {
    serverUrl: string;
    clientInformation?: unknown;
    tokens?: OAuthTokens;
    tokensExpireAt?: number;
    codeVerifier?: string;
    oauthState?: string;
    discovery?: unknown;
    [key: string]: unknown;
  }

  /** `oauth/provider.ts` */
  export interface McpOAuthStateStore {
    load(): McpOAuthState | undefined | Promise<McpOAuthState | undefined>;
    save(state: McpOAuthState): void | Promise<void>;
  }

  /** `oauth/provider.ts` */
  export class MemoryOAuthStateStore implements McpOAuthStateStore {
    load(): McpOAuthState | undefined;
    save(state: McpOAuthState): void;
  }

  /** `oauth/provider.ts` 的 `McpOAuthProviderOptions` */
  export interface McpOAuthProviderOptions {
    serverUrl: string | URL;
    redirectUrl: string | URL;
    clientMetadata: Record<string, unknown>;
    clientMetadataDocument?: (metadata: unknown) => unknown;
    clientId?: string;
    clientSecret?: string;
    store?: McpOAuthStateStore;
    onRedirect(url: URL): void | Promise<void>;
    [key: string]: unknown;
  }

  /** `oauth/provider.ts` 的 `McpOAuthProvider` */
  export class McpOAuthProvider {
    constructor(options: McpOAuthProviderOptions);
    readonly redirectUrl: string;
    readonly clientMetadata: Record<string, unknown>;
    [key: string]: any;
  }

  /** `oauth/flow.ts` 的 `OAuthFlowOptions` */
  export interface OAuthFlowOptions {
    serverUrl: string | URL;
    authorizationCode?: string;
    iss?: string;
    scope?: string;
    resourceMetadataUrl?: URL;
    authorizationServerMetadataUrl?: URL;
    fetch?: unknown;
    signal?: AbortSignal;
    skipIssuerValidation?: boolean;
    skipRefresh?: boolean;
    [key: string]: unknown;
  }

  /** `oauth/flow.ts` 的 `OAuthFlowResult` */
  export type OAuthFlowResult = 'AUTHORIZED' | 'REDIRECT';

  /** `oauth/flow.ts` 的 `authorizeMcp()` */
  export function authorizeMcp(
    provider: McpOAuthProvider,
    options: OAuthFlowOptions,
  ): Promise<OAuthFlowResult>;
}
