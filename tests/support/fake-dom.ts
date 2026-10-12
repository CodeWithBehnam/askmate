/**
 * A small DOM for tests that render Obsidian views, modals and settings.
 *
 * happy-dom supplies the DOM; this file adds the helper methods Obsidian puts on every element (`createDiv`,
 * `addClass`, `empty`, ...). Nothing here touches the global scope until a test calls `installDomGlobals()`, so tests
 * that do not need a DOM are unaffected.
 */
import { Window } from "happy-dom";

type ElementInfo = {
	cls?: string | string[];
	text?: string | DocumentFragment;
	attr?: Record<string, string | number | boolean | null>;
	title?: string;
	href?: string;
	type?: string;
	value?: string;
	placeholder?: string;
	parent?: Node;
	prepend?: boolean;
};

type ElementInit = string | ElementInfo;

let sharedWindow: Window | null = null;

function toInfo(init: ElementInit | undefined): ElementInfo {
	return typeof init === "string" ? { cls: init } : init ?? {};
}

function applyInfo(el: HTMLElement, info: ElementInfo): void {
	if (info.cls) {
		const classes = Array.isArray(info.cls) ? info.cls : info.cls.split(/\s+/);
		classes.filter(Boolean).forEach((name) => el.classList.add(name));
	}
	if (info.text !== undefined) {
		if (typeof info.text === "string") {
			el.textContent = info.text;
		} else {
			el.appendChild(info.text);
		}
	}
	for (const [name, value] of Object.entries(info.attr ?? {})) {
		if (value !== null) {
			el.setAttribute(name, String(value));
		}
	}
	if (info.title !== undefined) {
		el.setAttribute("title", info.title);
	}
	if (info.href !== undefined) {
		el.setAttribute("href", info.href);
	}
	if (info.type !== undefined) {
		el.setAttribute("type", info.type);
	}
	if (info.placeholder !== undefined) {
		el.setAttribute("placeholder", info.placeholder);
	}
	if (info.value !== undefined && "value" in el) {
		(el as HTMLInputElement).value = info.value;
	}
}

function installHelpers(win: Window): void {
	const nodeProto = win.Node.prototype as unknown as Record<string, unknown>;
	const elementProto = win.Element.prototype as unknown as Record<string, unknown>;
	const eventProto = win.Event.prototype as unknown as Record<string, unknown>;

	function createEl(this: HTMLElement, tag: string, init?: ElementInit, callback?: (el: HTMLElement) => void): HTMLElement {
		const info = toInfo(init);
		const el = this.ownerDocument.createElement(tag) as unknown as HTMLElement;
		applyInfo(el, info);
		const parent = (info.parent ?? this) as HTMLElement;
		if (info.prepend && parent.firstChild) {
			parent.insertBefore(el, parent.firstChild);
		} else {
			parent.appendChild(el);
		}
		callback?.(el);
		return el;
	}

	Object.assign(elementProto, {
		createEl,
		createDiv(this: HTMLElement, init?: ElementInit, callback?: (el: HTMLElement) => void) {
			return createEl.call(this, "div", init, callback);
		},
		createSpan(this: HTMLElement, init?: ElementInit, callback?: (el: HTMLElement) => void) {
			return createEl.call(this, "span", init, callback);
		},
		empty(this: HTMLElement) {
			while (this.firstChild) {
				this.removeChild(this.firstChild);
			}
		},
		addClass(this: HTMLElement, ...classes: string[]) {
			this.classList.add(...classes);
		},
		addClasses(this: HTMLElement, classes: string[]) {
			this.classList.add(...classes);
		},
		removeClass(this: HTMLElement, ...classes: string[]) {
			this.classList.remove(...classes);
		},
		removeClasses(this: HTMLElement, classes: string[]) {
			this.classList.remove(...classes);
		},
		toggleClass(this: HTMLElement, classes: string | string[], value: boolean) {
			for (const name of Array.isArray(classes) ? classes : [classes]) {
				this.classList.toggle(name, value);
			}
		},
		hasClass(this: HTMLElement, name: string) {
			return this.classList.contains(name);
		},
		setText(this: HTMLElement, text: string | DocumentFragment) {
			this.textContent = "";
			if (typeof text === "string") {
				this.textContent = text;
			} else {
				this.appendChild(text);
			}
		},
		getText(this: HTMLElement) {
			return this.textContent ?? "";
		},
		appendText(this: HTMLElement, text: string) {
			this.appendChild(this.ownerDocument.createTextNode(text));
		},
		setAttr(this: HTMLElement, name: string, value: string | number | boolean | null) {
			if (value === null) {
				this.removeAttribute(name);
			} else {
				this.setAttribute(name, String(value));
			}
		},
		setAttrs(this: HTMLElement, attrs: Record<string, string | number | boolean | null>) {
			for (const [name, value] of Object.entries(attrs)) {
				(this as unknown as { setAttr: (n: string, v: string | number | boolean | null) => void }).setAttr(name, value);
			}
		},
		getAttr(this: HTMLElement, name: string) {
			return this.getAttribute(name);
		},
		detach(this: HTMLElement) {
			this.remove();
		},
		find(this: HTMLElement, selector: string) {
			return this.querySelector(selector);
		},
		findAll(this: HTMLElement, selector: string) {
			return Array.from(this.querySelectorAll(selector));
		},
		isShown(this: HTMLElement) {
			return !this.hasAttribute("hidden") && this.style.display !== "none";
		},
		show(this: HTMLElement) {
			this.style.display = "";
		},
		hide(this: HTMLElement) {
			this.style.display = "none";
		},
		setCssProps(this: HTMLElement, props: Record<string, string>) {
			for (const [name, value] of Object.entries(props)) {
				this.style.setProperty(name, value);
			}
		},
		setCssStyles(this: HTMLElement, styles: Record<string, string>) {
			for (const [name, value] of Object.entries(styles)) {
				this.style.setProperty(name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`), value);
			}
		},
		onClickEvent(this: HTMLElement, listener: (event: MouseEvent) => void) {
			this.addEventListener("click", listener as EventListener);
		}
	});

	Object.assign(nodeProto, {
		instanceOf(this: Node, ctor: new (...args: never[]) => unknown) {
			return this instanceof ctor;
		}
	});

	Object.defineProperty(eventProto, "targetNode", {
		configurable: true,
		get(this: Event) {
			return this.target;
		}
	});
}

/** The shared fake window. Created on first use, with Obsidian's element helpers installed once. */
export function getFakeWindow(): Window {
	if (!sharedWindow) {
		sharedWindow = new Window({
			settings: {
				disableJavaScriptEvaluation: true,
				disableJavaScriptFileLoading: true,
				disableCSSFileLoading: true,
				handleDisabledFileLoadingAsSuccess: true
			}
		});
		installHelpers(sharedWindow);
	}
	return sharedWindow;
}

export function getFakeDocument(): Document {
	return getFakeWindow().document as unknown as Document;
}

/** A detached element from the fake document, with Obsidian's helpers available. */
export function createFakeEl(tag = "div"): HTMLElement {
	return getFakeDocument().createElement(tag);
}

/** A mouse event from the fake window; bun has no global `MouseEvent`. */
export function createFakeMouseEvent(type = "click", init: Record<string, unknown> = {}): MouseEvent {
	return new (getFakeWindow().MouseEvent)(type, { bubbles: true, cancelable: true, ...init }) as unknown as MouseEvent;
}

/** Dispatches a bubbling event of `type` on the element and returns it. */
export function fireDomEvent(target: Element, type: string, init: Record<string, unknown> = {}): Event {
	const event = new (getFakeWindow().Event)(type, { bubbles: true, cancelable: true, ...init }) as unknown as Event;
	Object.assign(event, init);
	target.dispatchEvent(event);
	return event;
}

// DOM classes that Obsidian's own code (and the code under test) names as globals, such as `target.instanceOf(Element)`.
const DOM_CLASS_NAMES = [
	"Node",
	"Element",
	"HTMLElement",
	"HTMLInputElement",
	"HTMLButtonElement",
	"HTMLSelectElement",
	"HTMLTextAreaElement",
	"DocumentFragment",
	"Event",
	"CustomEvent",
	"MouseEvent",
	"KeyboardEvent",
	"DOMParser",
	"MutationObserver",
	"ResizeObserver"
] as const;

/**
 * Makes `activeDocument`, `activeWindow` and the DOM classes resolve to the fake window, as they do in Obsidian. Returns
 * a function that removes them again; call it in `afterAll` so later test files see the plain global scope.
 */
export function installDomGlobals(): () => void {
	const win = getFakeWindow();
	const values: Array<[string, unknown]> = [
		["activeDocument", win.document],
		["activeWindow", win],
		...DOM_CLASS_NAMES.flatMap((name): Array<[string, unknown]> => {
			const value: unknown = Reflect.get(win, name);
			return value === undefined ? [] : [[name, value]];
		})
	];
	const previous = new Map<string, PropertyDescriptor | undefined>(values.map(([key]) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
	for (const [key, value] of values) {
		Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
	}
	return () => {
		for (const [key] of values) {
			const descriptor = previous.get(key);
			if (descriptor) {
				Object.defineProperty(globalThis, key, descriptor);
			} else {
				Reflect.deleteProperty(globalThis, key);
			}
		}
	};
}
