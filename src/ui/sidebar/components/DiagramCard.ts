import type { DiagramCardCopy, DiagramCardStatus } from "./diagramModel";

/**
 * The card a diagram reply is shown in: the drawn diagram, what it is, and the five things a person does with it.
 * Drawing is injected, so the card never touches Mermaid; the view supplies a host that renders through Obsidian.
 */

export type DrawResult = "drawn" | "unavailable" | "failed";

export interface DiagramPreviewHost {
	/** Draws the diagram into `target`. Resolves "unavailable" when this Obsidian cannot draw Mermaid. */
	draw(target: HTMLElement, source: string): Promise<DrawResult>;
}

export interface DiagramCardActions {
	onInsert: () => void;
	onNewNote: () => void;
	onCopy: () => void;
	onFix: () => void;
	onAnotherLook: () => void;
}

export interface DiagramCardHandle {
	el: HTMLElement;
	/** Disables every action while one is running, so a second click cannot start another. */
	setBusy(busy: boolean): void;
	/** Resolves when the preview has been drawn or has fallen back to the source. */
	ready: Promise<DrawResult>;
}

export interface DiagramCardInput {
	status: DiagramCardStatus;
	copy: DiagramCardCopy;
	source: string;
	/** False when there is no note open to insert into. */
	hasNote: boolean;
}

const PREVIEW_UNAVAILABLE = "This version of Obsidian cannot draw a preview here. The diagram can still be copied or inserted.";
const PREVIEW_FAILED = "The preview could not be drawn here. The source is below, and the diagram can still be copied or inserted.";

const INSERT_TITLE = "Adds the diagram at the end of the note. Use Copy source to place it somewhere else.";

function addAction(parent: HTMLElement, label: string, onClick: () => void, options: { cta?: boolean; disabledReason?: string | null; title?: string } = {}): HTMLButtonElement {
	const button = parent.createEl("button", { text: label, cls: options.cta ? "mod-cta" : "" });
	button.type = "button";
	if (options.disabledReason) {
		button.disabled = true;
		button.setAttribute("title", options.disabledReason);
		button.dataset.askmateBlocked = "true";
	} else if (options.title) {
		button.setAttribute("title", options.title);
	}
	button.addEventListener("click", onClick);
	return button;
}

/** The diagram as text, closed until wanted. A picture has no text of its own for assistive technology, so this is how its content is read. */
function addSourceText(parent: HTMLElement, source: string): HTMLElement {
	// The collapsible block the image prompt uses: a muted summary over a wrapped, small preformatted text.
	const details = parent.createEl("details", { cls: "askmate-image-prompt-details" });
	details.createEl("summary", { text: "Diagram source" });
	details.createEl("pre", { text: source });
	return details;
}

function showSource(parent: HTMLElement, message: string, source: string, errors: readonly string[]): void {
	const block = parent.createDiv({ cls: "askmate-diagram-fallback" });
	block.createEl("p", { text: message });
	if (errors.length > 0) {
		const list = block.createEl("ul");
		for (const line of errors) {
			list.createEl("li", { text: line });
		}
	}
	const details = block.createEl("details");
	details.open = true;
	details.createEl("summary", { text: "Diagram source" });
	details.createEl("pre", { text: source });
}

export function renderDiagramCard(parent: HTMLElement, input: DiagramCardInput, actions: DiagramCardActions, preview: DiagramPreviewHost): DiagramCardHandle {
	const { copy, status } = input;
	const card = parent.createDiv({ cls: `askmate-diagram-card is-${status}` });
	card.setAttribute("role", "group");
	card.setAttribute("aria-label", `${copy.title}${copy.meta ? `, ${copy.meta}` : ""}`);

	const header = card.createDiv({ cls: "askmate-diagram-card-header" });
	header.createSpan({ cls: "askmate-diagram-title", text: copy.title });
	if (copy.meta) {
		header.createSpan({ cls: "askmate-diagram-meta", text: copy.meta });
	}

	// The preview, or the source when there is nothing to draw, sits in one slot above the actions.
	const slot = card.createDiv({ cls: "askmate-diagram-body" });
	let ready: Promise<DrawResult>;
	if (status === "fallback") {
		showSource(slot, copy.fallbackMessage ?? "", input.source, copy.errors);
		ready = Promise.resolve("failed");
	} else {
		const frame = slot.createDiv({ cls: "askmate-diagram-preview" });
		frame.setAttribute("role", "img");
		frame.setAttribute("aria-label", `${copy.title}. The diagram source is below as text.`);
		const placeholder = frame.createDiv({ cls: "askmate-diagram-placeholder", text: "Drawing the diagram..." });
		const text = addSourceText(slot, input.source);
		ready = preview.draw(frame, input.source).then((result) => {
			placeholder.remove();
			if (result !== "drawn") {
				// The fallback block below shows the source itself, so the closed copy would only repeat it.
				frame.remove();
				text.remove();
				showSource(slot, result === "unavailable" ? PREVIEW_UNAVAILABLE : PREVIEW_FAILED, input.source, []);
			}
			return result;
		});
	}

	const bar = card.createDiv({ cls: "askmate-diagram-actions" });
	const blocked = copy.blockedReason;
	const insertBlocked = status === "fallback" || !input.hasNote ? blocked : null;
	addAction(bar, "Insert at end", actions.onInsert, { cta: true, disabledReason: insertBlocked, title: INSERT_TITLE });
	addAction(bar, "New note", actions.onNewNote, { disabledReason: status === "fallback" ? blocked : null });
	addAction(bar, "Copy source", actions.onCopy);
	if (status === "fallback") {
		addAction(bar, "Fix", actions.onFix, { cta: true });
	}
	addAction(bar, "Another look", actions.onAnotherLook);

	if (blocked && (status === "fallback" || !input.hasNote)) {
		card.createEl("p", { cls: "askmate-diagram-hint", text: blocked });
	}

	return {
		el: card,
		ready,
		setBusy(busy) {
			bar.querySelectorAll<HTMLButtonElement>("button").forEach((button) => {
				button.disabled = busy || button.dataset.askmateBlocked === "true";
			});
		}
	};
}
