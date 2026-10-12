import { describe, expect, test } from "bun:test";
import { classifyLinkDestination, normaliseLinkDestination } from "../src/safety/links";

describe("classifyLinkDestination", () => {
	test("vault-relative and in-page destinations are internal", () => {
		for (const href of [
			"Note", "Note.md", "folder/Note.md", "folder/My%20Note.md", "#Heading", "Note.md#Heading", "Note#^block",
			"", "  ", "../Other.md", "/Notes/a.md", "<Note with space.md>", "www.example.com", "example.com/path",
			"Folder/Sub: Note.md", "100%25 done.md", "Note.md#a:b"
		]) {
			expect({ href, kind: classifyLinkDestination(href) }).toEqual({ href, kind: "internal" });
		}
	});

	test("http and https destinations are http", () => {
		for (const href of [
			"http://example.com", "https://example.com/path?x=1&y=2#frag", "HTTPS://EXAMPLE.COM", "<https://example.com>",
			"  https://example.com  ", "https://user@example.com:8080/a"
		]) {
			expect({ href, kind: classifyLinkDestination(href) }).toEqual({ href, kind: "http" });
		}
	});

	test("other schemes are blocked", () => {
		for (const href of [
			"obsidian://open?vault=x", "OBSIDIAN://new?file=a&content=b&overwrite=true", "obsidian:open?vault=x",
			"file:///etc/passwd", "mailto:a@b.c", "tel:+441234", "sms:123", "javascript:alert(1)", "JaVaScRiPt:alert(1)",
			"data:text/html,x", "data:image/png;base64,AAA", "vscode://file/x", "vscode-insiders://file/x", "ftp://example.com",
			"ws://example.com", "wss://example.com", "ssh://host", "view-source:https://example.com", "blob:https://example.com/x",
			"about:blank", "intent://x", "slack://open", "x-apple.systempreferences:", "C:\\Windows\\system32", "localhost:3000",
			"www.example.com:8080/path"
		]) {
			expect({ href, kind: classifyLinkDestination(href) }).toEqual({ href, kind: "blocked" });
		}
	});

	test("protocol-relative, UNC and malformed http destinations are blocked", () => {
		for (const href of ["//evil.example/x", "\\\\server\\share", "\\evil", "http:/example.com", "http:example.com", "https:example.com", "https:///", "http://"]) {
			expect({ href, kind: classifyLinkDestination(href) }).toEqual({ href, kind: "blocked" });
		}
	});

	test("entity-obscured schemes are decoded before they are judged", () => {
		for (const href of [
			"javascript&#58;alert(1)", "javascript&#x3a;alert(1)", "javascript&#x3A;alert(1)", "javascript&colon;alert(1)",
			"&#106;avascript:alert(1)", "&#x6A;avascript:alert(1)", "java&Tab;script:alert(1)", "java&NewLine;script:alert(1)",
			"obsidian&#58;//open", "obsidian&colon;&sol;&sol;open", "file&#58;&#47;&#47;/etc/passwd", "mailto&#58;a@b.c",
			"jav&#x09;ascript:alert(1)", "jav&#9;ascript:alert(1)", "javascript&#58alert(1)", "vscode&#x3a;//x"
		]) {
			expect({ href, kind: classifyLinkDestination(href) }).toEqual({ href, kind: "blocked" });
		}
		expect(classifyLinkDestination("https&#58;//example.com")).toBe("http");
		expect(classifyLinkDestination("https&colon;&sol;&sol;example.com")).toBe("http");
		expect(classifyLinkDestination("&#104;ttps://example.com")).toBe("http");
	});

	test("control characters, spaces and invisible characters inside the scheme do not hide it", () => {
		for (const href of [
			"java\tscript:alert(1)", "java\nscript:alert(1)", "\u0001javascript:alert(1)", " javascript:alert(1)",
			"java\u200Bscript:alert(1)", "obsi\u00ADdian://open", "\u202Eobsidian://open", "java\u0000script:alert(1)",
			"obsi\ufeffdian://open"
		]) {
			expect({ href, kind: classifyLinkDestination(href) }).toEqual({ href, kind: "blocked" });
		}
	});

	test("backslash escapes and percent escapes are decoded before they are judged", () => {
		expect(classifyLinkDestination("obsidian\\://open")).toBe("blocked");
		expect(classifyLinkDestination("obsidian%3A//open")).toBe("blocked");
		expect(classifyLinkDestination("javascript%3Aalert(1)")).toBe("blocked");
		expect(classifyLinkDestination("%6Fbsidian://open")).toBe("blocked");
		// Percent escapes that create the scheme separator are not a real http link, so they fail closed.
		expect(classifyLinkDestination("https%3A//example.com")).toBe("blocked");
	});

	test("an unknown named entity in the scheme position fails closed", () => {
		expect(classifyLinkDestination("obsidian&unknownentity;//open")).toBe("blocked");
		expect(classifyLinkDestination("a&b:c")).toBe("blocked");
		expect(classifyLinkDestination("Q&A.md")).toBe("internal");
	});
});

describe("normaliseLinkDestination", () => {
	test("unwraps angle brackets and decodes references", () => {
		expect(normaliseLinkDestination("<a&#58;b>")).toBe("a:b");
		expect(normaliseLinkDestination(" java&Tab;script&colon; ")).toBe("javascript:");
		expect(normaliseLinkDestination("a\\:b")).toBe("a:b");
	});

	test("is linear on long entity-like input", () => {
		const started = performance.now();
		normaliseLinkDestination("&".repeat(50000) + "#".repeat(50000));
		classifyLinkDestination("&#".repeat(30000));
		expect(performance.now() - started).toBeLessThan(500);
	});
});
