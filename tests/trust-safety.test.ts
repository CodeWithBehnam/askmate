import { describe, expect, test } from "bun:test";
import {
	assertNoteUnchangedDuringPreview,
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

	test("rejects at once when the signal is already aborted", async () => {
		const controller = new AbortController();
		controller.abort();
		await expect(awaitWithAbortAndTimeout(Promise.resolve("value"), { abortSignal: controller.signal }))
			.rejects.toMatchObject({ name: "AbortError" });
	});

	test("resolves with the request value and propagates the request's own error", async () => {
		await expect(awaitWithAbortAndTimeout(Promise.resolve("value"), { timeoutMs: 1000 })).resolves.toBe("value");
		await expect(awaitWithAbortAndTimeout(Promise.reject(new Error("HTTP 500")), { timeoutMs: 1000 }))
			.rejects.toThrow("HTTP 500");
	});

	test("wraps a rejection that is not an Error", async () => {
		const raced = awaitWithAbortAndTimeout(Promise.reject("socket closed"), { timeoutMs: 1000 });
		await expect(raced).rejects.toBeInstanceOf(Error);
		await expect(raced).rejects.toThrow("socket closed");
	});
});

describe("assertNoteUnchangedDuringPreview", () => {
	test("passes when the note is unchanged", () => {
		expect(() => assertNoteUnchangedDuringPreview("same", "same", "Note.md")).not.toThrow();
	});

	test("throws a specific error when the note changed, including a line-ending-only change", () => {
		expect(() => assertNoteUnchangedDuringPreview("a\nb", "a\nb edited", "Note.md")).toThrow('Note "Note.md" changed while the Apply preview was open');
		expect(() => assertNoteUnchangedDuringPreview("a\nb", "a\r\nb", "Note.md")).toThrow("changed while the Apply preview was open");
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

	const fullText = "Intro line.\nFirst: target here.\nSecond: target here.\n";
	const secondStart = fullText.lastIndexOf("target");

	test("captures prefix and suffix anchors from the full text", () => {
		const anchored = createSelectionIdentity("target", secondStart, secondStart + 6, "Note.md", fullText);
		expect(anchored?.prefix).toBe(fullText.slice(0, secondStart));
		expect(anchored?.suffix).toBe(" here.\n");
	});

	test("clips the prefix at the start of the document", () => {
		const anchored = createSelectionIdentity("Intro", 0, 5, "Note.md", fullText);
		expect(anchored?.prefix).toBe("");
		expect(anchored?.startOffset).toBe(0);
	});

	test("uses anchors to pick the right copy of repeated text after it moved", () => {
		const anchored = createSelectionIdentity("target", secondStart, secondStart + 6, "Note.md", fullText);
		if (!anchored) {
			throw new Error("expected an identity");
		}
		const moved = `New heading\n${fullText}`;
		expect(resolveSelectionIdentity(moved, anchored)).toEqual({
			status: "relocated",
			startOffset: secondStart + "New heading\n".length,
			endOffset: secondStart + "New heading\n".length + 6
		});
	});

	test("an edit near unique selected text still resolves it", () => {
		const text = "Some context here before the unique phrase and after.";
		const start = text.indexOf("unique phrase");
		const anchored = createSelectionIdentity("unique phrase", start, start + 13, "Note.md", text);
		if (!anchored) {
			throw new Error("expected an identity");
		}
		const edited = text.replace("here", "HERE");
		// Anchors no longer match, so this is a relocation to the same unique offsets rather than an exact hit.
		expect(resolveSelectionIdentity(edited, anchored)).toEqual({ status: "relocated", startOffset: start, endOffset: start + 13 });
		expect(resolveSelectionIdentity(`Prepended. ${edited}`, anchored).status).toBe("relocated");
	});

	test("a copy of the selected text elsewhere is not mistaken for the selection after the original was edited", () => {
		const note = "# Plan\n- [ ] Call Sam\nMore planning text here.\n\n# Later\n- [ ] Call Sam\nOther text.\n";
		const start = note.indexOf("- [ ] Call Sam");
		const anchored = createSelectionIdentity("- [ ] Call Sam", start, start + 14, "Note.md", note);
		if (!anchored) {
			throw new Error("expected an identity");
		}
		const ticked = note.replace("- [ ] Call Sam\nMore", "- [x] Call Sam\nMore");
		expect(resolveSelectionIdentity(ticked, anchored).status).toBe("missing");
	});

	test("repeated text whose anchors were both edited is ambiguous, not guessed", () => {
		const anchored = createSelectionIdentity("target", secondStart, secondStart + 6, "Note.md", fullText);
		if (!anchored) {
			throw new Error("expected an identity");
		}
		const edited = fullText.replace("Intro line.", "Changed intro.").replace("Second: target here.", "Second: target there.");
		expect(resolveSelectionIdentity(edited, anchored).status).toBe("ambiguous");
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
