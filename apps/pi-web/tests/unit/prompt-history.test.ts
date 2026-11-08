import { afterEach, describe, expect, it, vi } from "vitest";
import {
	appendHistory,
	clearPromptHistory,
	loadPromptHistory,
	loadPromptHistorySettings,
	normalizeHistory,
	normalizePromptHistorySettings,
	PROMPT_HISTORY_MAX,
	pushPromptHistory,
	savePromptHistorySettings,
} from "../../src/prompt-history";

const HISTORY_KEY = "pi-web-ui:prompt-history";
const SETTINGS_KEY = "pi-web-ui:prompt-history-settings";

function memoryStorage(initial: Record<string, string> = {}) {
	const store = new Map(Object.entries(initial));
	return {
		store,
		getItem: (key: string) => store.get(key) ?? null,
		setItem: (key: string, value: string) => void store.set(key, value),
		removeItem: (key: string) => void store.delete(key),
	};
}

describe("prompt history persistence", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("loads default settings when storage is missing, empty or corrupt", () => {
		vi.stubGlobal("localStorage", memoryStorage());
		expect(loadPromptHistorySettings()).toEqual({
			maxEntries: 100,
			charLimitEnabled: false,
			charLimit: 2000,
		});

		const corrupt = memoryStorage({ [SETTINGS_KEY]: "{not json" });
		vi.stubGlobal("localStorage", corrupt);
		expect(loadPromptHistorySettings()).toEqual({
			maxEntries: 100,
			charLimitEnabled: false,
			charLimit: 2000,
		});
	});

	it("returns normalized settings from storage", () => {
		vi.stubGlobal(
			"localStorage",
			memoryStorage({
				[SETTINGS_KEY]: JSON.stringify({ maxEntries: 3, charLimit: 500, charLimitEnabled: true }),
			}),
		);

		expect(loadPromptHistorySettings()).toEqual({
			maxEntries: 3,
			charLimitEnabled: true,
			charLimit: 500,
		});
	});

	it("saves normalized settings and trims stored history to the new limits", () => {
		const storage = memoryStorage({
			[HISTORY_KEY]: JSON.stringify(["a".repeat(300), "b", "c", "d"]),
		});
		vi.stubGlobal("localStorage", storage);

		savePromptHistorySettings({ maxEntries: 2, charLimitEnabled: true, charLimit: 100 });

		expect(JSON.parse(storage.getItem(SETTINGS_KEY)!)).toEqual({
			maxEntries: 2,
			charLimitEnabled: true,
			charLimit: 100,
		});
		expect(JSON.parse(storage.getItem(HISTORY_KEY)!)).toEqual(["c", "d"]);
	});

	it("loads history with defaults for missing, corrupt or non-array payloads", () => {
		expect(loadPromptHistory()).toEqual([]);

		const storage = memoryStorage({ [HISTORY_KEY]: "{not json" });
		vi.stubGlobal("localStorage", storage);
		expect(loadPromptHistory()).toEqual([]);

		storage.setItem(HISTORY_KEY, JSON.stringify({ entries: ["a"] }));
		expect(loadPromptHistory()).toEqual([]);

		storage.setItem(HISTORY_KEY, JSON.stringify([" a ", "b", 1, "  "]));
		expect(loadPromptHistory()).toEqual(["a", "b"]);
	});

	it("pushes trimmed history, applies the char limit and skips consecutive duplicates", () => {
		const storage = memoryStorage({
			[SETTINGS_KEY]: JSON.stringify({ maxEntries: 5, charLimit: 100, charLimitEnabled: true }),
			[HISTORY_KEY]: JSON.stringify(["prev"]),
		});
		vi.stubGlobal("localStorage", storage);

		const long = "x".repeat(150);
		pushPromptHistory(`  ${long}  `);
		expect(loadPromptHistory()).toEqual(["prev", "x".repeat(100)]);

		pushPromptHistory(long);
		pushPromptHistory("   ");
		expect(loadPromptHistory()).toEqual(["prev", "x".repeat(100)]);
	});

	it("retries a quota failure with progressively shorter history", () => {
		const storage = memoryStorage({ [HISTORY_KEY]: JSON.stringify(["a", "b", "c", "d"]) });
		let failures = 2;
		vi.stubGlobal("localStorage", {
			getItem: (key: string) => storage.getItem(key),
			setItem: (key: string, value: string) => {
				if (key === HISTORY_KEY && failures-- > 0) {
					throw new DOMException("quota exceeded", "QuotaExceededError");
				}
				storage.setItem(key, value);
			},
			removeItem: (key: string) => storage.removeItem(key),
		});

		pushPromptHistory("e");

		// 5 条 → 失败后保留后 3 条 → 再失败后保留后 1 条（slice(ceil(n/2))）。
		expect(JSON.parse(storage.getItem(HISTORY_KEY)!)).toEqual(["e"]);
	});

	it("clears history and swallows storage failures", () => {
		const storage = memoryStorage({ [HISTORY_KEY]: JSON.stringify(["a"]) });
		vi.stubGlobal("localStorage", storage);

		clearPromptHistory();
		expect(storage.getItem(HISTORY_KEY)).toBeNull();

		vi.stubGlobal("localStorage", {
			getItem() {
				throw new Error("denied");
			},
			setItem() {
				throw new Error("denied");
			},
			removeItem() {
				throw new Error("denied");
			},
		});

		expect(() => clearPromptHistory()).not.toThrow();
		expect(loadPromptHistory()).toEqual([]);
		expect(loadPromptHistorySettings()).toEqual({
			maxEntries: 100,
			charLimitEnabled: false,
			charLimit: 2000,
		});
	});
});

describe("normalizeHistory", () => {
	it("非数组返回空", () => {
		expect(normalizeHistory(null)).toEqual([]);
		expect(normalizeHistory(undefined)).toEqual([]);
		expect(normalizeHistory("x")).toEqual([]);
		expect(normalizeHistory({ a: 1 })).toEqual([]);
	});

	it("过滤非字符串与空白项并 trim", () => {
		expect(normalizeHistory(["  hello  ", "   ", 42, null, "world", ""])).toEqual(["hello", "world"]);
	});

	it("保留合法条目的 trim 结果", () => {
		expect(normalizeHistory([" a ", "b"])).toEqual(["a", "b"]);
	});
});

describe("appendHistory", () => {
	it("空/空白输入原样返回（不产生新引用）", () => {
		const h = ["a", "b"];
		expect(appendHistory(h, "   ")).toBe(h);
		expect(appendHistory(h, "")).toBe(h);
	});

	it("连续重复不入队（返回原引用）", () => {
		const h = ["a", "b"];
		expect(appendHistory(h, "b")).toBe(h);
		expect(appendHistory(h, " b ")).toBe(h);
	});

	it("非重复追加且不改入参", () => {
		const h = ["a"];
		const next = appendHistory(h, "b");
		expect(next).toEqual(["a", "b"]);
		expect(h).toEqual(["a"]);
	});

	it("超出上限时 FIFO 截断", () => {
		const max = 3;
		const h = ["1", "2", "3"];
		const next = appendHistory(h, "4", max);
		expect(next).toEqual(["2", "3", "4"]);
		const next2 = appendHistory(next, "5", max);
		expect(next2).toEqual(["3", "4", "5"]);
	});

	it("默认上限为 PROMPT_HISTORY_MAX", () => {
		const h: string[] = [];
		let cur: string[] = h;
		for (let i = 0; i < PROMPT_HISTORY_MAX + 5; i++) {
			cur = appendHistory(cur, `m${i}`);
		}
		expect(cur.length).toBe(PROMPT_HISTORY_MAX);
		expect(cur[0]).toBe("m5");
		expect(cur[cur.length - 1]).toBe(`m${PROMPT_HISTORY_MAX + 4}`);
	});
});

describe("normalizePromptHistorySettings", () => {
	it("非对象返回默认值", () => {
		expect(normalizePromptHistorySettings(null)).toEqual({
			maxEntries: 100,
			charLimitEnabled: false,
			charLimit: 2000,
		});
	});
	it("范围规整：条数 1-500、字数 100-20000", () => {
		expect(
			normalizePromptHistorySettings({
				maxEntries: 9999,
				charLimit: 1,
				charLimitEnabled: true,
			}),
		).toEqual({
			maxEntries: 500,
			charLimitEnabled: true,
			charLimit: 100,
		});
		expect(normalizePromptHistorySettings({ maxEntries: 0, charLimit: 50000 })).toEqual({
			maxEntries: 1,
			charLimitEnabled: false,
			charLimit: 20000,
		});
	});
});
