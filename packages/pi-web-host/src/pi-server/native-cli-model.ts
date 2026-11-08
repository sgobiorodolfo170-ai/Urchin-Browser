import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { NativeCliConfig } from "./protocol.js";

export interface NativeCliModelConnection {
	baseUrl: string;
	apiKey: string;
	headers?: Record<string, string>;
}

/**
 * 解析原生 CLI 可继承的模型连接（凭据 env 注入）。
 *
 * 当前引擎目录已裁剪为 `pi` 与 `custom`（见 engine-catalog.ts）：
 * - `pi` 通过 `--provider/--model` 参数继承模型（nativeCliLaunchArgs），不需要 env 注入；
 * - `custom` 不继承模型。
 *
 * 上游 `claude` / `codex` 的注入分支已随引擎裁剪失效：`NativeCliPreset` 不再包含它们，
 * 原先的 `preset !== "claude" && preset !== "codex"` 恒真早退且触发 TS2367（D5）。
 * 这里保留函数签名供 terminals / native-cli 调用链复用，行为明确为「不注入」。
 */
export async function resolveNativeCliModelConnection(
	_config: NativeCliConfig,
	_runtime: ModelRuntime | undefined,
): Promise<NativeCliModelConnection | undefined> {
	return undefined;
}

/**
 * 同上：当前引擎不需要在启动时注入模型相关环境变量或额外参数。
 *
 * 保留返回结构，让调用方（native-cli / remote-native-cli）无需关心引擎裁剪细节。
 */
export function nativeCliModelLaunch(
	_config: NativeCliConfig,
	_connection: NativeCliModelConnection | undefined,
	_parentEnv: NodeJS.ProcessEnv,
): { args: string[]; env?: NodeJS.ProcessEnv; unsetEnv?: string[] } {
	return { args: [] };
}