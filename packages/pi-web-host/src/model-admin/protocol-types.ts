/**
 * 模型管理域的协议类型切片（第五批对接）。
 *
 * 从 apps/pi-web/server/protocol.ts（上游参考快照）摘取 model-admin 域实际
 * 收发所需的类型——host 不引入完整 4,363 行协议文件，与既有四批对接的
 * 「按域切片」口径一致。字段语义与完整协议一一对应；前端 use-chat 直接
 * 消费这些消息（host-bridge 对该批类型走 default 透传）。
 *
 * 维护约定：apps/pi-web/server/protocol.ts 为协议单一真源；此处漂移时
 * 以真源为准回改。若未来域扩到需要整个 ServerMessage，再评估整文件引用。
 */

// ---------------------------------------------------------------------------
// 自定义服务商配置（agentDir/models.json 的浏览器可编辑形状）
// ---------------------------------------------------------------------------

/** enrich_models 的一行补参结果：目录真实提供的字段才出现（绝不臆造）。 */
export interface UiEnrichResult {
  id: string;
  status: 'matched' | 'suggested' | 'unmatched';
  contextWindow?: number;
  maxTokens?: number;
  input?: string[];
  reasoning?: boolean;
  name?: string;
  source?: string;
  matchType?: 'exact' | 'normalized' | 'family' | 'hint' | 'hint-url';
  /** suggested 行的建议目录 id（作为证据粘贴）。 */
  suggestions?: string[];
  /** unmatched / 低置信度说明。 */
  note?: string;
}

/** 模型级思考档位映射（pi-ai ThinkingLevelMap）：null = 该档不支持，缺键 = 走默认。 */
export type UiThinkingLevelMap = Partial<
  Record<'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max', string | null>
>;

/** 自定义服务商里的一个模型定义。 */
export interface UiModelConfigEntry {
  id: string;
  name?: string;
  reasoning?: boolean;
  input?: string[];
  contextWindow?: number;
  maxTokens?: number;
  thinkingLevelMap?: UiThinkingLevelMap;
  /** 罕用 per-model 覆盖：api 类型与/或 baseUrl；缺省 = 继承同服务商兄弟行。 */
  api?: string;
  baseUrl?: string;
}

/** models.json providers.<id> 的一个自定义服务商块。 */
export interface UiProviderConfig {
  providerId: string;
  name?: string;
  api?: string;
  baseUrl?: string;
  /** 【只写】save_model_config 提交的新 apiKey；下发时永不填充（明文不回传浏览器）。 */
  apiKey?: string;
  /** 【只读】服务端下发的"是否已保存 apiKey"。 */
  hasApiKey?: boolean;
  authHeader?: boolean;
  models: UiModelConfigEntry[];
}

// ---------------------------------------------------------------------------
// 服务商状态 / 密钥 / OAuth
// ---------------------------------------------------------------------------

export interface ProviderStatus {
  id: string;
  name: string;
  configured: boolean;
  /** 鉴权来源：stored / runtime / environment / models_json_key … */
  source?: string;
  supportsApiKey: boolean;
  supportsOAuth: boolean;
  /** OAuth 账号名（OAuth 控件展示）。 */
  oauthName?: string;
  /** 当前生效凭据是否 OAuth。 */
  usingOAuth: boolean;
  /**
   * 该服务商在 pi.dev 官方目录中存在（refresh_builtin_models 拉取），但本地
   * 运行时尚未注册——以内置列表占位行展示，待 vendor SDK 升级后转为可配置。
   */
  officialOnly?: boolean;
}

/** 内置服务商的一个已存密钥（仅昵称；明文永不离开服务端）。 */
export interface ProviderKeyInfo {
  /** 用户起（或自动生成）的名称——前端可见的唯一标识，每服务商唯一。 */
  name: string;
  /** true = 当前该密钥为服务商的生效路由。 */
  active: boolean;
}

export type ProviderOAuthPromptPayload =
  | { type: 'text' | 'secret' | 'manual_code'; message: string; placeholder?: string }
  | {
      type: 'select';
      message: string;
      options: { id: string; label: string; description?: string }[];
    };

export type ProviderOAuthEventPayload =
  | { type: 'info'; message: string; links?: { url: string; label?: string }[] }
  | { type: 'auth_url'; url: string; instructions?: string }
  | {
      type: 'device_code';
      userCode: string;
      verificationUri: string;
      intervalSeconds?: number;
      expiresInSeconds?: number;
    }
  | { type: 'progress'; message: string };

export interface ProviderOAuthFlowState {
  flowId: string;
  provider: string;
  promptId?: string;
  prompt?: ProviderOAuthPromptPayload;
  event?: ProviderOAuthEventPayload;
}

// ---------------------------------------------------------------------------
// ServerMessage 域切片：model-admin 会发出的全部消息（完整协议的子集 union）
// ---------------------------------------------------------------------------

export type ModelAdminServerMessage =
  | { type: 'notice'; level: 'info' | 'warning' | 'error'; text: string; textEn?: string }
  | { type: 'models_config'; providers: UiProviderConfig[] }
  | { type: 'providers_status'; providers: ProviderStatus[] }
  | { type: 'provider_oauth_started'; flowId: string; provider: string }
  | { type: 'provider_oauth_flows'; flows: ProviderOAuthFlowState[] }
  | {
      type: 'provider_oauth_prompt';
      flowId: string;
      provider: string;
      promptId: string;
      prompt: ProviderOAuthPromptPayload;
    }
  | {
      type: 'provider_oauth_event';
      flowId: string;
      provider: string;
      event: ProviderOAuthEventPayload;
    }
  | {
      type: 'provider_oauth_result';
      flowId: string;
      provider: string;
      ok: boolean;
      cancelled?: boolean;
      error?: string;
    }
  | { type: 'provider_oauth_logout_result'; provider: string; ok: boolean; error?: string }
  | { type: 'provider_keys'; keys: Record<string, ProviderKeyInfo[]> }
  | {
      type: 'fetch_models_result';
      reqId: number;
      ok: boolean;
      models?: UiModelConfigEntry[];
      error?: string;
    }
  | {
      type: 'test_model_connection_result';
      reqId: number;
      ok: boolean;
      latencyMs?: number;
      error?: string;
    }
  | {
      type: 'enrich_models_progress';
      reqId: number;
      phase: 'catalog' | 'page' | 'matching' | 'aborted';
      current?: number;
      total?: number;
      message?: string;
    }
  | {
      type: 'enrich_models_result';
      reqId: number;
      ok: boolean;
      results?: UiEnrichResult[];
      error?: string;
    }
  | {
      type: 'refresh_provider_result';
      reqId: number;
      ok: boolean;
      added?: number;
      total?: number;
      error?: string;
    }
  | {
      type: 'refresh_builtin_result';
      reqId: number;
      ok: boolean;
      error?: string;
    }
  | {
      type: 'append_builtin_result';
      reqId: number;
      ok: boolean;
      error?: string;
    }
  | {
      type: 'clone_provider_result';
      reqId: number;
      ok: boolean;
      config?: UiProviderConfig;
      configs?: UiProviderConfig[];
      error?: string;
    };
