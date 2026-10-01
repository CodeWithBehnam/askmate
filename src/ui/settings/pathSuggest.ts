import { AbstractInputSuggest, TFile, TFolder, type App } from "obsidian";
import { getQueryFolderPath, isHiddenVaultPath, rankPathSuggestions } from "./pathRanking";

const MAX_SUGGESTIONS = 50;
const OPEN_FLAG = "askmateSuggestOpen";

class VaultPathSuggest extends AbstractInputSuggest<string> {
	// Parameter properties are assigned only after super() returns, so open() and close() tolerate an unset target.
	private readonly targetEl: HTMLInputElement | undefined;

	constructor(
		app: App,
		inputEl: HTMLInputElement,
		private readonly listPaths: (query: string) => string[],
		private readonly onPick: (path: string) => void,
	) {
		super(app, inputEl);
		this.targetEl = inputEl;
		this.limit = MAX_SUGGESTIONS;
	}

	protected getSuggestions(query: string): string[] {
		return rankPathSuggestions(this.listPaths(query), query, MAX_SUGGESTIONS);
	}

	renderSuggestion(path: string, el: HTMLElement): void {
		el.setText(path);
	}

	selectSuggestion(path: string): void {
		this.setValue(path);
		// Programmatic value changes fire no event, so the settings tab would never see the edit.
		this.targetEl?.dispatchEvent(new Event("input", { bubbles: true }));
		// A folder step keeps the list open: the input event above has already listed that folder's contents.
		if (path.endsWith("/")) {
			return;
		}
		// The input event above makes the suggester search again, so it is closed afterwards.
		this.close();
		this.onPick(path);
	}

	open(): void {
		super.open();
		if (this.targetEl) {
			this.targetEl.dataset[OPEN_FLAG] = "true";
		}
	}

	close(): void {
		super.close();
		if (this.targetEl) {
			delete this.targetEl.dataset[OPEN_FLAG];
		}
	}
}

export function attachFolderSuggest(app: App, inputEl: HTMLInputElement, onPick: (path: string) => void): void {
	const listFolders = (): string[] =>
		app.vault
			.getAllFolders(false)
			.map((folder) => folder.path)
			.filter((path) => !isHiddenVaultPath(path));
	new VaultPathSuggest(app, inputEl, listFolders, onPick);
}

/**
 * Lists only the folder being typed, like a file picker, because AskMate never enumerates every note in the vault.
 * Subfolders end with "/" so choosing one steps into it.
 */
export function attachMarkdownFileSuggest(app: App, inputEl: HTMLInputElement, onPick: (path: string) => void): void {
	const listNotes = (query: string): string[] => {
		const folderPath = getQueryFolderPath(query);
		const folder = folderPath ? app.vault.getFolderByPath(folderPath) : app.vault.getRoot();
		return (folder?.children ?? [])
			.flatMap((child) => child instanceof TFolder
				? [`${child.path}/`]
				: child instanceof TFile && child.extension === "md" ? [child.path] : [])
			.filter((path) => !isHiddenVaultPath(path));
	};
	new VaultPathSuggest(app, inputEl, listNotes, onPick);
}

/** The settings tab reads this to leave Enter to the suggester while it is choosing, instead of committing the field early. */
export function isPathSuggestOpen(inputEl: HTMLElement): boolean {
	return inputEl.dataset[OPEN_FLAG] === "true";
}
