/**
 * dsh-web-search-exa-dynamic
 *
 * An Exa-backed `WebSearchProvider` for the DeepSeek Harness web capability
 * seam (`ctx.web`) that enables Exa **Dynamic Highlights** by default, plus a
 * `/exa` slash command that flips it on and off at runtime.
 *
 * Why this exists: the first-party `@deepseek-ai/dsh-web-search-exa` cannot
 * reach Dynamic Highlights for two independent reasons —
 *   1. its request body is hardcoded to `contents.highlights.highlightsPerUrl`,
 *      with no `dynamic` field and no config field that reaches one; and
 *   2. `dynamic` is a beta API, so every request that sets it must also carry
 *      the `Exa-Beta: dynamic-highlights-2026-08-28` header, which that
 *      provider never sends. Without the header Exa answers HTTP 400.
 *
 * This provider addresses both, and drops the dead `highlightsPerUrl`
 * parameter (measured: Exa ignores it entirely, returning an identical payload
 * for values 1 and 5) in favour of `maxCharacters`, which is the knob that
 * actually works when dynamic highlights are switched off.
 *
 * Measured on a real `/search` call, 8 results, one query:
 *   dynamic: true          -> ~12.7k highlight characters
 *   maxCharacters: 1500    -> ~11.0k
 *   first-party default    -> ~51.2k   (~4x more)
 *
 * @module dsh-web-search-exa-dynamic
 */

import { launchEnvironmentOf } from "@deepseek-ai/dsh-launch-environment";
import { WebError } from "@deepseek-ai/dsh-web";
import z from "@deepseek-ai/schemastery";

/** Stable id this provider registers under in the `ctx.web` registry. */
const DEFAULT_PROVIDER_ID = "exa";
/** Default Exa endpoint; `/search` is the operation. */
const DEFAULT_BASE_URL = "https://api.exa.ai";
/** Environment variable consulted when no literal `apiKey` is configured. */
const DEFAULT_API_KEY_ENV = "EXA_API_KEY";
/** Default retrieval mode: Exa picks. */
const DEFAULT_SEARCH_TYPE = "auto";
/**
 * Exa retrieval types. Every one of these was verified against the live API;
 * measured latency on one query, 8 results, ranges from ~460ms to ~18s:
 *
 *   keyword 464ms | neural 737ms | fast 798ms | instant 856ms
 *   auto 1914ms | deep-lite 3116ms | deep 5282ms | deep-reasoning 18278ms
 *
 * The first-party provider's schema lists only `auto`, `keyword` and `neural`,
 * which is stale: `instant`, `fast` and the `deep*` family all work today.
 */
const SEARCH_TYPES = [
	"auto",
	"keyword",
	"neural",
	"instant",
	"fast",
	"deep-lite",
	"deep",
	"deep-reasoning",
];
/** Default result count when the request carries no `maxResults`. */
const DEFAULT_NUM_RESULTS = 8;
/** Default: Dynamic Highlights on. This is the point of the package. */
const DEFAULT_DYNAMIC_HIGHLIGHTS = true;
/** Attribution header sent on every request. */
const USER_AGENT = "dsh-web-search-exa-dynamic/0.1.0";
/** Beta opt-in header name/value required by every `dynamic: true` request. */
const DYNAMIC_BETA_HEADER = "Exa-Beta";
const DYNAMIC_BETA_VALUE = "dynamic-highlights-2026-08-28";
/**
 * Settings namespace carrying this provider's user-overridable section. The
 * plugin config in `cordis.patch.yml` becomes the composition `base`, so the
 * user layer written by `/exa` overrides it. This is also the key a future
 * browser-side settings card would bind to.
 */
const SETTINGS_NAMESPACE = "web-search-exa-dynamic";
/** The slash command that toggles Dynamic Highlights. */
const COMMAND_NAME = "exa";

/** True for a request limit that can be sent to Exa (a positive whole number). */
function isPositiveInteger(value) {
	return Number.isInteger(value) && value > 0;
}

/** True for a fetch/`AbortSignal` abort, surfaced as `WEB_ABORTED`. */
function isAbortError(error) {
	return error instanceof DOMException && error.name === "AbortError";
}

/**
 * Build the `POST /search` body.
 *
 * `dynamic: true` is sent alone: Exa sizes and distributes the shared budget
 * itself, and its docs warn against combining it with `maxCharacters`.
 * With dynamic off, `maxCharacters` is the working per-page cap; we send bare
 * `highlights: true` when no cap is configured rather than an empty object.
 *
 * @param query - the caller's query.
 * @param maxResults - the per-request cap, which wins over the configured default.
 * @param options - resolved provider options.
 * @returns the JSON body for `POST {baseURL}/search`.
 */
function buildSearchBody(query, maxResults, options) {
	// The caller's per-request cap wins, and the configured value can only pull
	// it DOWN. It can never pull it up: the seam truncates the returned sources
	// to the request's own cap, so asking Exa for more than the caller allowed
	// would spend tokens on sources that are then thrown away.
	const numResults = Math.min(maxResults ?? Infinity, options.numResults ?? Infinity);
	const highlights = options.dynamicHighlights
		? { dynamic: true }
		: options.highlightsMaxCharacters !== undefined
			? { maxCharacters: options.highlightsMaxCharacters }
			: true;
	return {
		query,
		type: options.searchType,
		contents: { highlights },
		...(Number.isFinite(numResults) ? { numResults } : {}),
	};
}

/**
 * Build the request headers. The beta opt-in rides along exactly when the body
 * asks for `dynamic`, so the two can never drift apart.
 *
 * @param apiKey - the resolved Exa API key.
 * @param options - resolved provider options.
 * @returns the header record for `POST {baseURL}/search`.
 */
function buildSearchHeaders(apiKey, options) {
	return {
		authorization: `Bearer ${apiKey}`,
		"content-type": "application/json",
		accept: "application/json",
		"user-agent": USER_AGENT,
		...(options.dynamicHighlights ? { [DYNAMIC_BETA_HEADER]: DYNAMIC_BETA_VALUE } : {}),
	};
}

/**
 * Project a resolved settings/config section into provider options.
 *
 * @param section - the merged section (schema defaults, then base, then user).
 * @returns fully resolved provider options.
 */
function resolveOptions(section) {
	const baseURL = section.baseURL ?? DEFAULT_BASE_URL;
	return {
		providerId: section.providerId ?? DEFAULT_PROVIDER_ID,
		apiKey: section.apiKey ?? "",
		baseURL,
		searchType: section.searchType ?? DEFAULT_SEARCH_TYPE,
		numResults: section.numResults ?? DEFAULT_NUM_RESULTS,
		dynamicHighlights: section.dynamicHighlights ?? DEFAULT_DYNAMIC_HIGHLIGHTS,
		...(section.highlightsMaxCharacters !== undefined
			? { highlightsMaxCharacters: section.highlightsMaxCharacters }
			: {}),
	};
}

/**
 * Map one Exa result to a normalized source, or `undefined` when it carries no
 * portable snippet. The seam has no other field to derive a snippet from, so
 * inventing one would make the seam lie.
 *
 * @param result - one entry of Exa's `results[]`.
 * @returns the normalized source, or `undefined` when the entry has no
 *   non-blank highlight.
 */
function mapExaResult(result) {
	const snippet = result.highlights?.find((highlight) => highlight.trim().length > 0);
	if (snippet === undefined) return undefined;
	return {
		url: result.url,
		...(result.title != null && result.title.length > 0 ? { title: result.title } : {}),
		snippet,
		...(result.publishedDate != null && result.publishedDate.length > 0
			? { publishedAt: result.publishedDate }
			: {}),
	};
}

/**
 * Usage line shared by every rejection from {@link interpretExaCommand}.
 * Concrete examples rather than a bracketed grammar: the point is that someone
 * who mistyped should be able to copy a working line straight out of the reply.
 */
const EXA_USAGE = "on, off, status, results 3, type deep";

/**
 * Split one `/exa` argument into lowercase words.
 *
 * The composer offers this command's `input.hint` as an **editable template** —
 * that is the platform convention (`dsh-plan-mode` declares `[off|message]` the
 * same way) — so the argument routinely arrives with the template's punctuation
 * still attached: `/exa [on]`, `/exa <off>`, `/exa "status"`. Brackets and
 * quotes are therefore transparent here, and `type [deep]` or `results [3]`
 * read the way the person typing them meant them.
 *
 * A surviving `|` means the whole template came through untouched. That is
 * reported rather than guessed at, because every option in it is a different
 * action and picking one silently would be worse than asking.
 *
 * @param rawInput - every byte after the command name, including separators.
 * @returns the parsed words, and whether the untouched template was submitted.
 */
function parseExaArgument(rawInput) {
	const words = String(rawInput ?? "")
		.trim()
		.toLowerCase()
		.replace(/[[\]<>"']/g, " ")
		.split(/\s+/)
		.filter((word) => word.length > 0);
	return { words, untouchedTemplate: words.some((word) => word.includes("|")) };
}

/**
 * Interpret one `/exa <argument>` invocation against the current settings.
 *
 * Kept pure so the command grammar is testable without a command registry.
 * Grammar: nothing toggles dynamic highlights; `on`/`off` set it; `results`
 * reports the source cap; `results <n>` sets it; `type` reports and lists the
 * retrieval types; `type <t>` sets one; `status` reports everything.
 *
 * @param rawInput - every byte after the command name, including separators.
 * @param current - the live `{ dynamicHighlights, searchType, numResults,
 *   observedCap }`; `observedCap` is the `maxResults` the tool last sent, and
 *   is the real ceiling a configured count cannot exceed.
 * @returns `kind`, the text to render, and `write` when the invocation asks
 *   for a settings write. `write` is `undefined` for read-only invocations —
 *   deliberately distinct from a write of `false`.
 */
function interpretExaCommand(rawInput, current) {
	const { words, untouchedTemplate } = parseExaArgument(rawInput);
	if (untouchedTemplate) {
		return { kind: "error", text: `that is the hint template — replace it with one of: ${EXA_USAGE}` };
	}
	const state = current.dynamicHighlights ? "on" : "off";
	const type = current.searchType;
	const cap = current.observedCap;
	const capNote =
		cap === undefined ? "" : ` (dsh-tool-web caps every call at ${cap}; raise its searchMaxResults to go above)`;

	if (words.length === 0) {
		return {
			kind: "success",
			write: { dynamicHighlights: !current.dynamicHighlights },
			text: `Exa Dynamic Highlights: ${state} -> ${current.dynamicHighlights ? "off" : "on"}`,
		};
	}

	if (words[0] === "on" || words[0] === "off") {
		const wanted = words[0] === "on";
		if (wanted === current.dynamicHighlights) {
			return { kind: "success", text: `Exa Dynamic Highlights is already ${state}` };
		}
		return {
			kind: "success",
			write: { dynamicHighlights: wanted },
			text: `Exa Dynamic Highlights: ${words[0]}`,
		};
	}

	if (words[0] === "status") {
		return {
			kind: "success",
			text: [
				`Exa Dynamic Highlights is ${state}`,
				`search type is ${type} (available: ${SEARCH_TYPES.join(", ")})`,
				`max sources is ${current.numResults}${capNote}`,
			].join("; "),
		};
	}

	if (words[0] === "results") {
		if (words.length === 1) {
			return { kind: "success", text: `Exa returns at most ${current.numResults} sources${capNote}` };
		}
		const wanted = Number(words[1]);
		if (!Number.isInteger(wanted) || wanted < 1) {
			return { kind: "error", text: `"${words[1]}" is not a positive whole number` };
		}
		if (wanted === current.numResults) {
			return { kind: "success", text: `Exa already returns at most ${wanted} sources${capNote}` };
		}
		const ceiling = cap === undefined ? "" : wanted > cap ? ` — note dsh-tool-web caps every call at ${cap}` : "";
		return {
			kind: "success",
			write: { numResults: wanted },
			text: `Exa returns at most ${wanted} sources${ceiling}`,
		};
	}

	if (words[0] === "type") {
		if (words.length === 1) {
			return {
				kind: "success",
				text: `Exa search type is ${type}. Available: ${SEARCH_TYPES.join(", ")}`,
			};
		}
		const wanted = words[1];
		if (!SEARCH_TYPES.includes(wanted)) {
			return {
				kind: "error",
				text: `unknown type "${wanted}" — available: ${SEARCH_TYPES.join(", ")}`,
			};
		}
		if (wanted === type) {
			return { kind: "success", text: `Exa search type is already ${type}` };
		}
		return { kind: "success", write: { searchType: wanted }, text: `Exa search type: ${wanted}` };
	}

	return {
		kind: "error",
		text: `unknown argument "${words[0]}" — use ${EXA_USAGE}`,
	};
}

/** The Exa-backed search provider; HTTP redirects fail rather than being followed. */
class ExaSearchProvider {
	/**
	 * The `maxResults` the caller last asked for, i.e. the real ceiling on
	 * returned sources (`dsh-tool-web` sends its own `searchMaxResults` here on
	 * every call). Recorded so `/exa status` can explain why a configured count
	 * above it has no effect, instead of silently clamping.
	 */
	lastRequestedCap;

	/**
	 * @param resolveOptions - thunk returning the options for the NEXT operation,
	 *   snapshotted once at each operation's entry, so a runtime toggle takes
	 *   effect on the next search and one search never mixes two sections.
	 */
	constructor(resolveOptions) {
		this.resolveOptions = resolveOptions;
		this.id = resolveOptions().providerId ?? DEFAULT_PROVIDER_ID;
	}

	/** Usable only with a key and a parseable endpoint; both are local checks. */
	available() {
		const options = this.resolveOptions();
		return options.apiKey.length > 0 && URL.canParse(options.baseURL);
	}

	/**
	 * Run one search through Exa.
	 *
	 * @param request - the seam's search request (`query`, optional `maxResults`).
	 * @param signal - optional cancellation signal.
	 * @returns normalized sources; snippet-less entries are dropped.
	 */
	async search(request, signal) {
		if (signal?.aborted === true) {
			throw new WebError("Exa search aborted", "WEB_ABORTED", { cause: signal.reason });
		}
		this.lastRequestedCap = request.maxResults;
		const options = this.resolveOptions();
		let response;
		try {
			response = await fetch(`${options.baseURL}/search`, {
				method: "POST",
				redirect: "error",
				headers: buildSearchHeaders(options.apiKey, options),
				body: JSON.stringify(buildSearchBody(request.query, request.maxResults, options)),
				...(signal !== undefined ? { signal } : {}),
			});
		} catch (error) {
			if (signal?.aborted === true || isAbortError(error)) {
				throw new WebError("Exa search aborted", "WEB_ABORTED", { cause: signal?.reason ?? error });
			}
			throw new WebError(`Exa search request failed: ${String(error)}`, "WEB_PROVIDER_ERROR", { cause: error });
		}
		if (!response.ok) {
			let message = `Exa API error (HTTP ${response.status})`;
			try {
				const parsed = await response.json();
				const detail = parsed.error ?? parsed.message;
				if (detail !== undefined && detail.length > 0) message = detail;
			} catch (error) {
				if (signal?.aborted === true || isAbortError(error)) {
					throw new WebError("Exa search aborted", "WEB_ABORTED", { cause: signal?.reason ?? error });
				}
				// keep the generic message
			}
			throw new WebError(message, "WEB_PROVIDER_ERROR");
		}
		let parsed;
		try {
			parsed = await response.json();
		} catch (error) {
			if (signal?.aborted === true || isAbortError(error)) {
				throw new WebError("Exa search aborted", "WEB_ABORTED", { cause: signal?.reason ?? error });
			}
			throw new WebError(`Exa returned an unprocessable response body: ${String(error)}`, "WEB_PROVIDER_ERROR", {
				cause: error,
			});
		}
		const sources = (parsed.results ?? []).map(mapExaResult).filter((source) => source !== undefined);
		return { sources, truncated: false };
	}
}

/** Cordis plugin name used by loader diagnostics. */
const name = "web-search-exa-dynamic";
/** The web seam this provider registers into. */
const inject = ["web"];

const Config = z.object({
	/** Provider id registered into `ctx.web`. Change it only to coexist with another Exa provider. */
	providerId: z.string().default(DEFAULT_PROVIDER_ID),
	/** Literal Exa API key; falls back to `apiKeyEnv`. */
	apiKey: z.string().role("secret"),
	/** Environment variable consulted when no literal `apiKey` is configured. */
	apiKeyEnv: z.string().default(DEFAULT_API_KEY_ENV),
	/** Exa API base URL; `/search` is appended. */
	baseURL: z.string().default(DEFAULT_BASE_URL),
	/** Retrieval type; see {@link SEARCH_TYPES}. Runs from ~460ms to ~18s. */
	searchType: z.union(SEARCH_TYPES).default(DEFAULT_SEARCH_TYPE),
	/** Default result count when the request carries no `maxResults`. */
	numResults: z.number().step(1).min(1).default(DEFAULT_NUM_RESULTS),
	/** Exa Dynamic Highlights (beta). On by default; adds the required `Exa-Beta` header. */
	dynamicHighlights: z.boolean().default(DEFAULT_DYNAMIC_HIGHLIGHTS),
	/** Per-page highlight cap used only when `dynamicHighlights` is false. */
	highlightsMaxCharacters: z.number().step(1).min(1),
});

/**
 * Register the provider with `ctx.web`, its settings namespace, and the `/exa`
 * command.
 *
 * Both optional services are reached through `ctx.inject`, so the provider
 * still mounts in a composition that has neither: without `settings` the
 * command's writes land in memory for this run, and without `commands` there
 * is simply no slash command.
 *
 * @param ctx - the plugin context; `web` is injected.
 * @param config - the resolved plugin configuration, used as the settings `base`.
 */
function apply(ctx, config) {
	/** Live reader for the merged section; replaced once Settings is mounted. */
	let readSection = () => config;
	/** Writable scope, when a settings provider is mounted. */
	let settingsScope;
	/** In-memory overrides so `/exa` still works with no settings service. */
	let memoryOverride;

	const currentSection = () => {
		const section = readSection();
		return memoryOverride === undefined ? section : { ...section, ...memoryOverride };
	};
	const resolve = () => resolveOptions(currentSection());

	// The provider registers FIRST: everything below is convenience, and a
	// failure there must never take the search path down with it.
	const provider = new ExaSearchProvider(resolve);
	ctx.web.registerSearchProvider(provider);

	ctx.inject(["settings"], (settingsCtx) => {
		// `settings.register` throws on a duplicate namespace, which a patch
		// hot-reload can produce if the previous fiber has not been disposed
		// yet. Losing the section only costs persistence across restarts, so
		// swallow it and let the in-memory override carry `/exa` instead.
		try {
			const scope = settingsCtx.settings.register(SETTINGS_NAMESPACE, Config, { base: config });
			settingsScope = scope;
			readSection = () => scope.get();
		} catch {
			settingsScope = undefined;
		}
	});

	ctx.inject(["commands"], (commandCtx) => {
		try {
			commandCtx.commands.register({
				name: COMMAND_NAME,
				description: "Exa search: show or toggle Dynamic Highlights, set the search type, or set the result count",
				// Deliberately no `input.hint`. The composer offers a hint as an
				// editable template, and a bracketed one invites bracketed input:
				// a submitted `/exa [on]` was rejected before the parser learned to
				// strip it. Plain words are what people actually type here, and the
				// description above is where discovery belongs.
				handler: async ({ rawInput }) => {
					const live = resolve();
					const outcome = interpretExaCommand(rawInput, {
						dynamicHighlights: live.dynamicHighlights,
						searchType: live.searchType,
						numResults: live.numResults,
						observedCap: provider.lastRequestedCap,
					});
					if (outcome.write === undefined) return { kind: outcome.kind, text: outcome.text };
					try {
						if (settingsScope !== undefined) await settingsScope.update(outcome.write);
						else memoryOverride = { ...(memoryOverride ?? {}), ...outcome.write };
					} catch (error) {
						return { kind: "error", text: `could not save: ${String(error?.message ?? error)}` };
					}
					return { kind: "success", text: outcome.text };
				},
			});
		} catch {
			// Losing the command surface is a smaller loss than losing search.
		}
	});
}

export {
	COMMAND_NAME,
	Config,
	DEFAULT_API_KEY_ENV,
	DEFAULT_BASE_URL,
	DEFAULT_DYNAMIC_HIGHLIGHTS,
	DEFAULT_NUM_RESULTS,
	DEFAULT_PROVIDER_ID,
	DEFAULT_SEARCH_TYPE,
	DYNAMIC_BETA_HEADER,
	DYNAMIC_BETA_VALUE,
	ExaSearchProvider,
	EXA_USAGE,
	SEARCH_TYPES,
	SETTINGS_NAMESPACE,
	apply,
	buildSearchBody,
	buildSearchHeaders,
	inject,
	interpretExaCommand,
	mapExaResult,
	name,
	resolveOptions,
};
