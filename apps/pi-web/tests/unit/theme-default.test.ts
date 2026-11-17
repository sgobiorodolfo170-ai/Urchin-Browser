// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { loadTheme, useTheme } from "../../src/theme";
vi.mock("../../src/app-globals", () => ({ useAppField: () => "closed" }));
afterEach(() => { localStorage.clear(); document.getElementById("theme-stylesheet")?.remove(); vi.unstubAllGlobals(); });
describe("theme defaults", () => {
  it("uses Geist when no choice is saved and preserves explicit choices", () => {
    expect(loadTheme()).toBe("geist");
    localStorage.setItem("pi-web-ui:theme", "nord");
    expect(loadTheme()).toBe("nord");
    localStorage.setItem("pi-web-ui:theme", "dark");
    expect(loadTheme()).toBeNull();
  });
  it("applies the new default stylesheet and remembers an explicit dark choice", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ themes: [] }) }));
    const { result, unmount } = renderHook(() => useTheme());
    await waitFor(() => expect(document.documentElement.dataset.theme).toBe("geist"));
    expect(document.getElementById("theme-stylesheet")?.getAttribute("href")).toContain("geist.css");
    act(() => result.current.switchTheme(null));
    expect(localStorage.getItem("pi-web-ui:theme")).toBe("dark");
    expect(loadTheme()).toBeNull();
    unmount();
  });
});
