import { afterAll, describe, expect, test } from "bun:test";
import { applyDialogSemantics } from "../src/ui/modals/dialog";
import { fireDomEvent, getFakeDocument, installDomGlobals } from "./support/fake-dom";

const restoreGlobals = installDomGlobals();
afterAll(restoreGlobals);

function dialog(): { opener: HTMLButtonElement; modalEl: HTMLElement; first: HTMLButtonElement; last: HTMLButtonElement; closed: string[]; parts: { modalEl: HTMLElement; titleEl: HTMLElement; onClose?: () => void } } {
	const doc = getFakeDocument();
	const opener = doc.createElement("button");
	doc.body.appendChild(opener);
	opener.focus();
	const modalEl = doc.createElement("div");
	const titleEl = doc.createElement("div");
	const first = doc.createElement("button");
	const last = doc.createElement("button");
	modalEl.append(titleEl, first, last);
	doc.body.appendChild(modalEl);
	const closed: string[] = [];
	const parts = { modalEl, titleEl, onClose: () => { closed.push("closed"); } };
	applyDialogSemantics(parts);
	return { opener, modalEl, first, last, closed, parts };
}

describe("AskMate dialogs and the keyboard (D-11, P6-13)", () => {
	test("Tab from the last control goes back to the first, and Shift+Tab from the first goes to the last", () => {
		const { modalEl, first, last } = dialog();
		last.focus();
		fireDomEvent(modalEl, "keydown", { key: "Tab" });
		expect(getFakeDocument().activeElement).toBe(first);
		fireDomEvent(modalEl, "keydown", { key: "Tab", shiftKey: true });
		expect(getFakeDocument().activeElement).toBe(last);
	});

	test("closing gives the keyboard back to the control that opened the dialog, after the dialog's own close runs", () => {
		const { opener, first, closed, parts } = dialog();
		first.focus();
		parts.onClose?.();
		expect(closed).toEqual(["closed"]);
		expect(getFakeDocument().activeElement).toBe(opener);
	});
});
