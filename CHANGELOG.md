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
- 34 unit tests, no API key required.
- The `/exa` argument parser treats the command hint template's punctuation as transparent, so
  `/exa [on]`, `/exa <off>`, `/exa "status"`, `/exa type [deep]` and `/exa results [3]` all read the
  way they were meant. The composer inserts `input.hint` as an editable template, and a submitted
  `/exa [on]` was being rejected as an unknown argument. Submitting the template untouched is
  reported as such rather than guessed at, because each of its options is a different action.
