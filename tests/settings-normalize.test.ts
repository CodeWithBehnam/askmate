import { describe, expect, test } from "bun:test";
import { DEFAULT_SETTINGS } from "../src/settings/defaults";
import { normalizeAskMateSettings } from "../src/settings/normalize";

describe("normalizeAskMateSettings", () => {
	test("load applies defaults and provider roles", () => {
		const settings = normalizeAskMateSettings({}, "load");
		expect(settings.selectedTextProvider).toBe(DEFAULT_SETTINGS.selectedTextProvider);
		expect(settings.providerRoles.chatProviderId).toBeTruthy();
		expect(settings.applyApprovalMode).toBe("manual");
		expect(settings.showApplyPreview).toBe(true);
		expect(settings.providers.openai.model).toBeTruthy();
	});

	test("save mirrors OpenAI provider fields and keeps approval sync", () => {
		const loaded = normalizeAskMateSettings({
			providers: {
				...DEFAULT_SETTINGS.providers,
				openai: {
					...DEFAULT_SETTINGS.providers.openai,
					model: "gpt-5.5",
					apiKeySecretName: "openai-key"
				}
			},
			applyApprovalMode: "auto-approve"
		}, "load");
		const saved = normalizeAskMateSettings(loaded, "save");
		expect(saved.model).toBe("gpt-5.5");
		expect(saved.openAiApiKeySecretName).toBe("openai-key");
		expect(saved.showApplyPreview).toBe(false);
		expect(saved.applyApprovalMode).toBe("auto-approve");
	});

	test("legacy showApplyPreview false migrates to auto-approve on load", () => {
		const settings = normalizeAskMateSettings({
			showApplyPreview: false
		} as Partial<typeof DEFAULT_SETTINGS>, "load");
		expect(settings.applyApprovalMode).toBe("auto-approve");
		expect(settings.showApplyPreview).toBe(false);
	});
});
