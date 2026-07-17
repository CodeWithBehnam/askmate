import { describe, expect, test } from "bun:test";
import {
	awaitWithAbortAndTimeout,
	canRunContinue,
	cancelledMutation,
	createBuiltRetrySnapshot,
	createDraftRetrySnapshot,
	createSelectionIdentity,
	getRetryRequest,
	isRunIdentityCurrent,
	resolveSelectionIdentity,
	withRunPhase
} from "../src/shared/trustSafety";
import { normalizeOutputMode } from "../src/settings/normalize";
import type { ActiveRun, AskRequest, RunRequestOptions, SelectionIdentity } from "../src/shared/types";

function deferred<T>(): {
	promise: Promise<T>;
	resolve: (value: T) => void;
	reject: (error: unknown) => void;
} {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return { promise, resolve, reject };
}

function activeRun(id: number): ActiveRun {
	return {
		id,
		abortController: new AbortController(),
		intentKind: "freeform_text",
		phase: "building",
		startedAt: "2026-07-17T00:00:00.000Z"
	};
}

describe("awaitWithAbortAndTimeout", () => {
	test("rejects immediately when aborted and absorbs late settlement", async () => {
		const pending = deferred<string>();
		const controller = new AbortController();
		const raced = awaitWithAbortAndTimeout(pending.promise, { abortSignal: controller.signal });
		controller.abort();
		await expect(raced).rejects.toMatchObject({ name: "AbortError" });
		pending.reject(new Error("late provider failure"));
		await new Promise((resolve) => setTimeout(resolve, 0));
	});

	test("rejects on timeout and ignores a late success", async () => {
		const pending = deferred<string>();
		const raced = awaitWithAbortAndTimeout(pending.promise, {
			timeoutMs: 5,
			timeoutMessage: "Generation timed out."
		});
		await expect(raced).rejects.toThrow("Generation timed out.");
		pending.resolve("late success");
		await new Promise((resolve) => setTimeout(resolve, 0));
	});
});

describe("run phases and identity", () => {
	test("identity is distinct from ability to continue", () => {
		const run = activeRun(1);
		expect(isRunIdentityCurrent(run, run)).toBe(true);
		expect(canRunContinue(run, run, false)).toBe(true);
		run.abortController.abort();
		expect(isRunIdentityCurrent(run, run)).toBe(true);
		expect(canRunContinue(run, run, false)).toBe(false);
	});

	test("phase transitions preserve run identity", () => {
		const run = activeRun(7);
		const generating = withRunPhase(run, "generating");
		expect(generating.id).toBe(7);
		expect(generating.phase).toBe("generating");
	});
});

describe("retry snapshots", () => {
	test("draft snapshots preserve pre-build inputs", () => {
		const options: RunRequestOptions = { outputMode: "note", includeThreadHistory: true };
		const snapshot = createDraftRetrySnapshot("Question", "Title", options, "created");
		expect(snapshot).toEqual({ kind: "draft", question: "Question", title: "Title", options, createdAt: "created" });
		expect(getRetryRequest(snapshot)).toBeNull();
	});

	test("built snapshots reuse the exact AskRequest object", () => {
		const request = { question: "built" } as AskRequest;
		const snapshot = createBuiltRetrySnapshot(request, "created");
		expect(snapshot.request).toBe(request);
		expect(getRetryRequest(snapshot)).toBe(request);
	});
});

describe("selection identity resolution", () => {
	test("captures trimmed text with exact adjusted offsets", () => {
		expect(createSelectionIdentity("  target  ", 4, 14, "Note.md")).toEqual({
			text: "target",
			startOffset: 6,
			endOffset: 12,
			prefix: "",
			suffix: "",
			sourcePath: "Note.md"
		});
	});

	const identity: SelectionIdentity = {
		text: "target",
		startOffset: 6,
		endOffset: 12,
		prefix: "",
		suffix: "",
		sourcePath: "Note.md"
	};

	test("uses the captured offset when it still matches", () => {
		expect(resolveSelectionIdentity("hello target", identity)).toEqual({
			status: "exact",
			startOffset: 6,
			endOffset: 12
		});
	});

	test("relocates only when the exact text is unique", () => {
		expect(resolveSelectionIdentity("prefix hello target", identity)).toEqual({
			status: "relocated",
			startOffset: 13,
			endOffset: 19
		});
	});

	test("rejects missing and ambiguous text", () => {
		expect(resolveSelectionIdentity("no match", identity).status).toBe("missing");
		expect(resolveSelectionIdentity("target and target", identity).status).toBe("ambiguous");
	});
});

describe("mutation outcomes and output mode normalization", () => {
	test("cancellation is structured", () => {
		expect(cancelledMutation("No note changed.")).toEqual({ status: "cancelled", message: "No note changed." });
	});

	test("normalizes all unknown output modes to chat", () => {
		expect(normalizeOutputMode("note")).toBe("note");
		expect(normalizeOutputMode("apply")).toBe("apply");
		expect(normalizeOutputMode("CHAT")).toBe("chat");
		expect(normalizeOutputMode(undefined)).toBe("chat");
	});
});
