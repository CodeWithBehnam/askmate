import { describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { createScratchHost, mountSvg, scrubSvg, type ScratchParent } from "../src/diagrams/dom";

// Mermaid 11.13 emits <br> inside foreignObject, which is not well-formed XML, so the markup must go through the HTML parser.
// happy-dom's HTML parser drops everything after a <style> or <script> inside <svg>, which Chromium does not, so those two
// elements are built with DOM calls in these tests instead of being parsed.
const RENDERED = [
	'<svg id="askmate-mmd-1" viewBox="0 0 10 10" role="graphics-document document">',
	'<g class="node"><rect width="5" height="5"></rect>',
	'<foreignObject width="100" height="20"><div xmlns="http://www.w3.org/1999/xhtml"><span class="nodeLabel">Line one<br>Line two</span></div></foreignObject></g>',
	"</svg>"
].join("");

const SVG_NS = "http://www.w3.org/2000/svg";

function setup(): { readonly win: Window; readonly target: HTMLElement } {
	const win = new Window();
	const element = win.document.createElement("div");
	win.document.body.appendChild(element);
	return { win, target: element as unknown as HTMLElement };
}

describe("mountSvg", () => {
	test("mounts the SVG element from rendered markup, keeping the HTML inside foreignObject", () => {
		const { target } = setup();
		const node = mountSvg(target, RENDERED);
		expect(node).not.toBeNull();
		expect(target.children).toHaveLength(1);
		expect(target.firstElementChild?.tagName.toLowerCase()).toBe("svg");
		expect(target.firstElementChild?.getAttribute("viewBox")).toBe("0 0 10 10");
		expect(target.querySelector("rect")).not.toBeNull();
		expect(target.querySelector(".nodeLabel")?.textContent).toBe("Line oneLine two");
		expect(target.querySelector("br")).not.toBeNull();
	});

	test("replaces what was mounted before", () => {
		const { target } = setup();
		mountSvg(target, RENDERED);
		mountSvg(target, '<svg id="second"></svg>');
		expect(target.children).toHaveLength(1);
		expect(target.firstElementChild?.getAttribute("id")).toBe("second");
	});

	test("returns null and leaves the target alone when there is no SVG", () => {
		const { target } = setup();
		mountSvg(target, '<svg id="keep"></svg>');
		expect(mountSvg(target, "<p>not a diagram</p>")).toBeNull();
		expect(mountSvg(target, "")).toBeNull();
		expect(target.firstElementChild?.getAttribute("id")).toBe("keep");
	});

	test("strips handlers, script URLs and embedded documents even if Mermaid's sanitiser missed them", () => {
		const { target } = setup();
		mountSvg(
			target,
			[
				'<svg onload="alert(1)">',
				'<a href="javascript:alert(3)" xlink:href=" JavaScript:alert(4)"><text onclick="alert(5)">x</text></a>',
				'<iframe src="https://example.com"></iframe><object data="x"></object><embed src="x">',
				'<foreignObject><div onmouseover="alert(6)">y</div><form action="/x"><input name="a"><button>go</button></form></foreignObject>',
				'<image href="data:text/html,<b>x</b>"></image><g id="kept"></g></svg>'
			].join("")
		);
		const html = target.innerHTML;
		expect(html).not.toMatch(/<iframe|<object|<embed|<form|<input|<button/i);
		expect(html).not.toMatch(/onload|onclick|onmouseover/i);
		expect(html).not.toMatch(/javascript:/i);
		expect(html).not.toMatch(/data:text\/html/i);
		expect(target.querySelector("#kept")).not.toBeNull();
		expect(target.textContent).toContain("x");
		expect(target.textContent).toContain("y");
	});

	test("uses the target's own document, which matters for popout windows", () => {
		const first = setup();
		const second = setup();
		const node = mountSvg(second.target, '<svg id="popout"></svg>');
		expect(node?.ownerDocument).toBe(second.win.document as unknown as Document);
		expect(node?.ownerDocument).not.toBe(first.win.document as unknown as Document);
	});
});

describe("scrubSvg", () => {
	test("removes script elements and keeps the style element Mermaid needs", () => {
		const { win } = setup();
		const svg = win.document.createElementNS(SVG_NS, "svg") as unknown as Element;
		const style = win.document.createElementNS(SVG_NS, "style");
		style.textContent = "#id .node rect { fill: #e4f4fc; }";
		const script = win.document.createElementNS(SVG_NS, "script");
		script.textContent = "alert(1)";
		const group = win.document.createElementNS(SVG_NS, "g");
		group.setAttribute("onclick", "alert(2)");
		group.setAttribute("class", "node");
		svg.appendChild(style as unknown as Node);
		svg.appendChild(script as unknown as Node);
		svg.appendChild(group as unknown as Node);
		scrubSvg(svg);
		expect(svg.querySelector("script")).toBeNull();
		expect(svg.querySelector("style")?.textContent).toContain("fill: #e4f4fc");
		expect(svg.querySelector("g")?.hasAttribute("onclick")).toBe(false);
		expect(svg.querySelector("g")?.getAttribute("class")).toBe("node");
	});

	test("keeps ordinary attributes and styles", () => {
		const { win } = setup();
		const svg = new win.DOMParser().parseFromString('<svg viewBox="0 0 1 1" style="max-width: 5px" class="a"><path d="M0 0" onfocus="x()"></path></svg>', "text/html").body.querySelector("svg");
		expect(svg).not.toBeNull();
		if (svg === null) return;
		scrubSvg(svg as unknown as Element);
		expect(svg.getAttribute("viewBox")).toBe("0 0 1 1");
		expect(svg.getAttribute("style")).toBe("max-width: 5px");
		expect(svg.querySelector("path")?.hasAttribute("onfocus")).toBe(false);
		expect(svg.querySelector("path")?.getAttribute("d")).toBe("M0 0");
	});
});

describe("createScratchHost", () => {
	test("opens a classed container in the parent and removes it on close", () => {
		const { win } = setup();
		const created: HTMLElement[] = [];
		const parent: ScratchParent = {
			createDiv: (options) => {
				const element = win.document.createElement("div") as unknown as HTMLElement;
				element.className = options?.cls ?? "";
				win.document.body.appendChild(element as unknown as ReturnType<typeof win.document.createElement>);
				created.push(element);
				return element;
			}
		};
		const host = createScratchHost(parent);
		const handle = host.open();
		expect(created).toHaveLength(1);
		expect(handle.container).toBe(created[0] as unknown as Element);
		expect((handle.container as HTMLElement).className).toBe("askmate-mermaid-scratch");
		expect(win.document.body.contains(handle.container as unknown as ReturnType<typeof win.document.createElement>)).toBe(true);
		handle.close();
		expect(win.document.body.contains(handle.container as unknown as ReturnType<typeof win.document.createElement>)).toBe(false);
	});

	test("every open call gets its own container, and the class can be overridden", () => {
		const { win } = setup();
		const classes: string[] = [];
		const parent: ScratchParent = {
			createDiv: (options) => {
				classes.push(options?.cls ?? "");
				return win.document.createElement("div") as unknown as HTMLElement;
			}
		};
		const host = createScratchHost(parent, "custom-scratch");
		expect(host.open().container).not.toBe(host.open().container);
		expect(classes).toEqual(["custom-scratch", "custom-scratch"]);
	});
});
