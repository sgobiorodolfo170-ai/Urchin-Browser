/**
 * @urchin/summary-agent · 摘要 Agent 类型定义
 *
 * 设计依据：
 * - 摘要模块是当前浏览器架构下唯一的 AI 助手模块（地址栏摘要按钮触发）
 * - 与 pi 模块（@earendil-works/pi-*）相互隔离，不依赖 pi 的 Agent/coding 工具
 * - 单 Agent 设计：调用模型 → 读取网页 → 提取关键信息 → 生成网页格式文档 → 保存到本地
 *
 * 模型配置来源：设置页「AI 助手」选项卡（summary.model / summary.apiKey / summary.baseUrl / summary.providerId）
 *   注意：摘要助手使用 summary.* 设置，与 pi 模块的 ai.* 设置完全独立，两套配置不互通。
 * 保存目录来源：设置页「通用」选项卡（summary.saveDirectory）
 */

// ───────────────── Agent 输入 ─────────────────

/** 摘要 Agent 的输入：待摘要的网页上下文 */
export interface SummaryAgentInput {
  /** 来源 tab ID（用于回溯原始页面） */
  readonly tabId: number;
  /** 原始页面 URL */
  readonly url: string;
  /** 原始页面标题 */
  readonly title: string;
  /** 提取的页面正文（来自 page.extract） */
  readonly content: string;
  /** 页面正文的语言（可选，辅助模型理解） */
  readonly language?: string;
  /** 站点名（可选） */
  readonly siteName?: string;
}

// ───────────────── Agent 输出 ─────────────────

/**
 * 摘要 Agent 的输出：生成的网页格式文档。
 *
 * Agent 流程：
 * 1. 读取网页正文（SummaryAgentInput.content）
 * 2. 调用模型提取关键信息，整理为结构化文档
 * 3. 制作网页组件排版，生成自包含 HTML
 * 4. 返回 HTML 内容供主进程保存到本地
 */
export interface SummaryAgentOutput {
  /** 生成的自包含 HTML 文档（含内联 CSS，无外部依赖） */
  readonly html: string;
  /** 文档标题（用于文件名与目录树显示） */
  readonly documentTitle: string;
  /** 摘要摘要（一句话，用于目录树预览） */
  readonly summary: string;
  /** Agent 提取的关键词列表（用于分类与检索） */
  readonly keywords: readonly string[];
}

// ───────────────── Agent 配置 ─────────────────

/**
 * 摘要 Agent 运行时配置。
 *
 * 从设置页「AI 助手」选项卡读取，由主进程注入。
 * 与 pi 模块的 AgentConfigProvider 隔离，摘要模块直接使用 OpenAI 兼容协议调用模型，
 * 不经过 Orchestrator / Provider 子进程，避免与 pi 模块产生耦合。
 */
export interface SummaryAgentConfig {
  /** 模型名（如 gpt-4o-mini / claude-sonnet-4-5） */
  readonly model: string;
  /** API Key */
  readonly apiKey: string;
  /** OpenAI 兼容端点（留空使用官方 https://api.openai.com） */
  readonly baseUrl?: string;
  /** 生成温度（0-2，默认 0.3 偏严谨提取） */
  readonly temperature?: number;
  /** 最大输出 token（默认 4096） */
  readonly maxTokens?: number;
}

// ───────────────── Agent 接口 ─────────────────

/**
 * 摘要 Agent 接口契约。
 *
 * 实现方负责：
 * 1. 构建 system prompt（指导模型提取关键信息并生成网页格式文档）
 * 2. 调用 OpenAI 兼容 /v1/chat/completions 端点
 * 3. 解析模型返回，构造 SummaryAgentOutput
 *
 * 流式输出回调（可选）：用于在 UI 上显示生成进度
 */
export interface SummaryAgent {
  /**
   * 对给定网页执行摘要生成。
   *
   * @param input 网页上下文
   * @param config 模型配置
   * @param onProgress 流式进度回调（可选，接收增量文本）
   * @returns 生成的网页格式文档
   */
  run(
    input: SummaryAgentInput,
    config: SummaryAgentConfig,
    onProgress?: (delta: string) => void,
  ): Promise<SummaryAgentOutput>;

  /** 中止当前正在执行的摘要生成 */
  abort(): void;
}

// ───────────────── 文档目录树 ─────────────────

/**
 * 保存的摘要文档在本地目录树中的节点。
 *
 * 目录结构示例：
 *   <saveDirectory>/
 *     2026-07/                    ← 按年月分组的目录节点
 *       2026-07-31_网页标题.html   ← 文档叶节点
 *       2026-07-30_另一篇文章.html
 *     2026-06/
 *       ...
 *
 * 左侧边栏以目录树形式展示此结构，点击叶节点在浏览器中打开对应 HTML 文件。
 */
export interface SummaryTreeNode {
  /** 节点类型：目录（可展开）或文件（可打开） */
  readonly type: 'directory' | 'file';
  /** 节点显示名（目录名或文件名，不含路径） */
  readonly name: string;
  /** 相对于保存根目录的路径（目录节点以 / 结尾） */
  readonly relativePath: string;
  /** 子节点（仅 directory 类型有） */
  readonly children?: readonly SummaryTreeNode[];
  /** 文件绝对路径（仅 file 类型，用于打开） */
  readonly absolutePath?: string;
  /** 文件大小（字节，仅 file 类型） */
  readonly size?: number;
  /** 最后修改时间（ms 时间戳，仅 file 类型） */
  readonly modifiedAt?: number;
}

// ───────────────── 保存结果 ─────────────────

/** 摘要文档保存结果 */
export interface SummarySaveResult {
  /** 保存的文件绝对路径 */
  readonly filePath: string;
  /** 相对于保存根目录的路径 */
  readonly relativePath: string;
  /** 文档标题 */
  readonly documentTitle: string;
}
