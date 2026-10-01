import { mock } from "bun:test";
import { Editor, MarkdownView, TAbstractFile, TFile, TFolder, normalizePath } from "./obsidian-fakes";

// Registered once, before any test file loads, so every file sees the same "obsidian" module.
mock.module("obsidian", () => ({ Editor, MarkdownView, TAbstractFile, TFile, TFolder, normalizePath }));
