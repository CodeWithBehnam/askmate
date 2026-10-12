// The only DOM-touching code in the diagram core. It takes elements as arguments and never reads a global document.

import type { ScratchHost } from "./types";

const FORBIDDEN_ELEMENTS = "script, iframe, object, embed, link, meta, base, form, input, button, textarea, select";
const SCRIPT_URL = /^\s*(?:javascript|vbscript|data\s*:\s*text\/html)/i;

/** Defence in depth: Mermaid's strict security level already sanitises labels, so this should never find anything. */
export function scrubSvg(root: Element): void {
	root.querySelectorAll(FORBIDDEN_ELEMENTS).forEach((element) => element.remove());
	[root, ...Array.from(root.querySelectorAll("*"))].forEach((element) => {
		element.getAttributeNames().forEach((name) => {
			const lower = name.toLowerCase();
			const isHandler = lower.startsWith("on");
			const isScriptUrl = (lower === "href" || lower === "xlink:href" || lower === "src") && SCRIPT_URL.test(element.getAttribute(name) ?? "");
			if (isHandler || isScriptUrl) element.removeAttribute(name);
		});
	});
}

/**
 * Mounts rendered SVG without innerHTML (community review rule). The text is parsed as HTML, not as "image/svg+xml":
 * Mermaid 11.13 emits `<br>` inside foreignObject, which is not well-formed XML.
 */
export function mountSvg(target: Element, svg: string): SVGElement | null {
	const view = target.ownerDocument.defaultView;
	const parser = new (view?.DOMParser ?? DOMParser)();
	const parsed = parser.parseFromString(svg, "text/html").body.querySelector("svg");
	if (!parsed) return null;
	scrubSvg(parsed);
	const node = target.ownerDocument.importNode(parsed, true);
	target.replaceChildren(node);
	return node;
}

/** Anything with Obsidian's createDiv helper, such as `activeDocument.body`. Declared structurally so this module needs no Obsidian import. */
export interface ScratchParent {
	createDiv(options?: { cls?: string }): HTMLElement;
}

/**
 * Hidden container for Mermaid to render into. Passing a container keeps Mermaid's error element out of document.body,
 * so removing the container cleans up after a failed render. Needs the `askmate-mermaid-scratch` class in styles.css:
 * absolutely positioned, off screen, visibility hidden, a fixed width. It must not be display:none, because Mermaid measures text.
 */
export function createScratchHost(parent: ScratchParent, className = "askmate-mermaid-scratch"): ScratchHost {
	return {
		open: () => {
			const container = parent.createDiv({ cls: className });
			return { container, close: () => container.remove() };
		}
	};
}
