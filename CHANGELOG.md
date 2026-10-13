# Changelog

## 0.2.0

Ported to DSH `0.2.0-rc.2`. Searching behaves exactly as before; what changed is the settings seam
`/exa` persists through, plus the dependency metadata that gates installation.

- **The 0.1 settings API is gone.** `settings.register(ns, schema, { base })` and the per-plugin scope
  (`scope.get()` / `scope.update(patch)`) no longer exist. 0.2 exposes one flat `SettingsForms`
  service addressed by Loader **entry id** — `update(entryId, patch, expectedRevision?)`, alongside
  `describe` / `replace` / `mutate`. The old call now throws `settings.register is not a function`,
  which the previous `try/catch` turned into a silent in-memory downgrade: `/exa` appeared to work
  for the session but never persisted.
- **Writable fields are declared with `.volatile()`.** `settings.update` rejects any path that is not
  volatile (`Config field "x" is not volatile`), and the auto-generated configuration card lists only
  volatile fields. `providerId` stays non-volatile on purpose — it is read once to name the registered
  provider, so a live change could only put the registry out of step with `/exa status`.
- **Config reads go through `readLiveConfig`.** A `.volatile()` field arrives in `apply` as a live
  reference rather than a plain value, and the Loader commits a settings write straight into it.
  Unwrapping on every operation is what keeps `/exa` taking effect on the *next* search, and it
  replaces the old scope indirection entirely. References are recognized by the globally registered
  `cosmokit.volatile.write` symbol, so cosmokit needs neither an import nor a new dependency.
- **The settings namespace is the Loader entry id**: `qp-exa-dynamic`, matching the row this bundle's
  own `cordis.patch.yml` inserts. A profile that renames the row must rename the constant with it.
- **Dropped the unused `@deepseek-ai/dsh-launch-environment` import and peer dependency.** It was
  imported but never referenced.
- **`@deepseek-ai/schemastery` is now declared scoped**, matching the import. The manifest declared
  plain `schemastery` while the code imported `@deepseek-ai/schemastery`.
- **Peer ranges now pin `>=0.2.0-rc.2 <0.3.0-0`**, which is what the DSH 0.2 install gate reads;
  `engines.node` is `>=22.19`.
- **`exa_search` now reaches Exa directly, on demand, instead of going through the seam.** `ctx.web`
  selects exactly one provider per profile — never per call, and `searchProvider` is captured when
  the service is constructed — so a profile pinned to the first-party search (this deployment pins
  `deepseek-official`) answered every `exa_search` call from that provider. That is why the tool used
  to be described as "same index and provider as `web_search`", and why Exa was registered but never
  called. It now calls this plugin's own provider, applies the seam's truncation contract itself
  (`capToolResult`), and is how Exa gets chosen: `web_search` keeps the deployment's default provider,
  and the choice between the two is made by picking the tool. `/exa` keeps managing the Exa knobs
  (dynamic highlights, retrieval type, result count) — which until now had no effect on any search.
- **`apiKeyEnv` actually works.** It was declared and documented but never read: `resolveOptions` did
  not carry it out of the section, and nothing resolved it. The key is now resolved per search —
  literal `apiKey`, then the harness credential store under `apiKeyEnv`, then the launch-environment
  snapshot — so `EXA_API_KEY` no longer has to be pasted into a plain-text config file.
- **A missing key now fails loudly.** `search()` rejects with `no Exa API key: set \`apiKey\` on the
  qp-exa-dynamic entry, or provide EXA_API_KEY`, instead of quietly answering from whichever provider
  the seam had selected.
- **`@deepseek-ai/dsh-launch-environment` is a peer dependency again** — it is what reads the ambient
  environment, and it had been imported without ever being referenced.
- Tests: 44, up from 40.

## 0.1.0

Initial release.

- Exa-backed `WebSearchProvider` for the `ctx.web` seam, registering under the provider id `exa`.
- **Dynamic Highlights on by default.** The request sets `contents.highlights.dynamic = true` and
  carries the required `Exa-Beta: dynamic-highlights-2026-08-28` header; the two are driven by one
  flag so they cannot drift apart.
- `highlightsPerUrl` is never sent — measured against the live API, Exa ignores it (identical payloads
  for values 1 and 5). `highlightsMaxCharacters` is the working per-page cap when dynamic is off.
- `/exa` command: toggle highlights, set the retrieval type, set the source cap, or report status —
  all at runtime, persisted through the plugin's `qp-exa-dynamic` settings namespace.
- All eight Exa retrieval types (`auto`, `keyword`, `neural`, `instant`, `fast`, `deep-lite`, `deep`,
  `deep-reasoning`), each verified against the live API. The first-party provider's schema lists only
  three.
- `numResults` clamps one-directionally: it can pull `dsh-tool-web`'s per-request cap down, never up,
  because the seam truncates to the caller's cap. The provider records the observed ceiling so
  `/exa status` explains a clamped value instead of applying it silently.
- The provider registers before the optional settings and command wiring, which are best-effort: a
  duplicate settings namespace or a missing command registry degrades the plugin instead of taking
  the search path down.
- The `/exa` command declares `input`, which is what makes the Web composer route an argument to the
  handler at all. `dsh-client-ui-commands/lib/client.js:747` claims a parameterised line only when
  `desc.input !== undefined`; line 751 sends everything else to the model as an ordinary chat
  message. Dropping the field silently broke `/exa status`, `/exa type deep` and `/exa results 3`
  while leaving bare `/exa` working — a regression test now asserts it stays declared.
- The `/exa` argument parser treats brackets, angle brackets and quotes as transparent, so
  `/exa [on]`, `/exa <off>`, `/exa "status"`, `/exa type [deep]` and `/exa results [3]` all read the
  way they were meant. Submitting the hint template untouched is reported as such rather than guessed
  at, because each of its options is a different action.
- A second model-facing tool, `exa_search(query, maxResults?)`, whose ceiling is its own (1-50). The
  seam caps every search at the caller's `request.maxResults` and `dsh-tool-web` sends its own
  `searchMaxResults` on every call, so no provider can exceed that cap and raising it means forking an
  agent preset. This tool owns its own request cap, which turns the result count into a per-call model
  argument and makes the preset fork optional. It goes through `ctx.web` like `web_search`, so
  provider, search type and Dynamic Highlights are shared; a prompt section beside `web_search`'s
  says when to reach for it. `@deepseek-ai/dsh-tools` is a peer dependency, and must resolve to the
  runtime's own instance — a nested copy breaks the agent loop.
- 40 unit tests, no API key required.
