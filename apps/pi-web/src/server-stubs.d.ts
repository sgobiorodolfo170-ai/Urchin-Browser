/**
 * Type stubs for server modules imported by pi-web-ui components.
 * Path patterns match imports WITHOUT .js extension (fix-paths-v2 removed them).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

declare module '*/tool-manager' {
  export const BROWSER_PAGE_TOOL_NAME: Any;
  export const PRESENT_FILES_TOOL_NAME: Any;
  export const AGENT_TOOL_CATALOG: Any[];
  export const CORE_TOOL_CATALOG: Any[];
  export const TERMINAL_TOOL_NAMES: Any[];
  export const SUBAGENT_TOOL_NAMES: Any[];
  export function filterToolsByPreset(...args: Any[]): Any;
  export function presetShowsSkillCatalog(...args: Any[]): boolean;
}

declare module '*/text-quote' {
  export interface TextQuote {
    text: string;
    messageId: string;
    role: string;
  }
  export function readTextQuote(...args: Any[]): TextQuote;
  export function splitQuotedPrompt(text: string): {
    text: string;
    quotes: Any[];
    attachments: Any[];
  };
  export function formatStreamingPrompt(text: string): string;
}

declare module '*/preset-fields' {
  export function groupPresetFields(...args: Any[]): Any[];
  export function presetFieldLabel(...args: Any[]): string;
  export function presetFieldHint(...args: Any[]): string;
  export function formatPresetFieldValue(...args: Any[]): string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export type PresetFieldGroup = any;
}

declare module '*/prompt-composer' {
  export const DEFAULT_PROMPT_TEMPLATE: Any;
  export const PROMPT_TOKENS: Any;
  export function estimatePromptTokens(...args: Any[]): number;
  export function isReadonlyPromptSource(...args: Any[]): boolean;
}

declare module '*/queue-utils' {
  export function removeQueuedByIndexOrText(...args: Any[]): void;
}

declare module '*/approval-default-rules' {
  export const DEFAULT_APPROVAL_RULES: Any[];
}

declare module 'html-to-image' {
  export function toPng(el: HTMLElement, opts?: Record<string, unknown>): Promise<string>;
  export function toBlob(el: HTMLElement, opts?: Record<string, unknown>): Promise<Blob>;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
declare module 'unified' {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export type PluggableList = any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export function unified(): any;
}

declare module '@xterm/xterm' {
  export class Terminal {
    constructor(opts?: Any);
    open(el: HTMLElement): void;
    write(data: string): void;
    onData(cb: (data: string) => void): void;
    dispose(): void;
  }
}

declare module '@xterm/addon-fit' {
  export class FitAddon {
    fit(): void;
  }
}

declare module '@xterm/xterm/css/xterm.css' {}
