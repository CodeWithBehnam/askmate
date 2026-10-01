/**
 * Fakes for the parts of the Obsidian API that services under test import at runtime.
 *
 * bun's mock.module() replaces "obsidian" for the whole test run, so every test file must share one set of fakes:
 * per-file mocks with different exports break depending on which file the runner loads first.
 * tests/support/obsidian-preload.ts registers these before any test file runs; tests import the same classes from here
 * so `instanceof` checks inside the services match the objects the tests create.
 */

export class TAbstractFile {
	constructor(public path = "") {}

	get name(): string {
		return this.path.split("/").pop() ?? "";
	}
}

export class TFile extends TAbstractFile {
	stat = { size: 10, ctime: 0, mtime: 0 };

	get extension(): string {
		return this.name.includes(".") ? this.name.split(".").pop() ?? "" : "";
	}

	get basename(): string {
		return this.name.includes(".") ? this.name.slice(0, this.name.lastIndexOf(".")) : this.name;
	}
}

export class TFolder extends TAbstractFile {}

export class Editor {}

export class MarkdownView<TEditor = unknown> {
	mode: "source" | "preview" = "source";

	constructor(public editor: TEditor, public file: TFile | null) {}

	getMode(): "source" | "preview" {
		return this.mode;
	}
}

export function normalizePath(path: string): string {
	return path.replace(/\\/g, "/").replace(/\/+/g, "/").replace(/^\/+|\/+$/g, "") || "/";
}
