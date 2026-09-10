# dsh-web-search-exa-dynamic

English | [简体中文](README.zh.md)

An [Exa](https://exa.ai)-backed `WebSearchProvider` for the
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) `ctx.web` seam, with Exa
**Dynamic Highlights** on by default and an `/exa` command that changes highlights, search type and
result count at runtime.

```sh
dsh plugin --profile web add dsh-web-search-exa-dynamic
```

## Why this exists

The first-party `@deepseek-ai/dsh-web-search-exa` cannot reach Exa Dynamic Highlights, for two
independent reasons:

1. **Its request body is hardcoded.** It sends `contents.highlights.highlightsPerUrl`, and no config
   field it accepts reaches a `dynamic` field.
2. **Dynamic Highlights is a beta API and needs a header.** Every request that sets `dynamic: true`
   must also send `Exa-Beta: dynamic-highlights-2026-08-28`. That provider's headers are
   `authorization`, `content-type`, `accept` and `user-agent` — no `Exa-Beta`. Without it Exa answers
   HTTP 400:

   ```json
   {"error":"'highlights.dynamic' is in beta. Send the 'Exa-Beta: dynamic-highlights-2026-08-28' request header to use it.","tag":"INVALID_REQUEST"}
   ```

This provider sends both, and drops `highlightsPerUrl` entirely — measured against the live API, Exa
ignores that parameter, returning byte-identical payloads for values 1 and 5. It uses
`maxCharacters` instead, which is the knob that actually works when Dynamic Highlights are off.

## Measured

Real `/search` calls, one query, 8 results:

| Configuration | Highlight characters |
| --- | --- |
| First-party provider's default (no working knob) | 51,152 |
| This provider, `dynamicHighlights: false` + `highlightsMaxCharacters: 1500` | 10,973 |
| This provider, `dynamicHighlights: true` (default) | 12,716 |

Dynamic Highlights is not a uniform truncation: it concatenates the retrieved documents into one
input, runs a single forward pass, and allocates a shared budget across the result set — so useful
pages keep more context and redundant ones get less.

## Install

```sh
dsh plugin --profile web add dsh-web-search-exa-dynamic
```

The package declares a `dsh.bundle` manifest, so its bundle patch inserts the provider row for you —
no hand-written patch entry is needed.

To select it, override the `web` row in `$DSH_HOME/profiles/web/cordis.patch.yml`:

```yaml
- id: web
  name: '@deepseek-ai/dsh-web'
  config:
    searchProvider: exa
    fetchProvider: http
```

> A patch **replaces** the targeted row's whole `config` rather than merging into it, so
> `fetchProvider: http` must be restated or the fetch provider is dropped.

Then give it a key, either as plugin config:

```yaml
- id: web-search-exa-dynamic
  name: dsh-web-search-exa-dynamic
  config:
    apiKey: 'your-exa-api-key'
```

or through the environment. `apiKey` is declared `role('secret')`, so it never appears in a
`describe()` response — but a plain-text config file is still a plain-text config file; prefer the
environment when you can.

> **On `$DSH_HOME/.env`.** The plugin reads `apiKeyEnv` (default `EXA_API_KEY`) through the harness's
> launch-environment snapshot, which is documented to consult the inherited environment, the invoking
> directory's `.env` and the Harness home's `.env`. That worked in some deployments and not in
> others — on one Windows install the snapshot came back without the variable even though the file
> was correct, and the config `apiKey` above was the fix. If your provider reports
> `registered but unavailable`, the key is not reaching it; set `apiKey` directly.

Restart `dsh web` after changing the environment. `cordis.patch.yml` itself is hot-reloaded, so
config edits apply without a restart.

## Configuration

Every field has a safe default; you normally only supply a key.

| Field | Default | Meaning |
| --- | --- | --- |
| `providerId` | `exa` | Registry id. Change it only to coexist with another Exa provider. |
| `apiKey` | unset | Literal key; falls back to `apiKeyEnv`. |
| `apiKeyEnv` | `EXA_API_KEY` | Environment variable consulted when `apiKey` is unset. |
| `baseURL` | `https://api.exa.ai` | Exa endpoint; `/search` is appended. |
| `searchType` | `auto` | Retrieval type — see below. Runtime-settable with `/exa type`. |
| `numResults` | `8` | Source cap. Runtime-settable with `/exa results`. |
| `dynamicHighlights` | `true` | On by default; adds the required `Exa-Beta` header. Runtime-settable with `/exa`. |
| `highlightsMaxCharacters` | unset | Per-page highlight cap, used **only** when `dynamicHighlights` is false. |

`dynamicHighlights` is never combined with `highlightsMaxCharacters`: Exa sizes and distributes the
shared budget itself when dynamic is on, and its docs warn against combining the two.

## The `/exa` command

Typed in the composer. It runs directly against the interface and creates no model message.

| Command | Effect |
| --- | --- |
| `/exa` | Toggle Dynamic Highlights |
| `/exa on` / `/exa off` | Set them explicitly |
| `/exa type` | List the retrieval types |
| `/exa type deep` | Set the retrieval type |
| `/exa results` | Report the source cap |
| `/exa results 3` | Set the source cap |
| `/exa status` | Report every knob, the available types, and the real ceiling |

Plain words, no punctuation: the command declares **no argument hint**, so the composer inserts no
template to edit around. `/exa status` lists the retrieval types too, so "which types were there
again" never costs a second command, and a mistyped argument replies with copy-pasteable examples.

Writes land in the `web-search-exa-dynamic` settings namespace's user layer, so they survive a
restart. Clearing that section returns the plugin to its configured defaults.

Measured on one provider instance, one query: switching Dynamic Highlights off took the same search
from 12,716 to 57,958 highlight characters — a 4.6x difference, applied on the next search.

## Retrieval types

Exa's `type` is the latency/quality dial. All eight were verified against the live API; measured
latency for one query, 8 results:

| Type | Measured | Use |
| --- | --- | --- |
| `keyword` | 464 ms | Keyword only, fastest |
| `neural` | 737 ms | Semantic retrieval |
| `fast` | 798 ms | Speed with minimal quality loss |
| `instant` | 856 ms | Real-time (chat, voice) |
| `auto` | 1,914 ms | **Default** |
| `deep-lite` | 3,116 ms | Lightweight synthesized output |
| `deep` | 5,282 ms | Multi-step reasoning |
| `deep-reasoning` | 18,278 ms | Hardest research tasks |

The first-party provider's schema lists only `auto`, `keyword` and `neural` — that set is stale.
This provider exposes all eight.

### The `deep*` types are discounted by this seam

Measured through this provider's own class, same query, dynamic highlights on:

| Type | Time | Sources returned |
| --- | --- | --- |
| `fast` | 718 ms | 8 |
| `auto` | 215 ms | 8 |
| `deep` | 6,891 ms | 3 |
| `deep-reasoning` | 14,776 ms | 4 |

The raw API returns 8 results for `deep`; the rest carry no non-blank highlight and are dropped,
because the seam has no other field to derive a snippet from and inventing one would make the seam
lie. The `deep*` family's real product is the synthesized `output`, which `WebSearchSource` has no
field for. In practice the useful range here is `keyword`, `neural`, `fast`, `instant` and `auto`.

## Result count belongs to `dsh-tool-web`

Worth stating plainly, because it is easy to misread:

- The model-facing `web_search` tool takes only `queries` — the model cannot ask for a count.
- The ceiling belongs to `dsh-tool-web`: `searchMaxResults`, default 8. Its own comment:
  *"The consumer owns the returned-context limit; providers and models do not."*
- The tool sends `maxResults` on **every** call, and the seam truncates the returned sources to it —
  so no provider can exceed that ceiling.

That makes this plugin's `numResults` one-directional: it can pull the count down, never up.

| Configured | Tool ceiling | Sent to Exa |
| --- | --- | --- |
| 3 | 8 | 3 |
| 12 | 8 | 8 (clamped) |
| 20 | 8 | 8 (clamped) |

`/exa status` and `/exa results` report the ceiling the provider actually observed, so a clamped
value is explained rather than silently applied. To raise the ceiling itself, set `searchMaxResults`
on the `tool-web` row once:

```yaml
- id: tool-web
  name: '@deepseek-ai/dsh-tool-web'
  config:
    searchMaxResults: 20
```

Raise it once and everything above stays a runtime `/exa results` decision. Note this raises the cap
for whichever provider is active, so it also affects the DeepSeek provider if you switch back.

## Known limitations

- **Exa's beta surface can move.** `dynamic-highlights-2026-08-28` is a research preview; a change on
  Exa's side means updating `DYNAMIC_BETA_VALUE`.
- **Results without highlights are dropped**, matching the seam's rule. With dynamic highlights on,
  8 of 8 results carried a highlight in testing, so it rarely fires.
- **No `category`, domain or date filters, and no full text.** Those are Exa features this provider
  does not expose yet.
- **One of this and the first-party Exa provider per profile.** Both register the provider id `exa`
  by default; running both needs a distinct `providerId` on one of them.
- **Tested against dsh `0.1.5-rc.1` only**, which is what the peer ranges pin.
- **Without a settings service the `/exa` writes are in-memory only.** The provider itself works
  either way; without a command registry there is simply no `/exa`.

## Development

```sh
node test/index.test.js    # 34 unit tests, no API key needed
EXA_API_KEY=... node test/live.mjs   # hits the real API, spends credit
```

Run the test file directly rather than through `node --test`: the test runner spawns a child process
per file with piped stdio, which fails with `spawn EPERM` in a restricted sandbox.

## Uninstall

```sh
dsh plugin --profile web remove dsh-web-search-exa-dynamic
```

Remove the `web` override from `cordis.patch.yml` to return to the built-in DeepSeek search. That
edit is hot-reloaded, so it takes effect immediately.

## License

MIT
