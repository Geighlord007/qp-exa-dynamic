/**
 * Live end-to-end check: runs the real provider against the real Exa API.
 *
 * Usage (PowerShell):
 *   $env:EXA_API_KEY = "<key>"; node test/live.mjs
 *
 * This is not part of `npm test`: it spends real API credits and needs a key.
 */

import { ExaSearchProvider } from "../lib/index.js";

const apiKey = process.env.EXA_API_KEY;
if (apiKey === undefined || apiKey.length === 0) {
	console.error("live: EXA_API_KEY is not set");
	process.exit(1);
}

const QUERY = "How are inference providers reducing transformer latency?";

const BASE = {
	providerId: "exa",
	apiKey,
	baseURL: "https://api.exa.ai",
	searchType: "auto",
	numResults: 8,
	dynamicHighlights: true,
};

/** Run one provider configuration and report what came back. */
async function run(label, overrides) {
	const provider = new ExaSearchProvider(() => ({ ...BASE, ...overrides }));
	const started = Date.now();
	const result = await provider.search({ query: QUERY }, undefined);
	const chars = result.sources.reduce((total, source) => total + source.snippet.length, 0);
	console.log(
		`${label.padEnd(34)} sources=${String(result.sources.length).padStart(2)}  snippetChars=${String(chars).padStart(6)}  ${Date.now() - started}ms`,
	);
	return { result, chars };
}

console.log("available():", new ExaSearchProvider(() => BASE).available());

const dynamic = await run("dynamicHighlights: true", {});
await run("dynamicHighlights: false (1500)", { dynamicHighlights: false, highlightsMaxCharacters: 1500 });

// The runtime toggle, exercised the way `/exa` exercises it: one provider
// instance, options re-read per operation.
let live = { ...BASE };
const toggling = new ExaSearchProvider(() => live);
const before = await toggling.search({ query: QUERY }, undefined);
live = { ...live, dynamicHighlights: false };
const after = await toggling.search({ query: QUERY }, undefined);
const size = (result) => result.sources.reduce((total, source) => total + source.snippet.length, 0);
console.log(`\ntoggle: same provider instance -> ${size(before)} chars (dynamic) -> ${size(after)} chars (off)`);

const first = dynamic.result.sources[0];
console.log("\nsources[0] =", JSON.stringify({ ...first, snippet: first.snippet.slice(0, 160) + " ..." }, null, 2));
console.log("\nall source urls:");
for (const source of dynamic.result.sources) console.log("  -", source.url);
