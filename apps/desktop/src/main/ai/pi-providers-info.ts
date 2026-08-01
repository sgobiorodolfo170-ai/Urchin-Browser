/**
 * pi 内置 Provider 元信息（方案 A 适配层）
 *
 * 职责：
 * 返回 pi 仓库内置 39 个 provider 的静态元信息（id/name/baseUrl/apiKeyEnvVar/supportsOAuth），
 * 供渲染层 pi 设置对话框的 provider 下拉选择使用。
 *
 * 设计理由：
 * 不直接调用 pi 的 `builtinProviders()` 工厂，因为那会触发所有 provider 子模块的加载
 * （包括各 provider 的 models 列表和 lazy API 包装器）。本模块维护一份精简的元信息表，
 * 字段从 vendor/pi/packages/ai/src/providers/*.ts 和 env-api-keys.ts 中提取。
 *
 * 维护：当 pi 升级新增 provider 时，需同步在此添加条目。
 * 可通过 `pnpm run check-pi-providers`（如有）对照 vendor/pi/packages/ai/src/providers/all.ts 校验。
 */
import type { PiProviderInfo } from '@urchin/ipc-contract';

/** pi 内置 Provider 元信息表（按 provider id 字母序） */
const PI_PROVIDERS: readonly PiProviderInfo[] = [
  { id: 'amazon-bedrock', name: 'Amazon Bedrock', supportsOAuth: false },
  { id: 'ant-ling', name: 'Ant Ling', apiKeyEnvVar: 'ANT_LING_API_KEY', supportsOAuth: false },
  {
    id: 'anthropic',
    name: 'Anthropic',
    baseUrl: 'https://api.anthropic.com',
    apiKeyEnvVar: 'ANTHROPIC_API_KEY',
    supportsOAuth: true,
  },
  {
    id: 'azure-openai-responses',
    name: 'Azure OpenAI Responses',
    apiKeyEnvVar: 'AZURE_OPENAI_API_KEY',
    supportsOAuth: false,
  },
  { id: 'cerebras', name: 'Cerebras', apiKeyEnvVar: 'CEREBRAS_API_KEY', supportsOAuth: false },
  {
    id: 'cloudflare-ai-gateway',
    name: 'Cloudflare AI Gateway',
    apiKeyEnvVar: 'CLOUDFLARE_API_KEY',
    supportsOAuth: false,
  },
  {
    id: 'cloudflare-workers-ai',
    name: 'Cloudflare Workers AI',
    apiKeyEnvVar: 'CLOUDFLARE_API_KEY',
    supportsOAuth: false,
  },
  { id: 'deepseek', name: 'DeepSeek', apiKeyEnvVar: 'DEEPSEEK_API_KEY', supportsOAuth: false },
  { id: 'fireworks', name: 'Fireworks', apiKeyEnvVar: 'FIREWORKS_API_KEY', supportsOAuth: false },
  {
    id: 'github-copilot',
    name: 'GitHub Copilot',
    apiKeyEnvVar: 'COPILOT_GITHUB_TOKEN',
    supportsOAuth: false,
  },
  {
    id: 'google',
    name: 'Google',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    apiKeyEnvVar: 'GEMINI_API_KEY',
    supportsOAuth: false,
  },
  {
    id: 'google-vertex',
    name: 'Google Vertex AI',
    apiKeyEnvVar: 'GOOGLE_CLOUD_API_KEY',
    supportsOAuth: false,
  },
  { id: 'groq', name: 'Groq', apiKeyEnvVar: 'GROQ_API_KEY', supportsOAuth: false },
  { id: 'huggingface', name: 'Hugging Face', apiKeyEnvVar: 'HF_TOKEN', supportsOAuth: false },
  { id: 'kimi-coding', name: 'Kimi Coding', apiKeyEnvVar: 'KIMI_API_KEY', supportsOAuth: false },
  { id: 'minimax', name: 'MiniMax', apiKeyEnvVar: 'MINIMAX_API_KEY', supportsOAuth: false },
  {
    id: 'minimax-cn',
    name: 'MiniMax (CN)',
    apiKeyEnvVar: 'MINIMAX_CN_API_KEY',
    supportsOAuth: false,
  },
  {
    id: 'mistral',
    name: 'Mistral',
    baseUrl: 'https://api.mistral.ai',
    apiKeyEnvVar: 'MISTRAL_API_KEY',
    supportsOAuth: false,
  },
  { id: 'moonshotai', name: 'Moonshot AI', apiKeyEnvVar: 'MOONSHOT_API_KEY', supportsOAuth: false },
  {
    id: 'moonshotai-cn',
    name: 'Moonshot AI (CN)',
    apiKeyEnvVar: 'MOONSHOT_API_KEY',
    supportsOAuth: false,
  },
  { id: 'nvidia', name: 'NVIDIA', apiKeyEnvVar: 'NVIDIA_API_KEY', supportsOAuth: false },
  {
    id: 'openai',
    name: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    apiKeyEnvVar: 'OPENAI_API_KEY',
    supportsOAuth: false,
  },
  {
    id: 'openai-codex',
    name: 'OpenAI Codex',
    baseUrl: 'https://api.openai.com/v1',
    apiKeyEnvVar: 'OPENAI_API_KEY',
    supportsOAuth: false,
  },
  { id: 'opencode', name: 'OpenCode', apiKeyEnvVar: 'OPENCODE_API_KEY', supportsOAuth: false },
  {
    id: 'opencode-go',
    name: 'OpenCode Go',
    apiKeyEnvVar: 'OPENCODE_API_KEY',
    supportsOAuth: false,
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    apiKeyEnvVar: 'OPENROUTER_API_KEY',
    supportsOAuth: false,
  },
  {
    id: 'qwen-token-plan',
    name: 'Qwen Token Plan',
    apiKeyEnvVar: 'QWEN_TOKEN_PLAN_API_KEY',
    supportsOAuth: false,
  },
  {
    id: 'qwen-token-plan-cn',
    name: 'Qwen Token Plan (CN)',
    apiKeyEnvVar: 'QWEN_TOKEN_PLAN_CN_API_KEY',
    supportsOAuth: false,
  },
  { id: 'radius', name: 'Radius', apiKeyEnvVar: 'RADIUS_API_KEY', supportsOAuth: true },
  { id: 'together', name: 'Together', apiKeyEnvVar: 'TOGETHER_API_KEY', supportsOAuth: false },
  {
    id: 'vercel-ai-gateway',
    name: 'Vercel AI Gateway',
    apiKeyEnvVar: 'AI_GATEWAY_API_KEY',
    supportsOAuth: false,
  },
  { id: 'xai', name: 'xAI', apiKeyEnvVar: 'XAI_API_KEY', supportsOAuth: false },
  { id: 'xiaomi', name: 'Xiaomi', apiKeyEnvVar: 'XIAOMI_API_KEY', supportsOAuth: false },
  {
    id: 'xiaomi-token-plan-ams',
    name: 'Xiaomi Token Plan (AMS)',
    apiKeyEnvVar: 'XIAOMI_TOKEN_PLAN_AMS_API_KEY',
    supportsOAuth: false,
  },
  {
    id: 'xiaomi-token-plan-cn',
    name: 'Xiaomi Token Plan (CN)',
    apiKeyEnvVar: 'XIAOMI_TOKEN_PLAN_CN_API_KEY',
    supportsOAuth: false,
  },
  {
    id: 'xiaomi-token-plan-sgp',
    name: 'Xiaomi Token Plan (SGP)',
    apiKeyEnvVar: 'XIAOMI_TOKEN_PLAN_SGP_API_KEY',
    supportsOAuth: false,
  },
  { id: 'zai', name: 'ZAI', apiKeyEnvVar: 'ZAI_API_KEY', supportsOAuth: false },
  {
    id: 'zai-coding-cn',
    name: 'ZAI Coding (CN)',
    apiKeyEnvVar: 'ZAI_CODING_CN_API_KEY',
    supportsOAuth: false,
  },
];

/** 缓存结果（元信息不可变，进程内只计算一次） */
let cachedResult:
  { providers: readonly PiProviderInfo[]; generatedAt: number | undefined } | undefined;

/**
 * 返回 pi 内置 Provider 元信息列表。
 *
 * 数据来源：vendor/pi/packages/ai/src/providers/*.ts（baseUrl/name）
 * 和 env-api-keys.ts（apiKeyEnvVar）。
 */
export function getPiBuiltinProvidersInfo(): {
  providers: readonly PiProviderInfo[];
  generatedAt: number | undefined;
} {
  cachedResult ??= {
    providers: PI_PROVIDERS,
    // 数据生成时间戳暂不暴露（pi 的 .manifest.json 路径在子模块中，避免额外 import）
    generatedAt: undefined,
  };
  return cachedResult;
}
