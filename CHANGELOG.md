# Changelog

## 0.1.0

Initial release.

- Exa-backed `WebSearchProvider` for the `ctx.web` seam, registering under the provider id `exa`.
- **Dynamic Highlights on by default.** The request sets `contents.highlights.dynamic = true` and
  carries the required `Exa-Beta: dynamic-highlights-2026-08-28` header; the two are driven by one
  flag so they cannot drift apart.
- `highlightsPerUrl` is never sent — measured against the live API, Exa ignores it (identical payloads
  for values 1 and 5). `highlightsMaxCharacters` is the working per-page cap when dynamic is off.
- `/exa` command: toggle highlights, set the retrieval type, set the source cap, or report status —
  all at runtime, persisted through the plugin's `web-search-exa-dynamic` settings namespace.
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
