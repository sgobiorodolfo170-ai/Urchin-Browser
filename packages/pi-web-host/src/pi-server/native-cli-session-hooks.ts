import { createHash } from "node:crypto";
import { portableAtomicWriteSyncSource } from "./atomic-file.js";

/** Lifecycle data is deliberately independent of prompt/tool/result payloads. */
export type NativeCliSessionEvent =
	| { type: "session"; eventId: string; nativeId: string; cursor?: string }
	| { type: "submitted"; eventId: string }
	| { type: "working" | "question" | "approval"; eventId: string }
	| { type: "done"; eventId: string; aborted?: boolean }
	| { type: "error"; eventId: string; code: string; message: string };

export type NativeCliHookEvent = {
	type: "session" | "submitted" | "working" | "done" | "question" | "approval" | "error";
	eventId: string;
	nativeId?: string;
	aborted?: boolean;
};

export const NATIVE_CLI_EVENT_LIMIT = 128;
export const NATIVE_CLI_EVENT_BYTES = 2048;
const EVENT_TYPES = new Set(["session", "submitted", "working", "done", "question", "approval", "error"]);

/** Parse only our reporter's small whitelist, never CLI output or transcript content. */
export function parseNativeCliHookEvent(text: string): NativeCliHookEvent | undefined {
	if (Buffer.byteLength(text) > NATIVE_CLI_EVENT_BYTES) return undefined;
	try {
		const value = JSON.parse(text);
		if (!value || !EVENT_TYPES.has(value.type) || typeof value.eventId !== "string") return undefined;
		if (!/^[a-zA-Z0-9_.:-]{1,200}$/.test(value.eventId)) return undefined;
		const nativeId = value.nativeId;
		if (
			nativeId !== undefined &&
			(typeof nativeId !== "string" || nativeId.length > 1024 || /[\x00-\x1f\x7f]/.test(nativeId))
		)
			return undefined;
		return {
			type: value.type,
			eventId: value.eventId,
			...(nativeId ? { nativeId } : {}),
			...(value.type === "done" && value.aborted === true ? { aborted: true } : {}),
		};
	} catch {
		return undefined;
	}
}

export function nativeCliEventId(value: string): string {
	return createHash("sha256").update(value).digest("hex").slice(0, 32);
}

export function quoteNativeCliShell(value: string): string {
	return `'${value.replace(/'/g, `'"'"'`)}'`;
}

/**
 * 2026-11-09（P2-2 死链定性）：此处原有 `nativeCliPosixReporter()`（Claude/Codex 的 POSIX
 * hook 上报脚本，60 行）。它的唯一入口是 `native-cli-session.ts` 里从未被调用的
 * `const reporter = …`；本仓 `NativeCliPreset` 只剩 `pi` / `custom`（engine-catalog.ts），
 * 没有任何分支会写出或执行这段 hook.sh。pi 预设的原生事件由下方的
 * `nativeCliPiExtension()`（--extension）产生，与本脚本无关。
 * 恢复路径：`git show 3fcabf83:packages/pi-web-host/src/pi-server/native-cli-session-hooks.ts`
 * 或上游 pi-web-ui 同名文件。
 */

/** Uses Pi's public extension API and final-settlement/UI events, not screen text. */
export function nativeCliPiExtension(directory: string): string {
	return `import { mkdirSync, readdirSync, unlinkSync, existsSync, chmodSync } from "node:fs";
import * as atomicFs from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
const directory = ${JSON.stringify(directory)};
${portableAtomicWriteSyncSource()}
export default function(pi) {
 let failed = false;
 const report = (type, ctx, aborted) => {
  try {
   const events = join(directory, "events");
   mkdirSync(events, { recursive: true, mode: 0o700 });
   const eventId = String(Date.now()).padEnd(19, "0") + "-" + randomUUID();
   const nativeId = ctx.sessionManager.getSessionFile();
   const record = { eventId, type, ...(nativeId && existsSync(nativeId) ? { nativeId } : {}), ...(type === "done" && aborted === true ? { aborted: true } : {}) };
   if (record.nativeId) {
    chmodSync(record.nativeId, 0o600);
    const binding = join(directory, "native-id");
    writeAtomicPortable(atomicFs, binding, record.nativeId, randomUUID(), 0o600);
   }
   const file = join(events, eventId + ".json");
   writeAtomicPortable(atomicFs, file, JSON.stringify(record), randomUUID(), 0o600);
   const names = readdirSync(events).filter(name => /^[a-zA-Z0-9_.-]+\\.json$/.test(name)).sort();
   for (const name of names.slice(0, Math.max(0, names.length - ${NATIVE_CLI_EVENT_LIMIT}))) { try { unlinkSync(join(events, name)); } catch {} }
  } catch { /* A reporter must never interrupt the CLI. */ }
 };
 pi.on("session_start", (_event, ctx) => report("session", ctx));
 pi.on("input", (event, ctx) => { if (event.source === "interactive") report("submitted", ctx); });
 pi.on("agent_start", (_event, ctx) => { failed = false; report("working", ctx); });
 pi.on("agent_settled", (event, ctx) => report(!event.aborted && failed ? "error" : "done", ctx, event.aborted));
 pi.on("message_end", (event) => { if (event.message?.role === "assistant") failed = event.message.stopReason === "error"; });
 pi.on("ui_prompt_start", (event, ctx) => report(event.kind === "confirm" ? "approval" : "question", ctx));
 pi.on("ui_prompt_end", (_event, ctx) => report(ctx.isIdle() ? "done" : "working", ctx));
}
`;
}
