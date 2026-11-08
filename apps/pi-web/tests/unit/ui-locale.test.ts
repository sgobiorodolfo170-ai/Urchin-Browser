import { afterEach, describe, expect, it, vi } from "vitest";
import { announceUiLocale, currentUiLocale, initializeUiLocale, UI_LOCALE_EVENT } from "../../src/ui-locale";

describe("ui locale reporting", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("uses the browser-selected locale as the effective hello locale", () => {
		const setItem = vi.fn();
		vi.stubGlobal("localStorage", { getItem: vi.fn(() => null), setItem });

		expect(initializeUiLocale(null, ["zh-TW", "en-US"])).toBe("zh-TW");
		expect(currentUiLocale()).toBe("zh-TW");
		expect(setItem).not.toHaveBeenCalled();
	});

	it("broadcasts an automatic locale without persisting it", () => {
		const setItem = vi.fn();
		const dispatchEvent = vi.fn();
		vi.stubGlobal("localStorage", { getItem: vi.fn(() => null), setItem });
		vi.stubGlobal("window", { dispatchEvent });

		announceUiLocale("zh-Hant");

		expect(currentUiLocale()).toBe("zh-Hant");
		expect(setItem).not.toHaveBeenCalled();
		expect(dispatchEvent).toHaveBeenCalledTimes(1);
		const event = dispatchEvent.mock.calls[0]?.[0] as CustomEvent<string>;
		expect(event.type).toBe(UI_LOCALE_EVENT);
		expect(event.detail).toBe("zh-Hant");
	});

	it("ignores empty locale announcements", () => {
		const dispatchEvent = vi.fn();
		vi.stubGlobal("window", { dispatchEvent });
		initializeUiLocale(null, ["en"]);

		announceUiLocale("  ");

		expect(currentUiLocale()).toBe("en");
		expect(dispatchEvent).not.toHaveBeenCalled();
	});

	it("restores the saved locale when nothing has been announced yet", async () => {
		vi.stubGlobal("localStorage", { getItem: () => "ja-JP" });
		vi.stubGlobal("navigator", { languages: ["en-US"] });
		vi.resetModules();

		const mod = await import("../../src/ui-locale");

		expect(mod.currentUiLocale()).toBe("ja-JP");
	});

	it("falls back to browser languages when storage is unavailable", async () => {
		vi.stubGlobal("localStorage", {
			getItem() {
				throw new Error("denied");
			},
		});
		vi.stubGlobal("navigator", { languages: ["en-GB"] });
		vi.resetModules();

		const mod = await import("../../src/ui-locale");

		expect(mod.currentUiLocale()).toBe("en");
	});

	it("broadcasts without a window object instead of throwing", async () => {
		vi.stubGlobal("localStorage", { getItem: () => null });
		vi.resetModules();

		const mod = await import("../../src/ui-locale");

		expect(() => mod.announceUiLocale("de-DE")).not.toThrow();
		expect(mod.currentUiLocale()).toBe("de-DE");
	});
});
