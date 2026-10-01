import { describe, expect, test } from "bun:test";
import { DEFAULT_SETTINGS } from "../src/settings/defaults";
import { normalizeAskMateSettings } from "../src/settings/normalize";
import { syncObjectInPlace } from "../src/settings/syncInPlace";

describe("syncObjectInPlace", () => {
	test("keeps nested object identity and applies new values", () => {
		const target: Record<string, unknown> = { a: { b: 1, c: [1] }, removed: true };
		const nested = target.a;
		syncObjectInPlace<Record<string, unknown>>(target, { a: { b: 2, c: [1, 2] }, added: "x" });
		expect(target.a).toBe(nested);
		expect(target).toEqual({ a: { b: 2, c: [1, 2] }, added: "x" });
	});

	test("does not share arrays with the source", () => {
		const sourceArray = ["x"];
		const target: Record<string, unknown> = {};
		syncObjectInPlace<Record<string, unknown>>(target, { list: sourceArray });
		(target.list as string[]).push("y");
		expect(sourceArray).toEqual(["x"]);
	});

	test("a provider reference captured before a save stays live across repeated saves", () => {
		const settings = structuredClone(normalizeAskMateSettings({}, "load"));
		const captured = settings.providers["openai-compatible"];
		const save = (): void => {
			syncObjectInPlace(settings, normalizeAskMateSettings(settings, "save"));
		};

		captured.apiKeySecretName = "first-secret";
		save();
		captured.baseUrl = "http://localhost:1234/v1";
		save();
		captured.model = "second-model";
		save();

		expect(settings.providers["openai-compatible"]).toBe(captured);
		expect(settings.providers["openai-compatible"].apiKeySecretName).toBe("first-secret");
		expect(settings.providers["openai-compatible"].baseUrl).toBe("http://localhost:1234/v1");
		expect(settings.providers["openai-compatible"].model).toBe("second-model");
	});

	test("saving never mutates DEFAULT_SETTINGS", () => {
		const before = JSON.stringify(DEFAULT_SETTINGS);
		const settings = structuredClone(normalizeAskMateSettings({}, "load"));
		settings.providers.openai.modelOptions.push("custom-model");
		syncObjectInPlace(settings, normalizeAskMateSettings(settings, "save"));
		expect(JSON.stringify(DEFAULT_SETTINGS)).toBe(before);
	});
});
