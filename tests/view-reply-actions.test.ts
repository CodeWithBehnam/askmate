import { describe, expect, test } from "bun:test";
import { mapProviderErrorToSetupCopy } from "../src/setup";
import { presentRunError } from "../src/ui/sidebar/components/errorFix";
import { NO_NOTE_APPLY_REASON, planReplyActions, type ReplyActionContext } from "../src/ui/sidebar/components/replyActions";

const context = (patch: Partial<ReplyActionContext> = {}): ReplyActionContext => ({
	hasRequest: true,
	source: "Current note",
	skillWasAutomatic: false,
	writeBlockedReason: null,
	...patch
});

const ids = (specs: ReadonlyArray<{ id: string }>): string[] => specs.map((spec) => spec.id);

describe("reply actions", () => {
	test("three stay in view and the rest are in one menu", () => {
		const plan = planReplyActions(context());
		expect(ids(plan.primary)).toEqual(["insert", "copy", "apply"]);
		expect(ids(plan.menuRead)).toEqual(["show-text", "use-reply"]);
		expect(ids(plan.menuWrite)).toEqual(["queue", "new-note", "replace-note", "apply-heading"]);
	});

	test("every label is sentence case and no two actions share an icon, so a destructive action never looks like a safe one", () => {
		const everything = [
			planReplyActions(context({ source: "Current note", skillWasAutomatic: true })),
			planReplyActions(context({ source: "Selected text", skillWasAutomatic: true }))
		].flatMap((plan) => [...plan.primary, ...plan.menuRead, ...plan.menuWrite]);
		const unique = new Map(everything.map((spec) => [spec.id, spec]));
		expect(unique.size).toBe(11);
		for (const spec of unique.values()) {
			expect(spec.label).toMatch(/^[A-Z][a-z]/);
			expect(spec.label).toBe(spec.label.charAt(0) + spec.label.slice(1).toLowerCase());
		}
		const icons = Array.from(unique.values(), (spec) => spec.icon);
		expect(new Set(icons).size).toBe(icons.length);
	});

	test("note-changing items need the sidebar idle; reading and copying do not", () => {
		const plan = planReplyActions(context());
		expect(plan.primary.map((spec) => [spec.id, spec.requiresIdle])).toEqual([["insert", false], ["copy", false], ["apply", true]]);
		expect(plan.menuRead.every((spec) => !spec.requiresIdle)).toBe(true);
		expect(plan.menuWrite.every((spec) => spec.requiresIdle)).toBe(true);
	});

	test("a restored reply has no request behind it, so only Insert, Copy, Show and Use remain", () => {
		const plan = planReplyActions(context({ hasRequest: false }));
		expect(ids(plan.primary)).toEqual(["insert", "copy"]);
		expect(ids(plan.menuRead)).toEqual(["show-text", "use-reply"]);
		expect(plan.menuWrite).toEqual([]);
	});

	test("selected text offers Apply to the selected text instead of Replace the whole note", () => {
		const plan = planReplyActions(context({ source: "Selected text" }));
		expect(ids(plan.menuWrite)).toEqual(["queue", "new-note", "apply-selection", "apply-heading"]);
	});

	test("Run again without skill appears only after an automatic skill", () => {
		expect(ids(planReplyActions(context()).menuRead)).not.toContain("rerun-without-skill");
		expect(ids(planReplyActions(context({ skillWasAutomatic: true })).menuRead)).toContain("rerun-without-skill");
	});

	test("with no note open, Apply actions are off and say why, while New note still works", () => {
		const plan = planReplyActions(context({ source: "No note" }));
		const apply = plan.primary.find((spec) => spec.id === "apply");
		expect(apply?.disabledReason).toBe(NO_NOTE_APPLY_REASON);
		expect(plan.menuWrite.find((spec) => spec.id === "queue")?.disabledReason).toBe(NO_NOTE_APPLY_REASON);
		expect(plan.menuWrite.find((spec) => spec.id === "new-note")?.disabledReason).toBeNull();
		expect(plan.primary.find((spec) => spec.id === "insert")?.disabledReason).toBeNull();
	});

	test("a reply that must not be written blocks every write, including Insert and New note", () => {
		const reason = "This diagram did not draw.";
		const plan = planReplyActions(context({ writeBlockedReason: reason }));
		for (const spec of [...plan.primary.filter((entry) => entry.id !== "copy"), ...plan.menuWrite]) {
			expect(spec.disabledReason).toBe(reason);
		}
		expect(plan.primary.find((spec) => spec.id === "copy")?.disabledReason).toBeNull();
	});
});

describe("presentRunError", () => {
	const context = { providerId: "openai" as const, baseUrl: "https://api.openai.com/v1", model: "gpt-5.5" };

	test("a rejected key becomes one sentence and an Update key button", () => {
		const error = Object.assign(new Error("Request failed with status 401"), { status: 401 });
		const presented = presentRunError(error, error.message, "provider", context);
		expect(presented.mapped).toBe(true);
		expect(presented.message).toContain("rejected the API key");
		expect(presented.fix?.label).toBe("Update key");
		expect(presented.detail).toContain("401");
	});

	test("a server that is not running names the host and offers the fix", () => {
		const local = { providerId: "openai-compatible" as const, baseUrl: "http://localhost:11434/v1", model: "llama" };
		const presented = presentRunError(new Error("net::ERR_CONNECTION_REFUSED"), "net::ERR_CONNECTION_REFUSED", "provider", local);
		expect(presented.message).toContain("localhost:11434");
		expect(presented.fix?.label).toBe("Restart server");
		expect(presented.message).not.toContain("ERR_CONNECTION_REFUSED");
	});

	test("a model that is not there offers to choose another", () => {
		const presented = presentRunError(new Error("The model does not exist"), "x", "provider", context);
		expect(presented.fix?.label).toBe("Choose another model");
	});

	test("a rate limit only needs a retry, which Retry already is", () => {
		const presented = presentRunError(new Error("rate limit exceeded"), "x", "provider", context);
		expect(presented.mapped).toBe(true);
		expect(presented.fix).toBeNull();
	});

	test("AskMate's own sentences are shown as they are", () => {
		const own = "@selection needs selected text. Select text in the note, then send again.";
		const presented = presentRunError(new Error(own), own, "provider", context);
		expect(presented).toEqual({ message: own, detail: null, fix: null, mapped: false });
	});

	test("errors from building the request are never translated", () => {
		const message = "Open a Markdown note or select text to add context.";
		const presented = presentRunError(new Error("ERR_CONNECTION_REFUSED"), message, "build", context);
		expect(presented).toEqual({ message, detail: null, fix: null, mapped: false });
	});

	test("agrees with the setup copy for the same failure", () => {
		const error = new Error("HTTP 429 too many requests");
		expect(presentRunError(error, "x", "provider", context).message).toBe(mapProviderErrorToSetupCopy(error, context).message);
	});
});
