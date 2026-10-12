import { mock } from "bun:test";
import * as fakes from "./obsidian-fakes";

// Registered once, before any test file loads, so every file sees the same "obsidian" module. Every export of
// obsidian-fakes.ts is part of it; the helper names (setFakePlatform and similar) are harmless extras.
mock.module("obsidian", () => ({ ...fakes }));

// Plugin code calls window timers for popout compatibility; bun has no window, so the global scope stands in for it.
if (!("window" in globalThis)) {
	Object.defineProperty(globalThis, "window", { value: globalThis, configurable: true });
}
