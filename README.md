# qp-exa-dynamic

English | [简体中文](README.zh.md)

[![npm](https://img.shields.io/npm/v/qp-exa-dynamic)](https://www.npmjs.com/package/qp-exa-dynamic)

An [Exa](https://exa.ai)-backed `WebSearchProvider` for the
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) `ctx.web` seam, with Exa
**Dynamic Highlights** on by default, an `/exa` command that changes highlights, search type and
result count at runtime, and an `exa_search` tool that reaches Exa **on demand** — without changing
the provider the rest of the profile searches with.

```sh
dsh plugin --profile web add qp-exa-dynamic
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
dsh plugin --profile web add qp-exa-dynamic
```

The package declares a `dsh.bundle` manifest, so its bundle patch inserts the provider row for you —
no hand-written patch entry is needed.

**Optional.** The `exa_search` tool reaches Exa on demand without any of this; do it only to make Exa
the provider `web_search` itself uses. Override the `web` row in
`$DSH_HOME/profiles/web/cordis.patch.yml`:

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
- id: qp-exa-dynamic
  name: qp-exa-dynamic
  config:
    apiKey: 'your-exa-api-key'
```

or through the environment. `apiKey` is declared `role('secret')`, so it never appears in a
`describe()` response — but a plain-text config file is still a plain-text config file; prefer the
environment when you can.

> **Where the key is read from, in order:** a literal `apiKey` in config, then the harness
> **credential store** under `apiKeyEnv` (add `EXA_API_KEY` there, via the credential card in the GUI
> or `$DSH_HOME/.credentials.yaml`), then the launch-environment snapshot, which is documented to
> consult the inherited environment, the invoking directory's `.env` and the Harness home's `.env`.
>
> The credential store is consulted first because the snapshot is documented to come back without the
> variable on some Windows installs — which is the deployment this was written against. If a
> globally-selected `exa` reports `registered but unavailable`, check the credential store before
> falling back to a literal `apiKey` in a plain-text config file.

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

The command declares `input.hint` (`on|off|status|type deep|results 3`), which is what makes the Web
composer route an argument to the handler at all rather than sending the line to the model as an
ordinary chat message. Brackets and quotes are treated as transparent, so the hint template is still
editable in place. `/exa status` lists the retrieval types too, so "which types were there again"
never costs a second command, and a mistyped argument replies with copy-pasteable examples.

Writes go through the settings service under the Loader **entry id** `qp-exa-dynamic`, so they land in
the profile patch's user layer and survive a restart. Clearing that section returns the plugin to its
configured defaults. Every field the command writes is marked `.volatile()` in the schema, which is
what both the write path and the auto-generated configuration card require.

Measured on one provider instance, one query: switching Dynamic Highlights off took the same search
from 12,716 to 57,958 highlight characters — a 4.6x difference, applied on the next search.

## The `exa_search` tool

The plugin also registers a second, model-facing tool beside `web_search`:

```
exa_search(query: string, maxResults?: integer)   // maxResults 1-50
```

It exists so Exa is reachable **on demand** without changing what the rest of the profile searches
with. The seam selects exactly one provider per profile — never per call, and `searchProvider` is
captured when the service is constructed — so a profile that pins the first-party search can only
reach Exa through a tool that bypasses that selection. This one calls the plugin's own provider
**directly** rather than `ctx.web.search`.

That is the whole routing story:

| Tool | Path | Provider |
| --- | --- | --- |
| `web_search` | `ctx.web` | whatever the profile pins (unaffected) |
| `exa_search` | direct | Exa |

Pick the tool to pick the provider. No global setting changes, no restart, and `web_search` keeps
answering from the default provider while Exa stays one call away.

Going direct also lets the tool own its `request.maxResults`. `dsh-tool-web` sends its own
`searchMaxResults` on every seam call, so no provider reached through the seam can exceed it, and
raising it means forking an agent preset. This tool owns its bound, so the result count becomes a
**per-call model argument**:

| Want | Use | Needs the preset fork? |
| --- | --- | --- |
| 20 sources for one question | `exa_search(query, maxResults: 20)` — just ask in words | no |
| `/exa results 20` to apply | the `/exa` command | yes |

Because it no longer travels through the seam, the tool applies the seam's truncation contract itself
(`capToolResult`): if Exa over-returns a bounded request, `sources` is cut and `truncated` is set. Its
ceiling of 50 is its own — dynamic highlights measured ~1.6k characters per source, so 50 is already
~20k tokens of context.

**A missing key fails loudly.** With no Exa key the tool rejects with `no Exa API key: …` instead of
silently answering from the deployment's default provider.

A prompt section next to `web_search`'s tells the model when to reach for it; ordinary lookups stay
on `web_search`. If the composition has no `tools` registry the provider still mounts and only the
tool is absent.

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
value is explained rather than silently applied.

**Raising the ceiling is not a profile-patch edit in the Web app.** `dsh-web-app` disables the host
`tool-web` row — `- id: tool-web` / `disabled: true` — because only the `web` service and its search
provider are host-side; the model-facing tool is per session, and the one that actually runs comes
from the **agent preset**. The shipped `standard` preset's row carries `fetch` and `searchTimeoutMs`
and no `searchMaxResults`, so it takes the schema default of 8. A profile patch targeting `tool-web`
lands on the disabled host row and does nothing at all.

Changing it therefore means forking the preset: copy `standard` into `$DSH_HOME/.agent-presets/`, add
`searchMaxResults` to its `tool-web` row, and select it as the default. That is a real trade — a copy
does not track upstream updates to the shipped preset, and the default is read when a session is
created, so running sessions keep the preset they assembled with. For most uses leaving it at 8 is
the better deal: `/exa results` still pulls the count *down*, which is the direction that saves
tokens.

## Known limitations

- **Exa's beta surface can move.** `dynamic-highlights-2026-08-28` is a research preview; a change on
  Exa's side means updating `DYNAMIC_BETA_VALUE`.
- **Results without highlights are dropped**, matching the seam's rule. With dynamic highlights on,
  8 of 8 results carried a highlight in testing, so it rarely fires.
- **No `category`, domain or date filters, and no full text.** Those are Exa features this provider
  does not expose yet.
- **One of this and the first-party Exa provider per profile.** Both register the provider id `exa`
  by default; running both needs a distinct `providerId` on one of them.
- **`exa_search` needs an Exa key; `web_search` does not.** The tool goes straight to Exa, so with no
  key it fails loudly instead of falling back — that is what makes the choice real. `web_search` is
  unaffected either way.
- **Tested against dsh `0.2.0-rc.2`**, which is what the peer ranges pin (`>=0.2.0-rc.2 <0.3.0-0`).
- **Without a settings service the `/exa` writes are in-memory only.** The provider itself works
  either way; without a command registry there is simply no `/exa`. A settings service that refuses
  the write — no such entry id, no volatile field, a read-only profile — is reported as
  `could not save: …` rather than silently swallowed.

## Development

```sh
node test/index.test.js    # 44 unit tests, no API key needed
EXA_API_KEY=... node test/live.mjs   # hits the real API, spends credit
```

Run the test file directly rather than through `node --test`: the test runner spawns a child process
per file with piped stdio, which fails with `spawn EPERM` in a restricted sandbox.

### Installing from a checkout

`dsh plugin --profile web add <path>` records a `link:` dependency, and the profile links the package
by name. Node resolves a linked module's own imports from its **real** path, not from the link inside
the profile — so a checkout that lives outside `$DSH_HOME/profiles/` has no `node_modules` ancestor
able to reach the harness's packages, and every `@deepseek-ai/dsh-*` import fails with
`ERR_MODULE_NOT_FOUND`. The plugin mounts, then throws on its first import.

Give the checkout a `node_modules` that points at the **same** instances the runtime uses:

```powershell
$plugin = "<path to this checkout>"
$hoist  = "$env:USERPROFILE\.dsh\profiles\node_modules\@deepseek-ai"
New-Item -ItemType Directory -Force "$plugin\node_modules\@deepseek-ai" | Out-Null
foreach ($pkg in @("dsh-web", "dsh-tools", "dsh-launch-environment", "schemastery")) {
  cmd /c mklink /J "$plugin\node_modules\@deepseek-ai\$pkg" "$hoist\$pkg"
}
```

Junctions rather than a second `pnpm install`, deliberately: `@deepseek-ai/dsh-tools` is a runtime
singleton, and a nested copy of it breaks the agent loop before the provider is ever called. Pointing
every link at the hoist directory guarantees one physical instance for each package.

## Uninstall

```sh
dsh plugin --profile web remove qp-exa-dynamic
```

Remove the `web` override from `cordis.patch.yml` to return to the built-in DeepSeek search. That
edit is hot-reloaded, so it takes effect immediately.

## License

MIT
