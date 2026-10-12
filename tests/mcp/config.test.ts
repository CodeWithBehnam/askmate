import { describe, expect, test } from "bun:test";
import {
	DEFAULT_MCP_SETTINGS,
	MCP_SECRET_PREFIX,
	type McpServerConfig,
	findSecretRisks,
	isValidHeaderName,
	isValidSecretId,
	isValidServerId,
	listSecretUses,
	normalizeMcpSettings,
	secretIdFor,
	slugifyServerId,
	trustHash,
	trustMaterial,
	validateServerConfig
} from "../../src/mcp/config";
import { httpServer, plain, secret, stdioServer } from "./fake-host";

describe("server definitions", () => {
	test("sensible definitions are valid", () => {
		expect(validateServerConfig(stdioServer("local"))).toEqual([]);
		expect(validateServerConfig(httpServer("docs"))).toEqual([]);
		expect(validateServerConfig(httpServer("local-dev", { url: "http://localhost:8080/mcp", headers: { "X-Team": plain("a"), "X-Key": secret("askmate-mcp-local-dev-key") }, bearerSecretId: "askmate-mcp-local-dev-token" }))).toEqual([]);
	});

	test("ids, labels and secret ids are checked", () => {
		expect(validateServerConfig(stdioServer("Bad Id")).join(" ")).toContain("server id");
		expect(validateServerConfig(stdioServer("ok", { label: "  " })).join(" ")).toContain("server name");
		expect(validateServerConfig(stdioServer("ok", { label: "x".repeat(61) })).join(" ")).toContain("server name");
		expect(validateServerConfig(httpServer("ok", { bearerSecretId: "Not A Secret ID" })).join(" ")).toContain("bearer token reference");
		expect(isValidServerId("github")).toBe(true);
		expect(isValidServerId("1abc")).toBe(false);
		expect(isValidServerId("a".repeat(41))).toBe(false);
		expect(isValidSecretId("askmate-mcp-x-token")).toBe(true);
		expect(isValidSecretId("Has_Underscore")).toBe(false);
		expect(isValidSecretId("-leading")).toBe(false);
	});

	test("commands, arguments and environment names are checked", () => {
		expect(validateServerConfig(stdioServer("a", { command: "" })).join(" ")).toContain("command");
		expect(validateServerConfig(stdioServer("a", { command: "x\ny" })).join(" ")).toContain("command");
		expect(validateServerConfig(stdioServer("a", { args: ["a\0b"] })).join(" ")).toContain("arguments");
		expect(validateServerConfig(stdioServer("a", { args: Array.from({ length: 101 }, () => "x") })).join(" ")).toContain("arguments");
		expect(validateServerConfig(stdioServer("a", { args: ["x".repeat(5000)] })).join(" ")).toContain("arguments");
		expect(validateServerConfig(stdioServer("a", { env: { "BAD NAME": plain("1") } })).join(" ")).toContain("not an allowed environment variable name");
		expect(validateServerConfig(stdioServer("a", { env: { OK: plain("multi\nline value") } }))).toEqual([]);
		expect(validateServerConfig(stdioServer("a", { env: { OK: plain("nul\0") } })).join(" ")).toContain("not valid");
		expect(validateServerConfig(stdioServer("a", { env: { OK: secret("Bad Id") } })).join(" ")).toContain("not valid");
		const tooMany = Object.fromEntries(Array.from({ length: 51 }, (_, index) => [`V${index}`, plain("x")]));
		expect(validateServerConfig(stdioServer("a", { env: tooMany })).join(" ")).toContain("Too many");
	});

	test("URLs and headers are checked", () => {
		expect(validateServerConfig(httpServer("a", { url: "http://example.com/mcp" })).join(" ")).toContain("https");
		expect(validateServerConfig(httpServer("a", { url: "https://u:p@example.com/mcp" })).join(" ")).toContain("password");
		expect(validateServerConfig(httpServer("a", { url: "nonsense" })).join(" ")).toContain("not a valid URL");
		for (const reserved of ["Host", "Content-Length", "Content-Type", "Accept", "Cookie", "Mcp-Session-Id", "MCP-Protocol-Version", "Transfer-Encoding"]) {
			expect(isValidHeaderName(reserved)).toBe(false);
		}
		expect(isValidHeaderName("X-Api-Key")).toBe(true);
		expect(isValidHeaderName("Authorization")).toBe(true);
		expect(isValidHeaderName("bad header")).toBe(false);
		expect(validateServerConfig(httpServer("a", { headers: { "Content-Length": plain("1") } })).join(" ")).toContain("not an allowed header name");
		expect(validateServerConfig(httpServer("a", { headers: { "X-A": plain("line\r\nbreak") } })).join(" ")).toContain("not valid");
	});

	test("defaults keep MCP off with no servers", () => {
		expect(DEFAULT_MCP_SETTINGS).toMatchObject({ enabled: false, servers: [], maxOutputChars: 20_000 });
	});
});

describe("trust hash", () => {
	const base = stdioServer("local", { command: "npx", args: ["-y", "pkg"], env: { A: plain("1"), B: secret("askmate-mcp-local-b") } });

	test("it ignores key order and labels, and is a SHA-256", () => {
		const reordered = stdioServer("local", { label: "Renamed", command: "npx", args: ["-y", "pkg"], env: { B: secret("askmate-mcp-local-b"), A: plain("1") } });
		expect(trustHash(reordered)).toBe(trustHash(base));
		expect(trustHash(base)).toMatch(/^[0-9a-f]{64}$/);
	});

	test("everything that decides what runs changes it", () => {
		const hash = trustHash(base);
		const variants: McpServerConfig[] = [
			stdioServer("local", { ...base, command: "bunx" }),
			stdioServer("local", { ...base, args: ["-y", "pkg", "--flag"] }),
			stdioServer("local", { ...base, env: { ...base.env, A: plain("2") } }),
			stdioServer("local", { ...base, env: { ...base.env, C: plain("3") } }),
			stdioServer("local", { ...base, env: { A: plain("1"), B: secret("askmate-mcp-local-other") } }),
			stdioServer("local", { ...base, env: { A: plain("1"), B: plain("askmate-mcp-local-b") } })
		];
		expect(variants.map((variant) => trustHash(variant)).filter((candidate) => candidate === hash)).toEqual([]);
		expect(new Set(variants.map((variant) => trustHash(variant))).size).toBe(variants.length);
	});

	test("the remote definition is covered by URL, header names and values, and the token reference", () => {
		const remote = httpServer("docs", { headers: { "X-A": plain("1") }, bearerSecretId: "askmate-mcp-docs-token" });
		const hash = trustHash(remote);
		expect(trustHash(httpServer("docs", { ...remote, url: "https://other.example.com/mcp" }))).not.toBe(hash);
		expect(trustHash(httpServer("docs", { ...remote, headers: { "X-B": plain("1") } }))).not.toBe(hash);
		expect(trustHash(httpServer("docs", { ...remote, headers: { "X-A": plain("2") } }))).not.toBe(hash);
		expect(trustHash(httpServer("docs", { ...remote, bearerSecretId: null }))).not.toBe(hash);
		expect(trustHash(httpServer("docs", { ...remote, approval: "trusted-read-only", trustsAnnotations: true, label: "x", enabled: false }))).toBe(hash);
	});

	test("a local and a remote server never share a hash, and the material never holds a secret value", () => {
		expect(trustMaterial(base)).not.toContain("s3cret");
		expect(trustHash(stdioServer("a"))).not.toBe(trustHash(httpServer("a")));
	});
});

describe("reading the mcp group of data.json", () => {
	test("anything that is not an object gives the defaults: off, no servers", () => {
		for (const raw of [undefined, null, 5, "text", [], true]) {
			expect(normalizeMcpSettings(raw)).toEqual(DEFAULT_MCP_SETTINGS);
		}
		expect(normalizeMcpSettings({}).enabled).toBe(false);
		expect(normalizeMcpSettings({ enabled: "yes" }).enabled).toBe(false);
		expect(normalizeMcpSettings({ enabled: true }).enabled).toBe(true);
	});

	test("valid definitions survive unchanged and normalising twice changes nothing", () => {
		const stored = {
			enabled: true,
			maxToolRoundsPerTurn: 5,
			maxOutputChars: 20_000,
			servers: [
				stdioServer("local", { env: { MODE: plain("fast"), KEY: secret("askmate-mcp-local-key") }, disabledTools: ["danger"], callTimeoutMs: 30_000 }),
				httpServer("docs", { approval: "trusted-read-only", trustsAnnotations: true, headers: { "X-Team": plain("a") }, bearerSecretId: "askmate-mcp-docs-token" })
			]
		};
		const once = normalizeMcpSettings(JSON.parse(JSON.stringify(stored)));
		expect(once).toEqual(stored);
		expect(normalizeMcpSettings(once)).toEqual(once);
	});

	test("unknown fields and pasted tokens are dropped, never kept", () => {
		const result = normalizeMcpSettings({
			servers: [
				{ ...stdioServer("a"), token: "ghp_pasted", env: { KEY: { kind: "secret", secretId: "askmate-mcp-a-key", value: "ghp_inline" }, TOKEN: { kind: "secret", value: "ghp_noid" } } },
				{ ...httpServer("b"), apiKey: "sk-pasted", bearerToken: "abc", headers: { "X-Key": "sk-bare-string" } }
			]
		});
		const text = JSON.stringify(result);
		for (const leaked of ["ghp_pasted", "ghp_inline", "ghp_noid", "sk-pasted", "bearerToken"]) {
			expect(text).not.toContain(leaked);
		}
		expect(result.servers[0]).toMatchObject({ env: { KEY: { kind: "secret", secretId: "askmate-mcp-a-key" } } });
		expect((result.servers[0] as { env: Record<string, unknown> }).env.TOKEN).toBeUndefined();
	});

	test("missing fields fall back to the safe choice", () => {
		const [local] = normalizeMcpSettings({ servers: [{ transport: "stdio", command: "node" }] }).servers;
		expect(local).toMatchObject({ enabled: false, approval: "always-ask", trustsAnnotations: false, args: [], env: {}, label: "server", id: "server" });
		const [bad] = normalizeMcpSettings({ servers: [{ ...httpServer("x"), approval: "never-ask", enabled: "true", trustsAnnotations: "yes" }] }).servers;
		expect(bad).toMatchObject({ approval: "always-ask", enabled: false, trustsAnnotations: false });
	});

	test("malformed entries are dropped, duplicate and missing ids are replaced, the list is capped", () => {
		const result = normalizeMcpSettings({
			servers: [
				null,
				"text",
				{ transport: "ssh", command: "x" },
				{ transport: "stdio" },
				{ transport: "http" },
				stdioServer("same", { label: "First" }),
				stdioServer("same", { label: "Second" }),
				{ ...stdioServer("x"), id: "Not Valid", label: "Third" }
			]
		});
		expect(result.servers.map((server) => [server.id, server.label])).toEqual([["same", "First"], ["second", "Second"], ["third", "Third"]]);
		const many = normalizeMcpSettings({ servers: Array.from({ length: 80 }, (_, index) => stdioServer(`s${index}`)) });
		expect(many.servers).toHaveLength(50);
	});

	test("numbers are clamped and lists are cleaned", () => {
		const result = normalizeMcpSettings({
			maxToolRoundsPerTurn: 99,
			maxOutputChars: 5,
			servers: [{ ...stdioServer("a"), args: ["ok", 5, null, "also"], callTimeoutMs: 5, disabledTools: ["a", "a", 3, "b"] }]
		});
		expect(result.maxToolRoundsPerTurn).toBe(12);
		expect(result.maxOutputChars).toBe(1_000);
		expect(normalizeMcpSettings({ maxToolRoundsPerTurn: "many", maxOutputChars: NaN })).toMatchObject({ maxToolRoundsPerTurn: 5, maxOutputChars: 20_000 });
		expect(result.servers[0]).toMatchObject({ args: ["ok", "also"], callTimeoutMs: 1_000, disabledTools: ["a", "b"] });
	});

	test("an unusable but well-formed definition is kept so the settings page can explain it", () => {
		const [server] = normalizeMcpSettings({ servers: [httpServer("a", { url: "http://example.com/mcp" })] }).servers;
		expect(server?.id).toBe("a");
		expect(validateServerConfig(server as McpServerConfig).join(" ")).toContain("https");
	});

	test("an unknown approval mode is a problem, so the server cannot run", () => {
		const odd = { ...httpServer("a"), approval: "whenever" } as unknown as McpServerConfig;
		expect(validateServerConfig(odd).join(" ")).toContain("approval mode");
	});
});

describe("ids", () => {
	test("secret ids follow the askmate-mcp-<server>-<name> pattern and stay valid", () => {
		expect(secretIdFor("github", "GITHUB_PERSONAL_ACCESS_TOKEN")).toBe("askmate-mcp-github-github-personal-access-token");
		expect(secretIdFor("x", "***")).toBe("askmate-mcp-x-secret");
		expect(isValidSecretId(secretIdFor("github", "Weird Name!!"))).toBe(true);
	});

	test("server ids are slugs that start with a letter and avoid taken ones", () => {
		expect(slugifyServerId("GitHub Issues", new Set())).toBe("github-issues");
		expect(slugifyServerId("1Password", new Set())).toBe("server-1password");
		expect(slugifyServerId("***", new Set())).toBe("server");
		expect(slugifyServerId("GitHub", new Set(["github"]))).toBe("github-2");
		expect(slugifyServerId("GitHub", new Set(["github", "github-2", "github-3"]))).toBe("github-4");
		expect(isValidServerId(slugifyServerId("x".repeat(100), new Set()))).toBe(true);
	});
});

describe("stored secrets a definition points at", () => {
	test("generated ids sit under the AskMate MCP prefix and the server's own name", () => {
		expect(MCP_SECRET_PREFIX).toBe("askmate-mcp-");
		expect(secretIdFor("github", "Personal Token")).toBe("askmate-mcp-github-personal-token");
	});

	test("every place a definition reads a stored secret is listed, plain values are not", () => {
		expect(listSecretUses(httpServer("docs", { bearerSecretId: "askmate-mcp-docs-token", headers: { "X-Key": secret("askmate-mcp-docs-key"), "X-Team": plain("a") } }))).toEqual([
			{ where: "The bearer token", secretId: "askmate-mcp-docs-token" },
			{ where: 'The header "X-Key"', secretId: "askmate-mcp-docs-key" }
		]);
		expect(listSecretUses(stdioServer("local", { env: { TOKEN: secret("askmate-mcp-local-token"), MODE: plain("x") } }))).toEqual([{ where: 'The variable "TOKEN"', secretId: "askmate-mcp-local-token" }]);
		expect(listSecretUses(httpServer("docs"))).toEqual([]);
	});

	test("ids made for this server raise no warning", () => {
		expect(findSecretRisks(httpServer("docs", { bearerSecretId: secretIdFor("docs", "token"), headers: { "X-Key": secret(secretIdFor("docs", "key")) } }), "docs.example.com")).toEqual([]);
		expect(findSecretRisks(stdioServer("local", { env: { TOKEN: secret(secretIdFor("local", "token")) } }), 'the program "npx"')).toEqual([]);
		expect(findSecretRisks(httpServer("docs"), "docs.example.com")).toEqual([]);
	});

	test("an id outside the namespace, such as a provider key, is flagged with where it would go", () => {
		const risks = findSecretRisks(httpServer("docs", { url: "https://evil.example.com/mcp", bearerSecretId: "openai-api-key" }), "evil.example.com");
		expect(risks).toHaveLength(1);
		expect(risks[0]).toContain("The bearer token");
		expect(risks[0]).toContain('"openai-api-key"');
		expect(risks[0]).toContain("did not create for MCP");
		expect(risks[0]).toContain("evil.example.com");
	});

	test("an AskMate MCP id that was stored for another server is flagged, and a lookalike prefix is not accepted", () => {
		expect(findSecretRisks(httpServer("docs", { bearerSecretId: "askmate-mcp-github-token" }), "docs.example.com")[0]).toContain("different MCP server");
		expect(findSecretRisks(httpServer("docs", { bearerSecretId: "askmate-mcpx-docs-token" }), "docs.example.com")[0]).toContain("did not create for MCP");
		// "doc" must not be allowed to borrow the secrets of "docs".
		expect(findSecretRisks(httpServer("doc", { bearerSecretId: "askmate-mcp-docs-token" }), "doc.example.com")).toHaveLength(1);
	});
});
