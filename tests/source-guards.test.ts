import { describe, expect, test } from "bun:test";
import { FORBIDDEN_SOURCE_PATTERNS } from "../scripts/roadmap-smoke-tests";

function labelsFor(source: string): string[] {
	return FORBIDDEN_SOURCE_PATTERNS.filter(([pattern]) => pattern.test(source)).map(([, label]) => label);
}

describe("the forbidden source patterns", () => {
	test("whole-vault listings are caught however the vault is reached", () => {
		expect(labelsFor("const all = this.app.vault.getMarkdownFiles();")).toEqual(["vault-wide Markdown enumeration"]);
		expect(labelsFor("const all = this.app.vault.getFiles();")).toEqual(["vault-wide file enumeration"]);
		expect(labelsFor("const all = app.vault.getAllLoadedFiles();")).toEqual(["vault-wide file enumeration"]);
		expect(labelsFor("const all = vault\n\t.getFiles();")).toEqual(["vault-wide file enumeration"]);
		expect(labelsFor("const { vault } = app; vault . getAllLoadedFiles ()")).toEqual(["vault-wide file enumeration"]);
	});

	test("the batch folder walk and single-file lookups are not mistaken for a whole-vault listing", () => {
		expect(labelsFor("files = await this.getBatchWorkflowTargetFiles(options.folderPath, options.maxFiles);")).toEqual([]);
		expect(labelsFor("async getBatchWorkflowTargetFiles(folderPath: string, maxFiles: number): Promise<TFile[]> {")).toEqual([]);
		expect(labelsFor("const children = folder.children; getFilesIn(folder);")).toEqual([]);
		expect(labelsFor("const target = this.app.vault.getFileByPath(path);")).toEqual([]);
	});
});
