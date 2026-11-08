/**
 * model-admin/dispatch.ts 单元测试
 *
 * 24 条模型管理 ClientMessage 的路由与参数校验：
 * - 无参消息直接转发到 service；
 * - 必填字段缺失 → onError('bad_message', …) 且不调用 service；
 * - 可选字段（reqId / name / hints / authHeader / api / providerId）按协议透传；
 * - set_default_model / clear_default_model 走 dispatch 自身的默认模型回调。
 */
import { beforeEach, describe, it, expect, vi } from 'vitest';
import { dispatchModelAdminMessage } from '../src/model-admin/dispatch';
import type { ModelAdminService } from '../src/model-admin/model-admin';

type ServiceMock = Record<string, ReturnType<typeof vi.fn>>;

function makeService(): ServiceMock {
  return {
    listModelsConfig: vi.fn(),
    reloadModelsConfig: vi.fn(),
    listProviders: vi.fn(),
    listProviderKeys: vi.fn(),
    listProviderOAuthFlows: vi.fn(),
    saveModelConfig: vi.fn(),
    deleteModelConfig: vi.fn(),
    cloneProvider: vi.fn(),
    setProviderApiKey: vi.fn(),
    clearProviderApiKey: vi.fn(),
    addProviderKey: vi.fn(),
    activateProviderKey: vi.fn(),
    removeProviderKey: vi.fn(),
    startProviderOAuth: vi.fn(),
    replyProviderOAuth: vi.fn(),
    cancelProviderOAuth: vi.fn(),
    logoutProviderOAuth: vi.fn(),
    fetchModelsList: vi.fn(),
    testConnection: vi.fn(),
    refreshProviderModels: vi.fn(),
    refreshBuiltinModels: vi.fn(),
    appendBuiltinModel: vi.fn(),
    enrichModels: vi.fn(),
    abortEnrichModels: vi.fn(),
  };
}

let ma: ServiceMock;
let onError: ReturnType<typeof vi.fn>;
let getDefaultModel: ReturnType<typeof vi.fn>;
let setDefaultModel: ReturnType<typeof vi.fn>;

function dispatch(type: string, msg: Record<string, unknown> = {}): void {
  dispatchModelAdminMessage(
    {
      ma: ma as unknown as ModelAdminService,
      onError,
      getDefaultModel: getDefaultModel,
      setDefaultModel: setDefaultModel,
    },
    type,
    msg,
  );
}

beforeEach(() => {
  ma = makeService();
  onError = vi.fn();
  getDefaultModel = vi.fn(() => null);
  setDefaultModel = vi.fn();
});

describe('query routes', () => {
  it('should forward list_models_config', () => {
    dispatch('list_models_config');
    expect(ma.listModelsConfig).toHaveBeenCalledTimes(1);
  });

  it('should forward reload_models_config', () => {
    dispatch('reload_models_config');
    expect(ma.reloadModelsConfig).toHaveBeenCalledTimes(1);
  });

  it('should forward list_providers', () => {
    dispatch('list_providers');
    expect(ma.listProviders).toHaveBeenCalledTimes(1);
  });

  it('should forward list_provider_keys', () => {
    dispatch('list_provider_keys');
    expect(ma.listProviderKeys).toHaveBeenCalledTimes(1);
  });

  it('should forward list_provider_oauth_flows', () => {
    dispatch('list_provider_oauth_flows');
    expect(ma.listProviderOAuthFlows).toHaveBeenCalledTimes(1);
  });
});

describe('provider config CRUD', () => {
  it('should reject save_model_config without providerId', () => {
    dispatch('save_model_config', { config: {} });
    expect(onError).toHaveBeenCalledWith('bad_message', expect.stringContaining('providerId'));
    expect(ma.saveModelConfig).not.toHaveBeenCalled();
  });

  it('should reject save_model_config without config', () => {
    dispatch('save_model_config', { providerId: 'p1' });
    expect(onError).toHaveBeenCalledWith('bad_message', expect.stringContaining('config'));
    expect(ma.saveModelConfig).not.toHaveBeenCalled();
  });

  it('should forward save_model_config with providerId + config', () => {
    const config = { name: 'P1' };
    dispatch('save_model_config', { providerId: 'p1', config });
    expect(ma.saveModelConfig).toHaveBeenCalledWith('p1', config);
  });

  it('should reject delete_model_config without providerId', () => {
    dispatch('delete_model_config');
    expect(onError).toHaveBeenCalledWith('bad_message', expect.stringContaining('providerId'));
    expect(ma.deleteModelConfig).not.toHaveBeenCalled();
  });

  it('should forward delete_model_config', () => {
    dispatch('delete_model_config', { providerId: 'p1' });
    expect(ma.deleteModelConfig).toHaveBeenCalledWith('p1');
  });

  it('should reject clone_provider without provider', () => {
    dispatch('clone_provider');
    expect(onError).toHaveBeenCalledWith('bad_message', expect.stringContaining('provider'));
    expect(ma.cloneProvider).not.toHaveBeenCalled();
  });

  it('should forward clone_provider and default reqId to 0', () => {
    dispatch('clone_provider', { provider: 'openai' });
    expect(ma.cloneProvider).toHaveBeenCalledWith('openai', 0);
  });

  it('should pass a numeric reqId through clone_provider', () => {
    dispatch('clone_provider', { provider: 'openai', reqId: 7 });
    expect(ma.cloneProvider).toHaveBeenCalledWith('openai', 7);
  });
});

describe('API key routes', () => {
  it('should reject set_provider_api_key without provider or apiKey', () => {
    dispatch('set_provider_api_key', { provider: 'p' });
    dispatch('set_provider_api_key', { apiKey: 'k' });
    expect(onError).toHaveBeenCalledTimes(2);
    expect(ma.setProviderApiKey).not.toHaveBeenCalled();
  });

  it('should forward set_provider_api_key', () => {
    dispatch('set_provider_api_key', { provider: 'p', apiKey: 'k' });
    expect(ma.setProviderApiKey).toHaveBeenCalledWith('p', 'k');
  });

  it('should reject clear_provider_api_key without provider', () => {
    dispatch('clear_provider_api_key');
    expect(onError).toHaveBeenCalled();
    expect(ma.clearProviderApiKey).not.toHaveBeenCalled();
  });

  it('should forward clear_provider_api_key', () => {
    dispatch('clear_provider_api_key', { provider: 'p' });
    expect(ma.clearProviderApiKey).toHaveBeenCalledWith('p');
  });

  it('should forward add_provider_key with and without a name', () => {
    dispatch('add_provider_key', { provider: 'p', apiKey: 'k' });
    expect(ma.addProviderKey).toHaveBeenCalledWith('p', 'k', undefined);
    dispatch('add_provider_key', { provider: 'p', apiKey: 'k', name: 'work' });
    expect(ma.addProviderKey).toHaveBeenLastCalledWith('p', 'k', 'work');
  });

  it('should reject add_provider_key without provider or apiKey', () => {
    dispatch('add_provider_key', { provider: 'p' });
    dispatch('add_provider_key', { apiKey: 'k' });
    expect(onError).toHaveBeenCalledTimes(2);
    expect(ma.addProviderKey).not.toHaveBeenCalled();
  });

  it('should reject activate_provider_key without provider or keyName', () => {
    dispatch('activate_provider_key', { provider: 'p' });
    dispatch('activate_provider_key', { keyName: 'k' });
    expect(onError).toHaveBeenCalledTimes(2);
    expect(ma.activateProviderKey).not.toHaveBeenCalled();
  });

  it('should forward activate_provider_key', () => {
    dispatch('activate_provider_key', { provider: 'p', keyName: 'k' });
    expect(ma.activateProviderKey).toHaveBeenCalledWith('p', 'k');
  });

  it('should reject remove_provider_key without provider or keyName', () => {
    dispatch('remove_provider_key', { provider: 'p' });
    expect(onError).toHaveBeenCalled();
    expect(ma.removeProviderKey).not.toHaveBeenCalled();
  });

  it('should forward remove_provider_key', () => {
    dispatch('remove_provider_key', { provider: 'p', keyName: 'k' });
    expect(ma.removeProviderKey).toHaveBeenCalledWith('p', 'k');
  });
});

describe('OAuth routes', () => {
  it('should reject provider_oauth_start without provider', () => {
    dispatch('provider_oauth_start');
    expect(onError).toHaveBeenCalledWith('bad_message', expect.stringContaining('provider'));
    expect(ma.startProviderOAuth).not.toHaveBeenCalled();
  });

  it('should forward provider_oauth_start', () => {
    dispatch('provider_oauth_start', { provider: 'anthropic' });
    expect(ma.startProviderOAuth).toHaveBeenCalledWith('anthropic');
  });

  it('should reject provider_oauth_reply without flowId or promptId', () => {
    dispatch('provider_oauth_reply', { flowId: 'f' });
    dispatch('provider_oauth_reply', { promptId: 'p' });
    expect(onError).toHaveBeenCalledTimes(2);
    expect(ma.replyProviderOAuth).not.toHaveBeenCalled();
  });

  it('should forward provider_oauth_reply with an empty value', () => {
    dispatch('provider_oauth_reply', { flowId: 'f', promptId: 'p' });
    expect(ma.replyProviderOAuth).toHaveBeenCalledWith('f', 'p', '');
  });

  it('should only cancel when flowId is present', () => {
    dispatch('provider_oauth_cancel', {});
    expect(ma.cancelProviderOAuth).not.toHaveBeenCalled();
    dispatch('provider_oauth_cancel', { flowId: 'f' });
    expect(ma.cancelProviderOAuth).toHaveBeenCalledWith('f');
  });

  it('should reject provider_oauth_logout without provider', () => {
    dispatch('provider_oauth_logout');
    expect(onError).toHaveBeenCalled();
    expect(ma.logoutProviderOAuth).not.toHaveBeenCalled();
  });

  it('should forward provider_oauth_logout', () => {
    dispatch('provider_oauth_logout', { provider: 'p' });
    expect(ma.logoutProviderOAuth).toHaveBeenCalledWith('p');
  });
});

describe('probe / refresh / enrich routes', () => {
  it('should reject fetch_models without baseUrl', () => {
    dispatch('fetch_models');
    expect(onError).toHaveBeenCalledWith('bad_message', expect.stringContaining('baseUrl'));
    expect(ma.fetchModelsList).not.toHaveBeenCalled();
  });

  it('should forward fetch_models with optional fields', () => {
    dispatch('fetch_models', {
      baseUrl: 'https://x/v1',
      reqId: 3,
      apiKey: 'k',
      authHeader: true,
      api: 'openai-completions',
      providerId: 'p',
    });
    expect(ma.fetchModelsList).toHaveBeenCalledWith(
      3,
      'https://x/v1',
      'k',
      true,
      'openai-completions',
      undefined,
      'p',
    );
  });

  it('should default fetch_models optionals to undefined / 0', () => {
    dispatch('fetch_models', { baseUrl: 'https://x' });
    expect(ma.fetchModelsList).toHaveBeenCalledWith(
      0,
      'https://x',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
    );
  });

  it('should reject test_model_connection without baseUrl', () => {
    dispatch('test_model_connection');
    expect(onError).toHaveBeenCalledWith('bad_message', expect.stringContaining('baseUrl'));
    expect(ma.testConnection).not.toHaveBeenCalled();
  });

  it('should forward test_model_connection', () => {
    dispatch('test_model_connection', { baseUrl: 'https://x', apiKey: 'k', reqId: 9 });
    expect(ma.testConnection).toHaveBeenCalledWith(
      9,
      'https://x',
      'k',
      undefined,
      undefined,
      undefined,
      undefined,
    );
  });

  it('should reject refresh_provider_models without providerId', () => {
    dispatch('refresh_provider_models');
    expect(onError).toHaveBeenCalled();
    expect(ma.refreshProviderModels).not.toHaveBeenCalled();
  });

  it('should forward refresh_provider_models', () => {
    dispatch('refresh_provider_models', { providerId: 'p', reqId: 2 });
    expect(ma.refreshProviderModels).toHaveBeenCalledWith('p', 2);
  });

  it('should forward refresh_builtin_models with a default reqId', () => {
    dispatch('refresh_builtin_models');
    expect(ma.refreshBuiltinModels).toHaveBeenCalledWith(0);
  });

  it('should reject append_builtin_model without providerId or model.id', () => {
    dispatch('append_builtin_model', { providerId: 'p' });
    dispatch('append_builtin_model', { model: { id: 'm' } });
    dispatch('append_builtin_model', { providerId: 'p', model: { id: '' } });
    expect(onError).toHaveBeenCalledTimes(3);
    expect(ma.appendBuiltinModel).not.toHaveBeenCalled();
  });

  it('should forward append_builtin_model', () => {
    const model = { id: 'm', name: 'M' };
    dispatch('append_builtin_model', { providerId: 'p', model, reqId: 4 });
    expect(ma.appendBuiltinModel).toHaveBeenCalledWith('p', model, 4);
  });

  it('should reject enrich_models without ids', () => {
    dispatch('enrich_models', { ids: [] });
    dispatch('enrich_models', { ids: [1, null] });
    expect(onError).toHaveBeenCalledTimes(2);
    expect(ma.enrichModels).not.toHaveBeenCalled();
  });

  it('should filter non-string ids and pass hints', () => {
    dispatch('enrich_models', { ids: ['a', 7, 'b'], hints: { a: 'hint' }, reqId: 5 });
    expect(ma.enrichModels).toHaveBeenCalledWith(5, ['a', 'b'], { a: 'hint' });
  });

  it('should drop non-object hints', () => {
    dispatch('enrich_models', { ids: ['a'], hints: 'nope' });
    expect(ma.enrichModels).toHaveBeenCalledWith(0, ['a'], undefined);
  });

  it('should forward abort_enrich_models with and without reqId', () => {
    dispatch('abort_enrich_models', { reqId: 6 });
    expect(ma.abortEnrichModels).toHaveBeenCalledWith(6);
    dispatch('abort_enrich_models');
    expect(ma.abortEnrichModels).toHaveBeenLastCalledWith(undefined);
  });
});

describe('default model routes', () => {
  it('should set a non-empty default model', () => {
    dispatch('set_default_model', { modelId: 'anthropic/x' });
    expect(setDefaultModel).toHaveBeenCalledWith('anthropic/x');
  });

  it('should treat an empty modelId as clearing the default', () => {
    dispatch('set_default_model', { modelId: '' });
    expect(setDefaultModel).toHaveBeenCalledWith(null);
  });

  it('should clear the default model', () => {
    dispatch('clear_default_model');
    expect(setDefaultModel).toHaveBeenCalledWith(null);
  });
});

describe('unknown route', () => {
  it('should report an unhandled model-admin message', () => {
    dispatch('not_a_model_admin_message');
    expect(onError).toHaveBeenCalledWith(
      'bad_message',
      'unhandled model-admin message: not_a_model_admin_message',
    );
  });
});
