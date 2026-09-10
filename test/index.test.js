/**
 * Unit tests for dsh-web-search-exa-dynamic.
 *
 * These are the tests that matter for this package's whole reason to exist:
 * the beta opt-in must ride the request exactly when the body asks for
 * `dynamic`, the dead `highlightsPerUrl` parameter must never be sent, and the
 * runtime toggle must take effect on the next search rather than needing a
 * reload.
 */

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
	COMMAND_NAME,
	DYNAMIC_BETA_HEADER,
	DYNAMIC_BETA_VALUE,
	ExaSearchProvider,
	SEARCH_TYPES,
	SETTINGS_NAMESPACE,
	TOOL_MAX_RESULTS_LIMIT,
	TOOL_NAME,
	apply,
	buildSearchBody,
	buildSearchHeaders,
	clampToolMaxResults,
	formatToolSources,
	interpretExaCommand,
	resolveOptions,
} from "../lib/index.js";

const BASE_OPTIONS = {
	providerId: "exa",
	apiKey: "test-key",
	baseURL: "https://api.exa.ai",
	searchType: "auto",
	numResults: 8,
	dynamicHighlights: true,
};

/** A provider whose options are re-read on every operation, like the real one. */
function providerFor(overrides = {}) {
	return new ExaSearchProvider(() => ({ ...BASE_OPTIONS, ...overrides }));
}

/** Replace global fetch with a recorder returning a canned response. */
function stubFetch({ payload = { results: [] }, status = 200 } = {}) {
	const calls = [];
	globalThis.fetch = async (url, init) => {
		calls.push({ url, init, body: init.body === undefined ? undefined : JSON.parse(init.body) });
		return {
			ok: status >= 200 && status < 300,
			status,
			json: async () => payload,
		};
	};
	return calls;
}

/** Read a header case-insensitively (fetch header records are plain objects here). */
function headerOf(headers, name) {
	const wanted = name.toLowerCase();
	for (const [key, value] of Object.entries(headers)) {
		if (key.toLowerCase() === wanted) return value;
	}
	return undefined;
}

beforeEach(() => {
	delete globalThis.fetch;
});

// ── the reason this package exists ─────────────────────────────────────────

test("dynamic highlights are on by default and the beta header rides along", async () => {
	const calls = stubFetch();
	await providerFor().search({ query: "anything" }, undefined);

	assert.equal(calls.length, 1);
	assert.equal(calls[0].url, "https://api.exa.ai/search");
	assert.deepEqual(calls[0].body.contents, { highlights: { dynamic: true } });
	assert.equal(headerOf(calls[0].init.headers, DYNAMIC_BETA_HEADER), DYNAMIC_BETA_VALUE);
	assert.equal(calls[0].init.method, "POST");
	assert.equal(calls[0].init.redirect, "error");
});

test("the dead highlightsPerUrl parameter is never sent", async () => {
	for (const dynamicHighlights of [true, false]) {
		const calls = stubFetch();
		await providerFor({ dynamicHighlights }).search({ query: "anything" }, undefined);
		assert.equal(
			JSON.stringify(calls[0].body).includes("highlightsPerUrl"),
			false,
			`highlightsPerUrl leaked with dynamicHighlights=${dynamicHighlights}`,
		);
	}
});

test("beta header and dynamic flag can never drift apart", () => {
	for (const dynamicHighlights of [true, false]) {
		const options = { ...BASE_OPTIONS, dynamicHighlights };
		const body = buildSearchBody("q", undefined, options);
		const headers = buildSearchHeaders(options.apiKey, options);
		const wantsDynamic = body.contents.highlights.dynamic === true;
		const sendsBeta = headerOf(headers, DYNAMIC_BETA_HEADER) === DYNAMIC_BETA_VALUE;
		assert.equal(
			wantsDynamic,
			sendsBeta,
			`dynamic=${wantsDynamic} but beta header=${sendsBeta} for dynamicHighlights=${dynamicHighlights}`,
		);
	}
});

// ── the runtime toggle ─────────────────────────────────────────────────────

test("flipping the flag takes effect on the very next search", async () => {
	let live = { ...BASE_OPTIONS };
	const provider = new ExaSearchProvider(() => live);
	const calls = stubFetch();

	await provider.search({ query: "first" }, undefined);
	live = { ...live, dynamicHighlights: false };
	await provider.search({ query: "second" }, undefined);

	assert.deepEqual(calls[0].body.contents, { highlights: { dynamic: true } });
	assert.equal(headerOf(calls[0].init.headers, DYNAMIC_BETA_HEADER), DYNAMIC_BETA_VALUE);

	assert.deepEqual(calls[1].body.contents, { highlights: true });
	assert.equal(headerOf(calls[1].init.headers, DYNAMIC_BETA_HEADER), undefined);
});

/** Interpret against a live settings snapshot, with the tool's cap unobserved. */
function cmd(rawInput, dynamicHighlights, overrides = {}) {
	return interpretExaCommand(rawInput, {
		dynamicHighlights,
		searchType: "auto",
		numResults: 8,
		...overrides,
	});
}

test("/exa with no argument toggles, and the toggle is symmetric", () => {
	const on = cmd("", true);
	assert.equal(on.kind, "success");
	assert.deepEqual(on.write, { dynamicHighlights: false });

	const off = cmd("", false);
	assert.equal(off.kind, "success");
	assert.deepEqual(off.write, { dynamicHighlights: true });

	// "turn it off" must stay distinguishable from "do not write"
	assert.notEqual(off.write, undefined);
	assert.notEqual(on.write, undefined);
});

test("/exa accepts on, off and status, and is case/space tolerant", () => {
	assert.deepEqual(cmd(" ON ", false), {
		kind: "success",
		write: { dynamicHighlights: true },
		text: "Exa Dynamic Highlights: on",
	});
	assert.deepEqual(cmd("Off", true), {
		kind: "success",
		write: { dynamicHighlights: false },
		text: "Exa Dynamic Highlights: off",
	});

	// status never writes, and reports every knob — including the type list, so
	// "which types were there again" never needs a second command.
	const status = cmd("status", true, { searchType: "deep", numResults: 5, observedCap: 8 });
	assert.equal(status.kind, "success");
	assert.equal(status.write, undefined);
	assert.match(status.text, /is on/);
	assert.match(status.text, /search type is deep/);
	assert.match(status.text, /max sources is 5/);
	assert.match(status.text, /caps every call at 8/, "status must explain the real ceiling");
	for (const type of SEARCH_TYPES) {
		assert.match(status.text, new RegExp(type), `status must list the ${type} type`);
	}

	// a no-op request reports rather than writing
	const already = cmd("on", true);
	assert.equal(already.write, undefined);
	assert.match(already.text, /already on/);
});

test("/exa results reports and sets the source cap", () => {
	const reported = cmd("results", true, { numResults: 5, observedCap: 8 });
	assert.equal(reported.kind, "success");
	assert.equal(reported.write, undefined);
	assert.match(reported.text, /at most 5 sources/);
	assert.match(reported.text, /caps every call at 8/);

	assert.deepEqual(cmd("results 3", true), {
		kind: "success",
		write: { numResults: 3 },
		text: "Exa returns at most 3 sources",
	});
});

test("/exa results warns instead of lying when the tool cap makes it unreachable", () => {
	// The tool sends maxResults=8 on every call, so asking for 20 cannot take
	// effect. It must still be saved (the cap may be raised later) but the
	// reply has to say so.
	const outcome = cmd("results 20", true, { observedCap: 8 });
	assert.equal(outcome.kind, "success");
	assert.deepEqual(outcome.write, { numResults: 20 });
	assert.match(outcome.text, /caps every call at 8/);
});

test("/exa results rejects nonsense", () => {
	for (const input of ["results 0", "results -3", "results two", "results 2.5"]) {
		const bad = cmd(input, true);
		assert.equal(bad.kind, "error", `${input} should be rejected`);
		assert.equal(bad.write, undefined);
	}

	const same = cmd("results 8", true);
	assert.equal(same.write, undefined);
	assert.match(same.text, /already returns at most 8/);
});

test("/exa type lists the available types without writing", () => {
	const listed = cmd("type", true);
	assert.equal(listed.kind, "success");
	assert.equal(listed.write, undefined);
	for (const type of SEARCH_TYPES) assert.match(listed.text, new RegExp(type));
});

test("/exa type <t> sets the retrieval type, and rejects an unknown one", () => {
	assert.deepEqual(cmd("type deep", true), {
		kind: "success",
		write: { searchType: "deep" },
		text: "Exa search type: deep",
	});

	const already = cmd("type auto", true, { searchType: "auto" });
	assert.equal(already.write, undefined);
	assert.match(already.text, /already auto/);

	const bad = cmd("type turbo", true);
	assert.equal(bad.kind, "error");
	assert.equal(bad.write, undefined);
	assert.match(bad.text, /unknown type "turbo"/);
});

test("the hint template's brackets are transparent", () => {
	// The composer inserts input.hint as an editable template, so people end up
	// submitting the brackets along with their value. Reported from a real
	// session: `/exa [on]` was rejected as an unknown argument.
	assert.deepEqual(cmd("[on]", false), {
		kind: "success",
		write: { dynamicHighlights: true },
		text: "Exa Dynamic Highlights: on",
	});
	assert.deepEqual(cmd("<off>", true), {
		kind: "success",
		write: { dynamicHighlights: false },
		text: "Exa Dynamic Highlights: off",
	});
	assert.equal(cmd('"status"', true).kind, "success");
	assert.match(cmd("[status]", true).text, /is on/);

	// ...including when only the value is bracketed, as the hint suggests.
	assert.deepEqual(cmd("type [deep]", true), {
		kind: "success",
		write: { searchType: "deep" },
		text: "Exa search type: deep",
	});
	assert.deepEqual(cmd("results [3]", true), {
		kind: "success",
		write: { numResults: 3 },
		text: "Exa returns at most 3 sources",
	});
});

test("an untouched hint template is reported, not guessed at", () => {
	const outcome = cmd("[on|off|status|type <type>]", true);

	assert.equal(outcome.kind, "error");
	assert.equal(outcome.write, undefined);
	assert.match(outcome.text, /hint template/);
	// Every option in it is a different action, so it must not silently pick one.
	assert.match(outcome.text, /on, off, status/);
});

test("/exa rejects an unknown argument instead of guessing", () => {
	const bad = cmd("maybe", true);
	assert.equal(bad.kind, "error");
	assert.equal(bad.write, undefined);
	assert.match(bad.text, /unknown argument/);
});

test("every search type Exa documents is accepted by the config schema", () => {
	// The first-party provider's schema is stale and rejects anything past
	// auto/keyword/neural; ours must not.
	assert.deepEqual(SEARCH_TYPES, [
		"auto",
		"keyword",
		"neural",
		"instant",
		"fast",
		"deep-lite",
		"deep",
		"deep-reasoning",
	]);
	for (const searchType of SEARCH_TYPES) {
		const resolved = resolveOptions({ searchType });
		assert.equal(resolved.searchType, searchType, `${searchType} must survive resolveOptions`);
	}
});

test("the deep types are sent to Exa verbatim", async () => {
	for (const searchType of ["instant", "fast", "deep-lite", "deep", "deep-reasoning"]) {
		const calls = stubFetch();
		await providerFor({ searchType, dynamicHighlights: false }).search({ query: "q" }, undefined);
		assert.equal(calls[0].body.type, searchType);
	}
});

// ── request shaping ────────────────────────────────────────────────────────

test("with dynamic off, maxCharacters is the cap and no beta header is sent", async () => {
	const calls = stubFetch();
	await providerFor({ dynamicHighlights: false, highlightsMaxCharacters: 900 }).search(
		{ query: "anything" },
		undefined,
	);

	assert.deepEqual(calls[0].body.contents, { highlights: { maxCharacters: 900 } });
	assert.equal(headerOf(calls[0].init.headers, DYNAMIC_BETA_HEADER), undefined);
});

test("with dynamic off and no cap, bare highlights:true is sent", () => {
	const body = buildSearchBody("q", undefined, { ...BASE_OPTIONS, dynamicHighlights: false });
	assert.deepEqual(body.contents, { highlights: true });
});

test("dynamic is never combined with maxCharacters", () => {
	const body = buildSearchBody("q", undefined, {
		...BASE_OPTIONS,
		dynamicHighlights: true,
		highlightsMaxCharacters: 900,
	});
	assert.deepEqual(body.contents, { highlights: { dynamic: true } });
});

test("per-request maxResults wins over the configured numResults", async () => {
	const calls = stubFetch();
	await providerFor().search({ query: "q", maxResults: 3 }, undefined);
	assert.equal(calls[0].body.numResults, 3);
});

test("a configured numResults can pull the caller's cap down but never up", () => {
	// The seam truncates to the request's own cap, so asking Exa for more than
	// the caller allowed would only buy tokens that get thrown away.
	assert.equal(buildSearchBody("q", 8, { ...BASE_OPTIONS, numResults: 3 }).numResults, 3);
	assert.equal(buildSearchBody("q", 8, { ...BASE_OPTIONS, numResults: 20 }).numResults, 8);
	assert.equal(buildSearchBody("q", 8, { ...BASE_OPTIONS, numResults: 8 }).numResults, 8);
	// With no caller cap the configured value stands alone.
	assert.equal(buildSearchBody("q", undefined, { ...BASE_OPTIONS, numResults: 5 }).numResults, 5);
});

test("configured numResults is used when the request carries none", async () => {
	const calls = stubFetch();
	await providerFor().search({ query: "q" }, undefined);
	assert.equal(calls[0].body.numResults, 8);
});

test("resolveOptions applies defaults and keeps an absent cap absent", () => {
	const resolved = resolveOptions({});
	assert.equal(resolved.baseURL, "https://api.exa.ai");
	assert.equal(resolved.searchType, "auto");
	assert.equal(resolved.numResults, 8);
	assert.equal(resolved.dynamicHighlights, true);
	assert.equal(resolved.apiKey, "");
	assert.equal("highlightsMaxCharacters" in resolved, false);
});

// ── result mapping and failure modes ───────────────────────────────────────

test("results map to sources, and snippet-less entries are dropped", async () => {
	stubFetch({
		payload: {
			results: [
				{ url: "https://a.example", title: "A", highlights: ["  ", "real snippet"], publishedDate: "2026-01-02" },
				{ url: "https://b.example", title: "B", highlights: [] },
				{ url: "https://c.example", highlights: ["only a snippet"] },
			],
		},
	});
	const result = await providerFor().search({ query: "q" }, undefined);

	assert.deepEqual(result, {
		truncated: false,
		sources: [
			{ url: "https://a.example", title: "A", snippet: "real snippet", publishedAt: "2026-01-02" },
			{ url: "https://c.example", snippet: "only a snippet" },
		],
	});
});

test("an HTTP error surfaces as WEB_PROVIDER_ERROR carrying Exa's message", async () => {
	stubFetch({
		status: 400,
		payload: { error: "'highlights.dynamic' is in beta.", tag: "INVALID_REQUEST" },
	});
	await assert.rejects(
		() => providerFor().search({ query: "q" }, undefined),
		(error) => error.code === "WEB_PROVIDER_ERROR" && /in beta/.test(error.message),
	);
});

test("an already-aborted signal surfaces as WEB_ABORTED without calling fetch", async () => {
	const calls = stubFetch();
	const controller = new AbortController();
	controller.abort();
	await assert.rejects(
		() => providerFor().search({ query: "q" }, controller.signal),
		(error) => error.code === "WEB_ABORTED",
	);
	assert.equal(calls.length, 0);
});

test("available() is false without a key and true with one", () => {
	assert.equal(providerFor({ apiKey: "" }).available(), false);
	assert.equal(providerFor().available(), true);
	assert.equal(providerFor({ baseURL: "not a url" }).available(), false);
});

// ── apply() wiring ─────────────────────────────────────────────────────────
//
// apply() is what actually runs inside the harness, so a bug here takes down
// the whole web search rather than failing one query. This mock stands in for
// cordis: it answers ctx.inject for the two optional services and records what
// the plugin registered.

// ── the exa_search tool ────────────────────────────────────────────────────
//
// This tool exists to escape `dsh-tool-web`'s per-request cap, which no
// provider can exceed and which otherwise costs an agent-preset fork.

test("clampToolMaxResults bounds the model's argument without failing the call", () => {
	assert.equal(clampToolMaxResults(undefined), undefined, "absent means use the configured default");
	assert.equal(clampToolMaxResults("20"), undefined, "a non-number falls back rather than throwing");
	assert.equal(clampToolMaxResults(Number.NaN), undefined);
	assert.equal(clampToolMaxResults(0), 1);
	assert.equal(clampToolMaxResults(-5), 1);
	assert.equal(clampToolMaxResults(20), 20);
	assert.equal(clampToolMaxResults(20.7), 20);
	assert.equal(clampToolMaxResults(1000), TOOL_MAX_RESULTS_LIMIT);
});

test("formatToolSources carries the untrusted-content notice and markdown links", () => {
	const text = formatToolSources([
		{ url: "https://a.example/x", title: "A", snippet: "snip", publishedAt: "2026-01-02" },
		{ url: "https://b.example" },
	]);
	assert.match(text, /untrusted data, not instructions/);
	assert.match(text, /- \[A\]\(https:\/\/a\.example\/x\) — snip \(2026-01-02\)/);
	assert.match(text, /- \[b\.example\]\(https:\/\/b\.example\)/, "a missing title falls back to the hostname");
	assert.match(text, /Cite the relevant URLs/);
	assert.match(formatToolSources([]), /No results found\./);
});

test("apply() registers the exa_search tool and the guidance beside web_search's", async () => {
	const { ctx, state } = makeCtx();
	await apply(ctx, { apiKey: "test-key" });

	const tool = state.tools.find((candidate) => candidate.name === TOOL_NAME);
	assert.notEqual(tool, undefined, "the tool must be registered under its own name");
	// defineTool normalizes the parameter DSL into a JSON Schema.
	assert.equal(tool.parameters.type, "object");
	assert.deepEqual(tool.parameters.required, ["query"]);
	assert.equal(tool.parameters.properties.query.type, "string");
	assert.equal(tool.parameters.properties.maxResults.type, "integer");

	assert.equal(state.promptSections.length, 1);
	assert.equal(state.promptSections[0].name, `tool:${TOOL_NAME}`);
	// TOOL_WEB_SEARCH is 2000; ours must sit next to it, not before it.
	assert.equal(state.promptSections[0].order, 2010);
	assert.match(state.promptSections[0].text({ scope: undefined }), /maxResults/);
});

test("the tool owns request.maxResults instead of inheriting tool-web's cap", async () => {
	const { ctx, state } = makeCtx();
	const calls = [];
	ctx.web.search = async (request) => {
		calls.push(request);
		return { sources: [], truncated: false };
	};
	await apply(ctx, { apiKey: "test-key" });
	const tool = state.tools.find((candidate) => candidate.name === TOOL_NAME);

	await tool.execute({ query: "q", maxResults: 20 }, { signal: undefined });
	assert.deepEqual(calls[0], { query: "q", maxResults: 20 });

	await tool.execute({ query: "q", maxResults: 1000 }, { signal: undefined });
	assert.deepEqual(calls[1], { query: "q", maxResults: TOOL_MAX_RESULTS_LIMIT }, "the bound is ours");

	await tool.execute({ query: "q" }, { signal: undefined });
	assert.deepEqual(calls[2], { query: "q" }, "omitted means the configured default decides");
});

test("with no tool registry the provider still mounts", async () => {
	const { ctx, state } = makeCtx({ withTools: false });
	await apply(ctx, { apiKey: "test-key" });

	assert.equal(state.tools.length, 0);
	assert.equal(state.promptSections.length, 0);
	assert.equal(state.providers.length, 1);
	assert.equal(state.providers[0].available(), true);
});

test("the command declares input, or the composer never routes arguments to it", async () => {
	// dsh-client-ui-commands/lib/client.js:747 claims a parameterised line only
	// when `desc.input !== undefined`; line 751 sends everything else to the
	// model as an ordinary chat message. Dropping this field silently broke
	// `/exa status`, `/exa type deep` and `/exa results 3` in the Web composer
	// while leaving bare `/exa` working — which is exactly what got reported.
	const { ctx, state } = makeCtx();
	await apply(ctx, { apiKey: "test-key" });

	const command = state.commands[0];
	assert.notEqual(command.input, undefined, "input must be declared or arguments are never claimed");
	assert.equal(typeof command.input.hint, "string", "the claim carries input.hint to the composer");
	assert.ok(command.input.hint.length > 0);
});

function makeCtx({
	withSettings = true,
	withCommands = true,
	withTools = true,
	failUpdate = false,
	failRegister = false,
} = {}) {
	const state = {
		providers: [],
		commands: [],
		sections: [],
		updates: [],
		section: {},
		tools: [],
		promptSections: [],
	};
	const scope = {
		get: () => state.section,
		update: async (patch) => {
			if (failUpdate) throw new Error("SETTINGS_CONFLICT");
			state.updates.push(patch);
			state.section = { ...state.section, ...patch };
		},
	};
	const root = {
		web: {
			registerSearchProvider: (provider) => state.providers.push(provider),
			search: async () => ({ sources: [], truncated: false }),
		},
		effect: () => () => {},
		inject(names, callback) {
			const child = { ...root };
			if (names.includes("settings")) {
				if (!withSettings) return;
				child.settings = {
					register: (ns, schema, options) => {
						if (failRegister) throw new Error(`settings namespace "${ns}" is already registered`);
						state.sections.push({ ns, base: options?.base });
						state.section = { ...(options?.base ?? {}) };
						return scope;
					},
				};
			}
			if (names.includes("commands")) {
				if (!withCommands) return;
				child.commands = {
					register: (definition) => {
						state.commands.push(definition);
						return () => {};
					},
				};
			}
			if (names.includes("tools")) {
				if (!withTools) return;
				child.tools = {
					register: (definition) => {
						state.tools.push(definition);
						return () => {};
					},
					get: (toolName) => state.tools.find((tool) => tool.name === toolName),
				};
			}
			if (names.includes("systemPrompt")) {
				if (!withTools) return;
				child.systemPrompt = {
					section: (section) => {
						state.promptSections.push(section);
						return () => {};
					},
					getSectionOrder: () => 2000,
				};
			}
			callback(child);
		},
	};
	return { ctx: root, state };
}

/** The signal a real dispatcher always supplies. */
const signal = () => new AbortController().signal;

test("apply() registers the provider, the settings section and the /exa command", async () => {
	const { ctx, state } = makeCtx();
	await apply(ctx, { apiKey: "test-key" });

	assert.equal(state.providers.length, 1);
	assert.equal(state.providers[0].id, "exa");
	assert.equal(state.providers[0].available(), true);

	assert.equal(state.sections.length, 1);
	assert.equal(state.sections[0].ns, SETTINGS_NAMESPACE);
	assert.equal(state.sections[0].base.apiKey, "test-key");

	assert.equal(state.commands.length, 1);
	assert.equal(state.commands[0].name, COMMAND_NAME);
	assert.equal(typeof state.commands[0].handler, "function");
});

test("end to end: /exa off persists, and the next search drops the beta header", async () => {
	const { ctx, state } = makeCtx();
	await apply(ctx, { apiKey: "test-key" });
	const provider = state.providers[0];
	const calls = stubFetch();

	await provider.search({ query: "before" }, undefined);
	const result = await state.commands[0].handler({ rawInput: " off ", signal: signal() });
	await provider.search({ query: "after" }, undefined);

	assert.equal(result.kind, "success");
	assert.deepEqual(state.updates, [{ dynamicHighlights: false }], "the toggle must persist through the scope");

	assert.deepEqual(calls[0].body.contents, { highlights: { dynamic: true } });
	assert.equal(headerOf(calls[0].init.headers, DYNAMIC_BETA_HEADER), DYNAMIC_BETA_VALUE);
	assert.deepEqual(calls[1].body.contents, { highlights: true });
	assert.equal(headerOf(calls[1].init.headers, DYNAMIC_BETA_HEADER), undefined);
});

test("/exa status reports without writing, and a bad argument never writes", async () => {
	const { ctx, state } = makeCtx();
	await apply(ctx, { apiKey: "test-key" });
	const command = state.commands[0];

	const status = await command.handler({ rawInput: "status", signal: signal() });
	assert.equal(status.kind, "success");
	assert.match(status.text, /is on/);

	const bad = await command.handler({ rawInput: "nonsense", signal: signal() });
	assert.equal(bad.kind, "error");

	assert.deepEqual(state.updates, [], "neither status nor a bad argument may write");
});

test("with no settings service the command still toggles, in memory", async () => {
	const { ctx, state } = makeCtx({ withSettings: false });
	await apply(ctx, { apiKey: "test-key" });
	const calls = stubFetch();

	assert.equal(state.sections.length, 0);
	const result = await state.commands[0].handler({ rawInput: "", signal: signal() });
	assert.equal(result.kind, "success");

	await state.providers[0].search({ query: "after" }, undefined);
	assert.deepEqual(calls[0].body.contents, { highlights: true });
	assert.equal(headerOf(calls[0].init.headers, DYNAMIC_BETA_HEADER), undefined);
});

test("with no command service the provider still mounts", async () => {
	const { ctx, state } = makeCtx({ withCommands: false });
	await apply(ctx, { apiKey: "test-key" });

	assert.equal(state.commands.length, 0);
	assert.equal(state.providers.length, 1);
	assert.equal(state.providers[0].available(), true);
});

test("a rejected settings write settles as an error result, never a throw", async () => {
	const { ctx, state } = makeCtx({ failUpdate: true });
	await apply(ctx, { apiKey: "test-key" });

	const result = await state.commands[0].handler({ rawInput: "off", signal: signal() });
	assert.equal(result.kind, "error");
	assert.match(result.text, /could not save/);
	assert.deepEqual(state.updates, []);
});

test("a duplicate settings namespace degrades to in-memory instead of killing the provider", async () => {
	const { ctx, state } = makeCtx({ failRegister: true });
	await apply(ctx, { apiKey: "test-key" });
	const calls = stubFetch();

	// The provider still mounts and still serves searches.
	assert.equal(state.providers.length, 1);
	assert.equal(state.providers[0].available(), true);
	await state.providers[0].search({ query: "q" }, undefined);
	assert.deepEqual(calls[0].body.contents, { highlights: { dynamic: true } });

	// And /exa still toggles, via the in-memory path.
	assert.equal(state.sections.length, 0);
	const toggled = await state.commands[0].handler({ rawInput: "off", signal: signal() });
	assert.equal(toggled.kind, "success");
	await state.providers[0].search({ query: "q2" }, undefined);
	assert.deepEqual(calls[1].body.contents, { highlights: true });
});
