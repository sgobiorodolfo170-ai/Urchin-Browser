/**
 * 模型管理域消息路由（第五批对接）。
 *
 * 把 pi-web-ui 完整协议的 24 条模型管理 ClientMessage 路由到 ModelAdminService
 * （对照源：apps/pi-web/server/dispatch-domain-handlers.ts 的模型域 case 块 +
 * agent-service.ts 的 modelAdmin 委托层）。字段名与完整协议一一对应；
 * *_result / *_status 推送由 service 经 host.emit 广播，不经此层。
 */
import type { ModelAdminService } from './model-admin';
import type { UiProviderConfig } from './protocol-types';

export interface ModelAdminDispatch {
  readonly ma: ModelAdminService;
  /** 连接级错误回执（参数缺失等 bad_request 类；域内失败由 service 自行回执）。 */
  readonly onError: (code: string, message: string) => void;
  /** 全局默认模型（"provider/id"）——host 内存态，标签页重连不丢。 */
  readonly getDefaultModel: () => string | null;
  /** 设置/清除默认模型；实现方负责 echo default_model 给客户端。 */
  readonly setDefaultModel: (modelId: string | null) => void;
}

const str = (msg: Record<string, unknown>, key: string): string =>
  typeof msg[key] === 'string' ? msg[key] : '';

export function dispatchModelAdminMessage(
  d: ModelAdminDispatch,
  type: string,
  msg: Record<string, unknown>,
): void {
  switch (type) {
    // -- 配置查询 --
    case 'list_models_config':
      void d.ma.listModelsConfig();
      return;
    case 'reload_models_config':
      void d.ma.reloadModelsConfig();
      return;
    case 'list_providers':
      void d.ma.listProviders();
      return;
    case 'list_provider_keys':
      d.ma.listProviderKeys();
      return;
    case 'list_provider_oauth_flows':
      d.ma.listProviderOAuthFlows();
      return;

    // -- 自定义服务商 CRUD --
    case 'save_model_config': {
      const providerId = str(msg, 'providerId');
      const config = msg.config as UiProviderConfig | undefined;
      if (!providerId || !config) {
        d.onError('bad_message', 'save_model_config requires providerId + config');
        return;
      }
      void d.ma.saveModelConfig(providerId, config);
      return;
    }
    case 'delete_model_config': {
      const providerId = str(msg, 'providerId');
      if (!providerId) {
        d.onError('bad_message', 'delete_model_config.providerId required');
        return;
      }
      void d.ma.deleteModelConfig(providerId);
      return;
    }
    case 'clone_provider': {
      const provider = str(msg, 'provider');
      if (!provider) {
        d.onError('bad_message', 'clone_provider.provider required');
        return;
      }
      void d.ma.cloneProvider(provider, typeof msg.reqId === 'number' ? msg.reqId : 0);
      return;
    }

    // -- API 密钥 --
    case 'set_provider_api_key': {
      const provider = str(msg, 'provider');
      const apiKey = str(msg, 'apiKey');
      if (!provider || !apiKey) {
        d.onError('bad_message', 'set_provider_api_key requires provider + apiKey');
        return;
      }
      void d.ma.setProviderApiKey(provider, apiKey);
      return;
    }
    case 'clear_provider_api_key': {
      const provider = str(msg, 'provider');
      if (!provider) {
        d.onError('bad_message', 'clear_provider_api_key.provider required');
        return;
      }
      void d.ma.clearProviderApiKey(provider);
      return;
    }
    case 'add_provider_key': {
      const provider = str(msg, 'provider');
      const apiKey = str(msg, 'apiKey');
      if (!provider || !apiKey) {
        d.onError('bad_message', 'add_provider_key requires provider + apiKey');
        return;
      }
      const name = typeof msg.name === 'string' ? msg.name : undefined;
      void d.ma.addProviderKey(provider, apiKey, name);
      return;
    }
    case 'activate_provider_key': {
      const provider = str(msg, 'provider');
      const keyName = str(msg, 'keyName');
      if (!provider || !keyName) {
        d.onError('bad_message', 'activate_provider_key requires provider + keyName');
        return;
      }
      void d.ma.activateProviderKey(provider, keyName);
      return;
    }
    case 'remove_provider_key': {
      const provider = str(msg, 'provider');
      const keyName = str(msg, 'keyName');
      if (!provider || !keyName) {
        d.onError('bad_message', 'remove_provider_key requires provider + keyName');
        return;
      }
      void d.ma.removeProviderKey(provider, keyName);
      return;
    }

    // -- OAuth --
    case 'provider_oauth_start': {
      const provider = str(msg, 'provider');
      if (!provider) {
        d.onError('bad_message', 'provider_oauth_start.provider required');
        return;
      }
      d.ma.startProviderOAuth(provider);
      return;
    }
    case 'provider_oauth_reply': {
      const flowId = str(msg, 'flowId');
      const promptId = str(msg, 'promptId');
      const value = str(msg, 'value');
      if (!flowId || !promptId) {
        d.onError('bad_message', 'provider_oauth_reply requires flowId + promptId');
        return;
      }
      d.ma.replyProviderOAuth(flowId, promptId, value);
      return;
    }
    case 'provider_oauth_cancel': {
      const flowId = str(msg, 'flowId');
      if (flowId) d.ma.cancelProviderOAuth(flowId);
      return;
    }
    case 'provider_oauth_logout': {
      const provider = str(msg, 'provider');
      if (!provider) {
        d.onError('bad_message', 'provider_oauth_logout.provider required');
        return;
      }
      void d.ma.logoutProviderOAuth(provider);
      return;
    }

    // -- 探测 / 刷新 / 补参 --
    case 'fetch_models': {
      const baseUrl = str(msg, 'baseUrl');
      const reqId = typeof msg.reqId === 'number' ? msg.reqId : 0;
      if (!baseUrl) {
        d.onError('bad_message', 'fetch_models.baseUrl required');
        return;
      }
      void d.ma.fetchModelsList(
        reqId,
        baseUrl,
        typeof msg.apiKey === 'string' ? msg.apiKey : undefined,
        msg.authHeader === true ? true : undefined,
        typeof msg.api === 'string' ? msg.api : undefined,
        undefined, // lang：host 侧固定中文（notice 均带 textEn 双语）
        typeof msg.providerId === 'string' ? msg.providerId : undefined,
      );
      return;
    }
    case 'test_model_connection': {
      const baseUrl = str(msg, 'baseUrl');
      const reqId = typeof msg.reqId === 'number' ? msg.reqId : 0;
      if (!baseUrl) {
        d.onError('bad_message', 'test_model_connection.baseUrl required');
        return;
      }
      void d.ma.testConnection(
        reqId,
        baseUrl,
        typeof msg.apiKey === 'string' ? msg.apiKey : undefined,
        msg.authHeader === true ? true : undefined,
        typeof msg.api === 'string' ? msg.api : undefined,
        undefined,
        typeof msg.providerId === 'string' ? msg.providerId : undefined,
      );
      return;
    }
    case 'refresh_provider_models': {
      const providerId = str(msg, 'providerId');
      const reqId = typeof msg.reqId === 'number' ? msg.reqId : 0;
      if (!providerId) {
        d.onError('bad_message', 'refresh_provider_models.providerId required');
        return;
      }
      void d.ma.refreshProviderModels(providerId, reqId);
      return;
    }
    case 'refresh_builtin_models': {
      const reqId = typeof msg.reqId === 'number' ? msg.reqId : 0;
      void d.ma.refreshBuiltinModels(reqId);
      return;
    }
    case 'append_builtin_model': {
      const providerId = str(msg, 'providerId');
      const model = msg.model as UiModelConfigEntryLike | undefined;
      const reqId = typeof msg.reqId === 'number' ? msg.reqId : 0;
      if (!providerId || !model || typeof model.id !== 'string' || !model.id) {
        d.onError('bad_message', 'append_builtin_model requires providerId + model.id');
        return;
      }
      void d.ma.appendBuiltinModel(providerId, model, reqId);
      return;
    }
    case 'enrich_models': {
      const reqId = typeof msg.reqId === 'number' ? msg.reqId : 0;
      const ids = Array.isArray(msg.ids)
        ? (msg.ids as unknown[]).filter((x): x is string => typeof x === 'string')
        : [];
      if (ids.length === 0) {
        d.onError('bad_message', 'enrich_models.ids required');
        return;
      }
      const hintsRaw = msg.hints;
      const hints =
        hintsRaw && typeof hintsRaw === 'object' ? (hintsRaw as Record<string, string>) : undefined;
      void d.ma.enrichModels(reqId, ids, hints);
      return;
    }
    case 'abort_enrich_models': {
      const reqId = typeof msg.reqId === 'number' ? msg.reqId : undefined;
      d.ma.abortEnrichModels(reqId);
      return;
    }

    // -- 全局默认模型（host 内存态；echo default_model 由 setDefaultModel 实现方负责） --
    case 'set_default_model':
      d.setDefaultModel(str(msg, 'modelId') || null);
      return;
    case 'clear_default_model':
      d.setDefaultModel(null);
      return;

    default:
      d.onError('bad_message', `unhandled model-admin message: ${type}`);
      return;
  }
}

/** append_builtin_model 的宽松 model 形状（protocol-types.UiModelConfigEntry 的最小子集）。 */
interface UiModelConfigEntryLike {
  id: string;
  [key: string]: unknown;
}
