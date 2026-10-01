import { mock } from "bun:test";
import { Editor, MarkdownView, TAbstractFile, TFile, TFolder, normalizePath } from "./obsidian-fakes";

// Registered once, before any test file loads, so every file sees the same "obsidian" module.
mock.module("obsidian", () => ({ Editor, MarkdownView, TAbstractFile, TFile, TFolder, normalizePath }));

// Plugin code calls window timers for popout compatibility; bun has no window, so the global scope stands in for it.
if (!("window" in globalThis)) {
	Object.defineProperty(globalThis, "window", { value: globalThis, configurable: true });
}
