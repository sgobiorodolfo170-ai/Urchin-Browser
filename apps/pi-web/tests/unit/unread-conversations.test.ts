import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
	markConversationUnread,
	markConversationsUnread,
	clearConversationUnread,
	clearAllUnread,
	isConversationUnread,
	unreadStore,
	useUnreadConversationKeys,
} from "../../src/unread-conversations";

describe("unread-conversations store", () => {
	beforeEach(() => {
		clearAllUnread();
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("marks conversation as unread and checks by id, sessionId, sessionFile, or path", () => {
		markConversationUnread({
			id: "c-123",
			sessionId: "sid-456",
			sessionFile: "/path/to/session.jsonl",
		});

		expect(isConversationUnread({ id: "c-123" })).toBe(true);
		expect(isConversationUnread({ sessionId: "sid-456" })).toBe(true);
		expect(isConversationUnread({ sessionFile: "/path/to/session.jsonl" })).toBe(true);
		expect(isConversationUnread({ id: "other" })).toBe(false);

		expect(isConversationUnread({ id: "C-123" })).toBe(true);
		expect(isConversationUnread({ sessionId: "SID-456" })).toBe(true);
	});

	it("clearing by id clears all associated keys", () => {
		markConversationUnread({
			id: "c-1",
			sessionId: "sid-1",
			sessionFile: "/sessions/s1.jsonl",
		});

		expect(isConversationUnread({ id: "c-1" })).toBe(true);
		expect(isConversationUnread({ sessionId: "sid-1" })).toBe(true);

		clearConversationUnread("c-1");

		expect(isConversationUnread({ id: "c-1" })).toBe(false);
		expect(isConversationUnread({ sessionId: "sid-1" })).toBe(false);
		expect(isConversationUnread({ sessionFile: "/sessions/s1.jsonl" })).toBe(false);
	});

	it("clearing by sessionId or file also clears primary id", () => {
		markConversationUnread({
			id: "c-2",
			sessionId: "sid-2",
			sessionFile: "/sessions/s2.jsonl",
		});

		expect(isConversationUnread({ id: "c-2" })).toBe(true);

		clearConversationUnread("sid-2");

		expect(isConversationUnread({ id: "c-2" })).toBe(false);
		expect(isConversationUnread({ sessionId: "sid-2" })).toBe(false);
	});

	it("batches marking multiple conversations", () => {
		markConversationsUnread([
			{ id: "c-a", sessionId: "sid-a" },
			{ id: "c-b", sessionId: "sid-b" },
		]);

		expect(isConversationUnread({ id: "c-a" })).toBe(true);
		expect(isConversationUnread({ id: "c-b" })).toBe(true);

		clearConversationUnread("c-a");
		expect(isConversationUnread({ id: "c-a" })).toBe(false);
		expect(isConversationUnread({ id: "c-b" })).toBe(true);

		clearAllUnread();
		expect(isConversationUnread({ id: "c-b" })).toBe(false);
	});

	it("matches and clears by path, ignoring case and surrounding whitespace", () => {
		markConversationUnread({ id: "c-path", path: "/Workspace/A.md" });

		expect(isConversationUnread({ path: "/workspace/a.md" })).toBe(true);
		expect(isConversationUnread({ path: "  /WORKSPACE/A.MD  " })).toBe(true);

		clearConversationUnread("  /workspace/A.md  ");

		expect(isConversationUnread({ id: "c-path" })).toBe(false);
		expect(isConversationUnread({ path: "/Workspace/A.md" })).toBe(false);
	});

	it("ignores empty ids and empty clear keys", () => {
		markConversationsUnread([{ id: "" }, { id: "c-keep" }]);

		expect(isConversationUnread({ id: "c-keep" })).toBe(true);

		clearConversationUnread("   ");
		clearConversationUnread(null);
		clearConversationUnread(undefined);

		expect(isConversationUnread({ id: "c-keep" })).toBe(true);
	});

	it("notifies subscribers once per change and survives throwing listeners", () => {
		const calls: number[] = [];
		const unsubscribe = unreadStore.subscribe(() => calls.push(1));
		const unsubscribeThrow = unreadStore.subscribe(() => {
			throw new Error("listener exploded");
		});

		markConversationUnread({ id: "c-sub" });
		expect(calls).toHaveLength(1);

		clearAllUnread();
		expect(calls).toHaveLength(2);

		unsubscribe();
		unsubscribeThrow();
		markConversationUnread({ id: "c-sub-2" });
		expect(calls).toHaveLength(2);
	});

	it("persists entries to sessionStorage and removes the key when cleared", () => {
		const stored = new Map<string, string>();
		vi.stubGlobal("window", {
			sessionStorage: {
				getItem: (key: string) => stored.get(key) ?? null,
				setItem: (key: string, value: string) => void stored.set(key, value),
				removeItem: (key: string) => void stored.delete(key),
			},
		});

		markConversationUnread({ id: "c-persist", sessionId: "sid-persist" });

		const raw = stored.get("pi.unread_conversations");
		expect(raw).toBeDefined();
		expect(JSON.parse(raw!)).toEqual([
			expect.objectContaining({ id: "c-persist", sessionId: "sid-persist" }),
		]);

		clearAllUnread();
		expect(stored.has("pi.unread_conversations")).toBe(false);
	});

	it("swallows sessionStorage failures instead of breaking the store", () => {
		vi.stubGlobal("window", {
			sessionStorage: {
				getItem() {
					throw new Error("denied");
				},
				setItem() {
					throw new Error("denied");
				},
				removeItem() {
					throw new Error("denied");
				},
			},
		});

		expect(() => markConversationUnread({ id: "c-denied" })).not.toThrow();
		expect(isConversationUnread({ id: "c-denied" })).toBe(true);
		expect(() => clearAllUnread()).not.toThrow();
	});

	it("restores fresh entries and drops stale or malformed ones on load", async () => {
		const now = Date.now();
		vi.stubGlobal("window", {
			sessionStorage: {
				getItem: () =>
					JSON.stringify([
						{ id: "c-fresh", finishedAt: now },
						{ id: "c-stale", finishedAt: now - 8 * 24 * 3600 * 1000 },
						{ id: 42 },
					]),
				setItem() {},
				removeItem() {},
			},
		});
		vi.resetModules();

		const mod = await import("../../src/unread-conversations");

		expect(mod.isConversationUnread({ id: "c-fresh" })).toBe(true);
		expect(mod.isConversationUnread({ id: "c-stale" })).toBe(false);
	});

	it("ignores malformed persisted payloads on load", async () => {
		vi.stubGlobal("window", {
			sessionStorage: {
				getItem: () => "{not json",
				setItem() {},
				removeItem() {},
			},
		});
		vi.resetModules();

		const mod = await import("../../src/unread-conversations");

		expect(mod.isConversationUnread({ id: "anything" })).toBe(false);
	});

	it("exposes the unread key snapshot through the hook", () => {
		markConversationUnread({ id: "c-hook" });

		function Probe() {
			const keys = useUnreadConversationKeys();
			return createElement("span", null, String(keys.has("c-hook")));
		}

		expect(renderToStaticMarkup(createElement(Probe))).toBe("<span>true</span>");
	});
});
