import { describe, expect, test } from "bun:test";
import { validateServerConfig } from "../../src/mcp/config";
import { parseMcpImport, stripJsonComments } from "../../src/mcp/importConfig";

const claudeDesktop = JSON.stringify({
	mcpServers: {
		"GitHub": {
			command: "npx",
			args: ["-y", "@modelcontextprotocol/server-github"],
			env: { GITHUB_PERSONAL_ACCESS_TOKEN: "ghp_realtokenvalue1234567890", LOG_LEVEL: "debug" }
		},
		"Filesystem": { command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem", "/Users/me/notes"] }
	}
});

describe("importing the mcpServers shape (Claude Desktop, Cursor, Claude Code)", () => {
	test("local servers keep their command and arguments, and secret-looking variables become references", () => {
		const result = parseMcpImport(claudeDesktop);
		expect(result.error).toBeNull();
		expect(result.skipped).toEqual([]);
		const [github, files] = result.servers;
		expect(github?.config).toMatchObject({
			id: "github",
			label: "GitHub",
			transport: "stdio",
			command: "npx",
			args: ["-y", "@modelcontextprotocol/server-github"],
			enabled: true,
			approval: "always-ask",
			trustsAnnotations: false,
			env: {
				GITHUB_PERSONAL_ACCESS_TOKEN: { kind: "secret", secretId: "askmate-mcp-github-github-personal-access-token" },
				LOG_LEVEL: { kind: "plain", value: "debug" }
			}
		});
		expect(github?.secrets).toEqual([{ secretId: "askmate-mcp-github-github-personal-access-token", value: "ghp_realtokenvalue1234567890", source: "env GITHUB_PERSONAL_ACCESS_TOKEN" }]);
		expect(files?.config.id).toBe("filesystem");
		expect(files?.secrets).toEqual([]);
	});

	test("the imported configuration never contains a secret value and always validates", () => {
		const result = parseMcpImport(claudeDesktop);
		result.servers.forEach((server) => {
			expect(JSON.stringify(server.config)).not.toContain("ghp_realtokenvalue1234567890");
			expect(validateServerConfig(server.config)).toEqual([]);
		});
	});

	test("nothing is trusted or approved by import: the person still sees the trust dialog", () => {
		const result = parseMcpImport(claudeDesktop);
		expect(result.servers.every((server) => server.config.approval === "always-ask" && !server.config.trustsAnnotations)).toBe(true);
	});
});

describe("importing the servers shape (VS Code)", () => {
	test("typed entries, comments, trailing commas and bearer headers", () => {
		const text = `{
			// VS Code allows comments here
			"inputs": [{ "id": "token", "type": "promptString" }],
			"servers": {
				"docs": {
					"type": "http",
					"url": "https://mcp.example.com/mcp", /* the remote one */
					"headers": { "Authorization": "Bearer abc123def456ghi789", "X-Team": "blue", },
				},
				"local": { "type": "stdio", "command": "uvx", "args": ["mcp-server-time"], },
			},
		}`;
		const result = parseMcpImport(text);
		expect(result.error).toBeNull();
		const [docs, local] = result.servers;
		expect(docs?.config).toMatchObject({
			transport: "http",
			url: "https://mcp.example.com/mcp",
			bearerSecretId: "askmate-mcp-docs-token",
			headers: { "X-Team": { kind: "plain", value: "blue" } }
		});
		expect(docs?.secrets).toEqual([{ secretId: "askmate-mcp-docs-token", value: "abc123def456ghi789", source: "header Authorization" }]);
		expect(local?.config).toMatchObject({ transport: "stdio", command: "uvx", args: ["mcp-server-time"] });
	});

	test("a URL entry without a type is remote, the mcp.servers settings shape and arrays work", () => {
		expect(parseMcpImport('{"servers":{"a":{"url":"https://a.example.com/mcp"}}}').servers[0]?.config.transport).toBe("http");
		expect(parseMcpImport('{"mcp":{"servers":{"a":{"command":"node","args":["x.js"]}}}}').servers[0]?.config.id).toBe("a");
		const listed = parseMcpImport('{"servers":[{"name":"First","command":"node"},{"name":"Second","url":"https://s.example.com/mcp"}]}');
		expect(listed.servers.map((server) => server.config.id)).toEqual(["first", "second"]);
	});

	test("a single server object and a bare map are accepted", () => {
		expect(parseMcpImport('{"command":"node","args":["server.js"]}').servers[0]?.config).toMatchObject({ id: "imported-server", command: "node" });
		const bare = parseMcpImport('{"one":{"command":"a"},"two":{"url":"https://two.example.com/mcp"}}');
		expect(bare.servers.map((server) => server.config.id)).toEqual(["one", "two"]);
	});
});

describe("what is skipped, warned about or refused", () => {
	test("retired and unsupported transports are skipped with a reason, the rest still import", () => {
		const result = parseMcpImport(JSON.stringify({
			mcpServers: {
				old: { type: "sse", url: "https://old.example.com/sse" },
				socket: { type: "websocket", url: "wss://x.example.com" },
				empty: { description: "nothing to run" },
				ok: { command: "node" }
			}
		}));
		expect(result.servers.map((server) => server.config.id)).toEqual(["ok"]);
		expect(result.skipped.map((skip) => skip.name).sort()).toEqual(["empty", "old", "socket"]);
		expect(result.skipped.find((skip) => skip.name === "old")?.reason).toContain("HTTP+SSE");
	});

	test("invalid definitions are skipped with the reason the settings page would give", () => {
		const result = parseMcpImport(JSON.stringify({
			mcpServers: {
				insecure: { url: "http://example.com/mcp" },
				badArgs: { command: "node", args: "run server.js" },
				badEnv: { command: "node", env: { "BAD NAME": "1" } }
			}
		}));
		expect(result.servers).toEqual([]);
		expect(result.skipped.map((skip) => skip.name)).toEqual(["insecure", "badArgs", "badEnv"]);
		expect(result.skipped[0]?.reason).toContain("https");
		expect(result.skipped[1]?.reason).toContain("arguments");
	});

	test("fields AskMate does not honour are listed, and approval lists are not carried over", () => {
		const result = parseMcpImport(JSON.stringify({
			mcpServers: { x: { command: "node", cwd: "/tmp", envFile: ".env", autoApprove: ["everything"], timeout: 5 } }
		}));
		const warnings = result.servers[0]?.warnings.join("\n") ?? "";
		expect(warnings).toContain("cwd");
		expect(warnings).toContain("envFile");
		expect(warnings).toContain("autoApprove");
		expect(warnings).toContain("asks before every tool call");
		expect(result.servers[0]?.config.approval).toBe("always-ask");
	});

	test("placeholders are not stored as secrets and are flagged", () => {
		const result = parseMcpImport(JSON.stringify({
			mcpServers: {
				x: {
					command: "node",
					env: { API_TOKEN: "${input:api-token}", HOME_DIR: "${env:HOME}", EMPTY_KEY: "" }
				},
				y: { url: "https://y.example.com/mcp", headers: { Authorization: "Bearer ${input:token}" } }
			}
		}));
		const [x, y] = result.servers;
		expect(x?.secrets).toEqual([]);
		expect(x?.config).toMatchObject({ env: { API_TOKEN: { kind: "secret" }, HOME_DIR: { kind: "plain", value: "${env:HOME}" }, EMPTY_KEY: { kind: "secret" } } });
		expect(x?.warnings.join("\n")).toContain("placeholder");
		expect(x?.warnings.join("\n")).toContain("askmate-mcp-x-api-token");
		expect(y?.secrets).toEqual([]);
		expect(y?.config).toMatchObject({ bearerSecretId: "askmate-mcp-y-token" });
		expect(y?.warnings.join("\n")).toContain("no usable value");
	});

	test("a non-bearer Authorization header becomes a secret header, and reserved headers are dropped with a warning", () => {
		const result = parseMcpImport(JSON.stringify({
			mcpServers: { z: { url: "https://z.example.com/mcp", headers: { Authorization: "Basic dXNlcjpwYXNz", "Content-Length": "1", "X-Key": "k1" } } }
		}));
		const z = result.servers[0];
		expect(z?.config).toMatchObject({ bearerSecretId: null, headers: { Authorization: { kind: "secret" }, "X-Key": { kind: "secret" } } });
		expect(JSON.stringify(z?.config)).not.toContain("dXNlcjpwYXNz");
		expect(z?.secrets.map((secret) => secret.value).sort()).toEqual(["Basic dXNlcjpwYXNz", "k1"]);
		expect(z?.warnings.join("\n")).toContain("Content-Length");
	});

	test("a URL that ends in /sse is warned about, and a command with spaces and no arguments is flagged", () => {
		const result = parseMcpImport(JSON.stringify({ mcpServers: { a: { url: "https://a.example.com/sse" }, b: { command: "npx -y pkg" } } }));
		expect(result.servers[0]?.warnings.join(" ")).toContain("/sse");
		expect(result.servers[1]?.warnings.join(" ")).toContain("spaces");
		const path = parseMcpImport(JSON.stringify({ mcpServers: { c: { command: "C:\\Program Files\\node\\node.exe" } } }));
		expect(path.servers[0]?.warnings).toEqual([]);
	});

	test("a disabled entry is imported switched off", () => {
		expect(parseMcpImport('{"mcpServers":{"a":{"command":"node","disabled":true}}}').servers[0]?.config.enabled).toBe(false);
	});
});

describe("ids and limits", () => {
	test("names map to distinct ids, avoid existing ones, and secret ids stay unique within a server", () => {
		const result = parseMcpImport(JSON.stringify({
			mcpServers: {
				"My Server": { command: "a" },
				"my-server": { command: "b" },
				"Existing": { command: "c", env: { A_KEY: "1", A__KEY: "2" } }
			}
		}), new Set(["existing"]));
		expect(result.servers.map((server) => server.config.id)).toEqual(["my-server", "my-server-2", "existing-2"]);
		const ids = result.servers[2]?.secrets.map((secret) => secret.secretId) ?? [];
		expect(new Set(ids).size).toBe(2);
	});

	test("input that is not JSON, has no servers or is too large is an error, not a crash", () => {
		expect(parseMcpImport("not json").error).toContain("not valid JSON");
		expect(parseMcpImport("{}").error).toContain("No servers");
		expect(parseMcpImport("[]").error).toContain("No servers");
		expect(parseMcpImport("null").error).toContain("No servers");
		expect(parseMcpImport('{"mcpServers":{}}').error).toContain("No servers");
		expect(parseMcpImport("x".repeat(300_000)).error).toContain("too much");
	});

	test("at most 50 servers are kept in total", () => {
		const many = Object.fromEntries(Array.from({ length: 60 }, (_, index) => [`s${index}`, { command: "node" }]));
		const result = parseMcpImport(JSON.stringify({ mcpServers: many }), new Set(Array.from({ length: 10 }, (_, index) => `old${index}`)));
		expect(result.servers).toHaveLength(40);
		expect(result.skipped).toHaveLength(20);
		expect(result.skipped[0]?.reason).toContain("at most 50");
	});

	test("labels are cleaned", () => {
		const result = parseMcpImport(JSON.stringify({ mcpServers: { "  Evil\u200b\n Name  ": { command: "node" } } }));
		expect(result.servers[0]?.config.label).toBe("Evil Name");
	});
});

describe("stripJsonComments", () => {
	test("leaves comment-like text inside strings alone", () => {
		const text = '{"url": "https://a.example.com/x", "note": "// not a comment, /* nor this */", "list": [1, 2,]}';
		expect(JSON.parse(stripJsonComments(text))).toEqual({ url: "https://a.example.com/x", note: "// not a comment, /* nor this */", list: [1, 2] });
	});

	test("handles escaped quotes, line and block comments, and an unterminated block comment", () => {
		expect(JSON.parse(stripJsonComments('{"a": "say \\"hi\\" // still a string"} // trailing'))).toEqual({ a: 'say "hi" // still a string' });
		expect(JSON.parse(stripJsonComments('{/* one */"a": 1, // two\n"b": 2}'))).toEqual({ a: 1, b: 2 });
		expect(() => stripJsonComments('{"a": 1} /* never closed')).not.toThrow();
	});

	test("stays fast on a large input with many commas", () => {
		const text = `[${Array.from({ length: 30_000 }, () => "1").join(", ")}]`;
		const started = Date.now();
		expect(JSON.parse(stripJsonComments(text))).toHaveLength(30_000);
		expect(Date.now() - started).toBeLessThan(1000);
	});
});
