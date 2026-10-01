import { describe, expect, test } from "bun:test";
import { formatIntegerRange, resolveBaseUrlInput, resolveFolderPathInput, resolveIntegerInput } from "../src/ui/settings/settingsInputs";

const bounds = { min: 1, max: 200 };

describe("resolveIntegerInput", () => {
	test("ignores an empty field instead of saving 0 or the minimum", () => {
		expect(resolveIntegerInput("", bounds)).toEqual({ kind: "ignored" });
		expect(resolveIntegerInput("   ", bounds)).toEqual({ kind: "ignored" });
	});

	test("ignores non-numeric input", () => {
		expect(resolveIntegerInput("abc", bounds)).toEqual({ kind: "ignored" });
		expect(resolveIntegerInput("Infinity", bounds)).toEqual({ kind: "ignored" });
	});

	test("accepts an in-range value unchanged", () => {
		expect(resolveIntegerInput("30", bounds)).toEqual({ kind: "accepted", value: 30, clamped: false });
	});

	test("rounds fractional input without reporting a clamp", () => {
		expect(resolveIntegerInput("12.6", bounds)).toEqual({ kind: "accepted", value: 13, clamped: false });
	});

	test("clamps out-of-range input and reports it so the field can show the saved value", () => {
		expect(resolveIntegerInput("0", bounds)).toEqual({ kind: "accepted", value: 1, clamped: true });
		expect(resolveIntegerInput("500", bounds)).toEqual({ kind: "accepted", value: 200, clamped: true });
	});

	test("keeps 0 for bounds that allow it, because 0 disables a usage limit", () => {
		expect(resolveIntegerInput("0", { min: 0, max: 10000000 })).toEqual({ kind: "accepted", value: 0, clamped: false });
	});
});

describe("formatIntegerRange", () => {
	test("formats bounds with UK thousands separators", () => {
		expect(formatIntegerRange({ min: 1000, max: 200000 })).toBe("1,000 to 200,000");
		expect(formatIntegerRange({ min: 1, max: 12 })).toBe("1 to 12");
	});
});

describe("resolveFolderPathInput", () => {
	test("accepts and trims an ordinary folder path", () => {
		expect(resolveFolderPathInput("  Projects/AskMate  ")).toEqual({ kind: "accepted", value: "Projects/AskMate" });
	});

	test("accepts an empty path, which the folder settings treat as unset", () => {
		expect(resolveFolderPathInput("")).toEqual({ kind: "accepted", value: "" });
	});

	test("refuses . and .. segments with either separator", () => {
		expect(resolveFolderPathInput("../Private")).toEqual({ kind: "unsafe" });
		expect(resolveFolderPathInput("Notes/./Drafts")).toEqual({ kind: "unsafe" });
		expect(resolveFolderPathInput("Notes\\..\\Other")).toEqual({ kind: "unsafe" });
		expect(resolveFolderPathInput(".")).toEqual({ kind: "unsafe" });
	});

	test("allows names that merely contain dots", () => {
		expect(resolveFolderPathInput("v1.2/notes..old")).toEqual({ kind: "accepted", value: "v1.2/notes..old" });
	});
});

describe("resolveBaseUrlInput", () => {
	const validate = (value: string, fallback: string): string => {
		const trimmed = value.trim() || fallback;
		if (!trimmed.startsWith("https://") && !trimmed.startsWith("http://localhost")) {
			throw new Error("Base URL must use https:// for remote hosts.");
		}
		return trimmed.replace(/\/+$/g, "");
	};

	test("treats a cleared field as an explicit request for the default", () => {
		expect(resolveBaseUrlInput("", "http://localhost:11434/v1", validate)).toEqual({ kind: "restore-default", value: "http://localhost:11434/v1" });
		expect(resolveBaseUrlInput("  ", "", validate)).toEqual({ kind: "restore-default", value: "" });
	});

	test("returns the validated, normalised value", () => {
		expect(resolveBaseUrlInput("https://example.com/v1/", "", validate)).toEqual({ kind: "accepted", value: "https://example.com/v1" });
	});

	test("reports validation errors instead of throwing", () => {
		expect(resolveBaseUrlInput("http://example.com/v1", "", validate)).toEqual({ kind: "invalid", message: "Base URL must use https:// for remote hosts." });
	});

	test("reports non-Error throws as text", () => {
		const throwsString = (): string => {
			throw "bad url";
		};
		expect(resolveBaseUrlInput("x", "", throwsString)).toEqual({ kind: "invalid", message: "bad url" });
	});
});
