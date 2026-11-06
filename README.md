# dsh-web-search-custom

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A522-green.svg)](package.json)
[![Platform](https://img.shields.io/badge/platform/DeepSeek%20Harness-orange)](https://deepseek.com)

[English](README.md) | [简体中文](README.zh-CN.md)

Point the [DeepSeek Harness (dsh)](https://github.com/deepseek-ai/deepseek-harness)
`web` profile at **any JSON search API** — give it a URL and (optionally) an API
key, and it replaces the built-in DeepSeek search. It ships pointed at the
[AnySearch](https://www.anysearch.com/docs/api-endpoints) unified search API, and
the keyless path needs no account at all:

```text
POST https://api.anysearch.com/v1/search    # apiKey empty -> anonymous tier, no Authorization header
POST https://api.anysearch.com/v1/search    # apiKey set   -> Authorization: Bearer <key>, that key's quota
```

> [!IMPORTANT]
> **Design intent.** The plugin is a thin adapter, nothing more: it owns one
> search provider behind the `ctx.web` capability seam and one settings card.
> It ships no search engine, no index and no cache; the only credential it ever
> sends is the one you type into the card (or export as an environment variable),
> and an empty key means no auth header at all. Uninstall it and the stock
> provider is back with zero residue.

---

## Table of Contents

- [Why](#why)
- [Features](#features)
- [How it works](#how-it-works)
- [Requirements](#requirements)
- [Install](#install)
- [Configure in the settings page](#configure-in-the-settings-page)
- [Configuration reference](#configuration-reference)
- [Vertical and parameterized queries](#vertical-and-parameterized-queries)
- [Other configuration channels](#other-configuration-channels)
- [Uninstall](#uninstall)
- [Limits](#limits)
- [Development](#development)
- [License](#license)

## Why

dsh's web profile resolves search through the `ctx.web` seam. Out of the box
that seam is served by a hosted search backend, which is the wrong trade for
anyone who runs their own search stack (SearXNG, an internal search gateway, a
vendor API), wants queries to stay inside their own network, or wants to bring
their own search key.

This plugin registers one additional provider into that seam and lets you select
it. Everything else — the `web_search` tool, result capping, cancellation, error
propagation — keeps working unchanged, because it is the same seam the stock
provider uses.

## Features

- **Standard dsh bundle plugin.** Zero intrusion: no dsh source is modified;
  removing the plugin restores the stock search provider.
- **Zero runtime dependencies.** Only dsh-shipped packages are used
  (`@deepseek-ai/dsh-settings`, `@deepseek-ai/schemastery`, plus React on the
  browser side). Nothing is vendored or bundled.
- **AnySearch by default, keyless out of the box.** `api: auto` detects the
  AnySearch host and speaks its native POST envelope. Leave `apiKey` empty and the
  request carries **no** `Authorization` header (anonymous, per-IP rate-limited
  free tier); set a key and it is sent as `Authorization: Bearer <key>` against
  that key's quota. An invalid key becomes a clear error instead of a silent
  fallback to anonymous.
- **SearXNG and friends still work.** Switch `api` to `generic` for templated
  GET/POST endpoints; the shipped mapping matches SearXNG's `results[]` / `url` /
  `title` / `content` / `publishedDate` shape.
- **In-settings configuration card** (Settings → Plugins): profile, URL, API key,
  result cap, timeout and the whole field mapping are editable in the page, with
  the same overridden/reset affordances as first-party plugin cards.

## How it works

```text
web_search tool
      │
      ▼
ctx.web (capability seam)  ──selection──▶  provider id "custom"
      │                                          │
      │                                          ▼
      │                         fetch(your endpoint)  ──▶  your JSON API
      │                                          │
      └◀──── WebSearchResult { sources[], truncated } ◀──┘
```

The host side registers the namespace `web-search-custom` (so the settings page
can render a card for it) and registers a search provider with the stable id
`custom`. The provider's `search(query, signal)` reads the live settings value on
**every call**, picks a profile, performs the HTTP request with the caller's
cancellation signal plus its own timeout, and maps the JSON payload into
`sources[]` (deduplicated by URL, non-`http(s)` entries dropped, HTML stripped,
entities decoded).

| `api` | Request | Response mapping | Fields that apply |
| --- | --- | --- | --- |
| `anysearch` (auto-detected) | `POST` `{"query","max_results"}`; `Authorization: Bearer` **only when a key is set** | `data.results[].{title,url,snippet}`, falling back to `content` | `url`, `apiKey`, `headers`, `timeoutMs`, `maxResults` |
| `generic` | templated GET/POST (`{query}` URL-encoded, `{queryRaw}` verbatim, `{apiKey}`) | `resultsPath` + `urlField` / `titleField` / `snippetField` / `publishedField` | all of the above plus `method`, `body`, `authHeader`, `authScheme`, `resultsPath`, the four field names |

Both a non-2xx status and a non-zero business `code` fail the search. The vendor's
`message` and `request_id` are preserved in the error text; credentials that the
API returns inside a 402 body are redacted before the message can reach a log or
the model.

Provider selection follows the seam's own rules, resolved at call time:
a configured id wins; with no id configured, exactly one usable provider is
required. The plugin's own `cordis.patch.yml` therefore also sets
`web.searchProvider: custom` so the choice is explicit rather than accidental.

## Requirements

| Item | Value |
|---|---|
| DeepSeek Harness | `>=0.1.2-alpha.3 <0.1.8 \|\| >=0.1.5-alpha.1 <0.1.6 \|\| >=0.1.7-alpha.0 <0.1.8 \|\| >=0.2.0-alpha.0 <0.3.0 \|\| >=0.2.1-alpha.0 <0.3.0 \|\| >=0.2.2-alpha.0 <0.3.0` (verified on 0.1.2-alpha.4, 0.1.5-rc.1, 0.1.5-rc.2, 0.1.7-rc.1, 0.2.0-rc.1, 0.2.1-rc.2 and 0.2.2-rc.1) |
| Node.js | `^22.19.0 || >=24.0.0` |
| Runtime dependencies | **none** — the peers come from the dsh host install |
| Network | outbound access from the dsh host to the endpoint you configure (AnySearch resolves to its mainland-China gateway) |
| AnySearch API key | **optional** — the anonymous tier works without one |

The `dsh` range is declared under `dsh.engines.dsh` (and mirrored in
`peerDependencies` for the dsh packages the plugin relies on). The disjunction is
load-bearing rather than cosmetic: npm semver only satisfies a prerelease from a
range group that itself contains a prerelease with the same
`[major, minor, patch]` tuple, so a plain `<0.2.0` group does **not** cover
`0.1.5-rc.1` or `0.1.7-rc.1`. DSH itself checks the same peers at install and
startup preflight with `includePrerelease: true`; that gate is more permissive,
which is precisely why the pnpm-strict side needs its own counter-proof.
`tests/entry.test.mjs` pins this with a decision table, a counter-proof against
the old single range, and `tests/host-integration.test.mjs` runs the host's real
`evaluatePluginCompatibility` and real `semver` against it.

> [!IMPORTANT]
> **dsh 0.1.7 moved the settings model.** The plugin was adapted for
> `0.1.7-rc.1`: `settings.installSection()` is gone (an exported `Config` schema
> *is* the namespace now, and its fields must be `.volatile()` to be editable
> live), the browser-side `settingsScope` service was replaced by
> `configForms`, and the card moved from the removed `settings.plugin.item` slot
> to `plugins.item` on the Plugins page. The card renders through the shared
> official form primitives, so it looks and behaves like the built-in provider
> cards. Details: [docs/DSH-0.1.7-ADAPTATION.md](docs/DSH-0.1.7-ADAPTATION.md).

## Install

```bash
dsh plugin --profile web add dsh-web-search-custom
```

Restart the dsh web instance afterwards. From a local checkout, pass the
directory path instead of the package name.

## Configure in the settings page

Open **Settings → Plugins** in the web UI and click into the
"Custom search (web-search-custom)" row — its page shows the form:

- the API profile (`auto` / `anysearch` / `generic`),
- the search URL (AnySearch by default),
- the API key — **leave it empty for the keyless tier**,
- the result cap (`maxResults`, 1–10 on AnySearch),
- request method, POST body template, extra headers (JSON), timeout,
- the result field mapping (`resultsPath` / `urlField` / `titleField` /
  `snippetField` / `publishedField`; generic profile only).

Saving writes the `web-search-custom:` entry of your profile patch document
(`$DSH_HOME/profiles/web/cordis.patch.yml`) and takes effect immediately — the
next search uses the new value, no restart. The form, its overridden/reset badges
and its read-only notice are the same shared components the first-party provider
cards use.

If an older release pinned a different URL there, clear that field (Reset → Save)
so the shipped AnySearch default applies again.

## Configuration reference

| Field | Default | Description |
| --- | --- | --- |
| `api` | `auto` | Profile: `auto` (decided by the URL host), `anysearch` (AnySearch POST API), `generic` (any templated JSON endpoint) |
| `url` | `https://api.anysearch.com/v1/search` | Search endpoint. The AnySearch profile POSTs here; the generic profile supports `{query}` (URL-encoded), `{queryRaw}` (verbatim) and `{apiKey}` placeholders and appends `q=` for GET without a `{query}` |
| `apiKey` | empty | Optional. Empty in the AnySearch profile sends **no** `Authorization` header (anonymous free tier); set it to send `Authorization: Bearer <key>`. In the generic profile the header name/scheme fields apply, and a `{apiKey}` in the URL or body suppresses the extra header |
| `maxResults` | `10` | AnySearch profile only: sent as `max_results`, computed as `min(this, caller limit)` and clamped to 1–10 |
| `method` | `GET` | Generic profile only: `GET` or `POST`; anything else degrades to `GET` |
| `body` | `{"query":"{query}"}` | Generic profile only: POST body template, supports `{query}` / `{queryRaw}` / `{apiKey}` |
| `headers` | `{}` | Extra request headers as a JSON string |
| `authHeader` | `Authorization` | Generic profile only: header name used for the API key |
| `authScheme` | `Bearer` | Generic profile only: auth scheme; leave empty to send the bare key |
| `timeoutMs` | `30000` | Per-request timeout |
| `resultsPath` | `results` | Generic profile only: dotted path to the result array, e.g. `data.results` |
| `urlField` / `titleField` / `snippetField` / `publishedField` | `url` / `title` / `content` / `publishedDate` | Generic profile only: result field-name mapping (SearXNG's defaults) |

In the generic profile each field also falls back to a wider list of common
aliases at mapping time (for example a missing `titleField` value still tries
`title` then `name`). The AnySearch profile always reads
`data.results[].title` / `.url` / `.snippet` and falls back to `.content`.

## Vertical and parameterized queries

The AnySearch profile sends a plain general-web query. For vertical search
(`tag` / `params` / `zone` / `language` — see the
[API docs](https://www.anysearch.com/docs/api-endpoints/v1-search)) switch to the
generic profile and write the body yourself; the response envelope stays the same,
so only the field mapping changes:

```yaml
- id: web-search-custom
  config:
    api: generic
    url: 'https://api.anysearch.com/v1/search'
    method: POST
    body: '{"query":"{queryRaw}","tag":"code.doc","params":{"library":"golang"},"max_results":5}'
    resultsPath: data.results
    urlField: url
    titleField: title
    snippetField: snippet
    publishedField: ''
```

## Other configuration channels

### Profile patch layer (settings document alternative)

```yaml
- id: web-search-custom
  config:
    api: auto
    url: 'https://api.anysearch.com/v1/search'
    apiKey: ''
    maxResults: 10
    method: GET
    body: '{"query":"{query}"}'
    headers: '{}'
    authHeader: Authorization
    authScheme: Bearer
    timeoutMs: 30000
    resultsPath: results
    urlField: url
    titleField: title
    snippetField: content
    publishedField: publishedDate
```

> Note: a patch replaces the whole `config` block — write every key when overriding.

### Environment variables

Environment overrides win over the settings page and require no file edit:

| Variable | Description |
| --- | --- |
| `WEB_SEARCH_CUSTOM_API` | Override the profile (`auto` / `anysearch` / `generic`) |
| `WEB_SEARCH_CUSTOM_URL` | Override the search URL |
| `WEB_SEARCH_CUSTOM_API_KEY` | Override the API key (recommended for secrets); empty keeps the keyless tier |
| `WEB_SEARCH_CUSTOM_MAX_RESULTS` | Override the AnySearch result cap |
| `WEB_SEARCH_CUSTOM_HEADERS` | Extra headers, JSON string |
| `WEB_SEARCH_CUSTOM_TIMEOUT_MS` | Timeout in milliseconds |

## Uninstall

```bash
dsh plugin --profile web remove dsh-web-search-custom
```

Restart dsh and the stock search provider takes over again.

## Limits

- The API key is stored as an ordinary settings field, not in a credential
  store. For sensitive deployments prefer `WEB_SEARCH_CUSTOM_API_KEY`.
- AnySearch caps a single request at 10 results (`max_results` 1–10); the tool
  layer truncates further to the caller's `maxResults`.
- AnySearch's anonymous tier is rate-limited per client IP and metered against a
  daily free quota. When it runs out the API answers 402 and may return
  auto-generated credentials; the plugin surfaces that as an error and redacts
  those credentials instead of storing them. Add a key to keep searching.
- Result mapping is field-based, not query-language aware: the generic profile
  needs the field mapping (and, if necessary, `resultsPath`) adjusted for exotic
  payload shapes.

## Development

```bash
pnpm install         # dev dependencies (@deepseek-ai/dsh + dsh-settings + dsh-client-ui-primitives
                     # 0.2.2-rc.1, schemastery 3.19.0 — the host-contract test loads the real packages)
pnpm test            # node --test tests/*.test.mjs && node tests/client-smoke.mjs
pnpm run test:host   # host-contract subset, on its own
```

`pnpm` is required for the dev install: the `dsh` devDependency pulls native
subprocess helpers whose build scripts must be explicitly declined (see
`allowBuilds` in `pnpm-workspace.yaml`) — nothing here needs a native build.

| Test | What it proves |
|---|---|
| `tests/entry.test.mjs` | Real entry load (`import('../src/index.js')`), manifest declarations, the 0.1.7 settings-namespace source (`Config` exported, every field `.volatile()`, `{get()}` live references, `configure({ auto: false })`), the engines decision table (hand-rolled comparator + counter-proof + cross-check against the host's real `semver.satisfies`), four-way key parity (host schema ↔ client fields ↔ client views ↔ patch config), locale key parity, static guards against the removed client APIs, dependency hygiene |
| `tests/anysearch.test.mjs` | AnySearch profile: auto-detection, keyless vs Bearer headers, `max_results` arithmetic, vendor envelope mapping, the error envelope (`message` + `request_id` + 402 credential redaction), and generic-profile non-regression |
| `tests/host-integration.test.mjs` | Driven by the real host packages: real Cordis + WebRuntime + the real `@deepseek-ai/cosmokit` volatile protocol (a `_commitVolatile`-style update is visible to the next search), the real `dsh-settings` schema helpers (`volatileForm` / `isVolatilePath` / `projectForm` / `plainConfig`), real source-level assertions on the client bundles this card depends on, and the host's real `evaluatePluginCompatibility` + `semver` against the declared ranges |
| `tests/client-smoke.mjs` | Browser half: bundle id, short service names, locale parity, `configForms.whileServed` gating, the `plugins.item` registration contract (id/order/label thunk), both views (`summary` one-liner vs `page` form), save/reset write path, invalid-input blocking, read-only disabling and the read-only write refusal |
| `tests/live-search.mjs` | Opt-in live check against a real endpoint: `DSH_WSC_LIVE_URL='https://api.anysearch.com/v1/search' node tests/live-search.mjs` (add `DSH_WSC_LIVE_BAD_KEY=1` to also assert the invalid-key error path) |

### Live checks (opt-in, they hit the network)

```bash
# end-to-end through the real seam against a live endpoint
DSH_WSC_LIVE_URL='https://api.anysearch.com/v1/search' node tests/live-search.mjs 'your query'
# the same, plus the invalid-key error path
DSH_WSC_LIVE_URL='https://api.anysearch.com/v1/search' DSH_WSC_LIVE_BAD_KEY=1 node tests/live-search.mjs 'your query'
# two-arm control: prove the user-layer url is what decides, and that the new default returns results
DSH_WSC_LIVE_PARITY=1 node tests/live-settings-parity.mjs
```

The default `pnpm test` suite stays offline-runnable; these scripts print `SKIP` unless the
environment variable above is set.

```text
src/index.js          host half — settings namespace, profile dispatch, result mapping
lib/client.js         browser half — settings card (hand-written bundle, no build step;
                      renders through the shared official form primitives)
cordis.patch.yml      bundle patch: select provider "custom" and mount the plugin
tests/                entry + anysearch + host-contract + client-smoke + opt-in live check
```

## dsh 0.2.2-rc.1 adaptation notes

Verified against the desktop install at `D:\DeepSeek Harness\`
(`resources/app.asar/dsh/package.json` = `0.2.2-rc.1`) by unpacking the asar source and
running the host's own gate function against the real manifest.

- **No contract drift**: `dsh-web`'s `registerSearchProvider` (`lib/index.js:69`) and its
  selection semantics, the `.volatile()` fields of `WebRuntime.Config` (`:48-51`),
  dsh-settings' `configure(presentation, owner)` (`:370`), and the client-side
  `slots.inject` / `configForms.whileServed` / `locale.register` all keep their shape.
  **`src/` and `lib/client.js` were not touched.**
- **This round again fixes pnpm install-time strictness, not the loading gate**: the old
  five-clause range already returns `undefined` (PASS) from
  `evaluatePluginCompatibility(pkg, {}, '0.2.2-rc.1')`; strict mode is what rejects it.
  The real negative `0.3.0` is REJECTed and the result names both peers, which proves the
  gate really judges instead of always passing.
- **schemastery had to become a disjunction**: the 0.2.2 host ships `3.19.0` and
  `dsh-settings@0.2.2-rc.1` requires `~3.19.0`, while the old `~3.18.4` range made pnpm
  install a 3.18.4 copy as the test fixture. The peer is now `~3.18.4 || ~3.19.0`, with
  `3.19.0` pinned explicitly in devDependencies.
- **The version stays at this repo's own 0.3.0** — it does not track the host release
  number (same decision as the 0.2.0 and 0.2.1 rounds).
- Verification: `node --test tests/*.test.mjs` **56 pass / 0 fail / 0 skipped** (baseline 55
  plus one new counter-proof) and 24 client-smoke checks; `pnpm peers check` is clean.
  Details: [docs/DSH-0.2.2-ADAPTATION.md](docs/DSH-0.2.2-ADAPTATION.md).

## dsh 0.2.1-rc.2 adaptation notes

Verified against the desktop install at `D:\DeepSeek Harness\` (`FileVersion 0.2.1-rc.2`)
by unpacking the asar source and running the host's own gate function.

- **No contract drift**: `dsh-web`'s `registerSearchProvider` and its selection semantics,
  dsh-settings' `configure()`/`volatileForm`, and the client-side
  `configForms.whileServed` / `slots.inject` all keep their shape in 0.2.1 (the official
  `dsh-client-ui-settings-web-search` still requires
  `@deepseek-ai/dsh-client-ui-primitives`). **`src/` and `lib/client.js` were not touched.**
- **That round fixed pnpm install-time strictness, not the loading gate**: the old
  four-clause range already returned `undefined` (PASS) from
  `evaluatePluginCompatibility(pkg, {}, '0.2.1-rc.2')`, so the plugin could already load;
  strict mode was the side that rejected it. A real negative
  (`>=0.1.7-alpha.0 <0.1.8`) is REJECTed, proving the gate really judges.
- **`WebRuntime.Config`'s two fields are `.volatile()`**: reading `searchProvider.get()`
  on a raw value throws `TypeError`. The test harness now wraps them through
  `cosmo.createVolatile()` (fixture drift, not a plugin defect).
- **`evaluatePluginCompatibility` renamed its result field**: `peers` → `requirements`
  (it was `peers` in 0.2.0); the assertions accept either shape.
- **The gate's semantics changed in 0.2.1**: a top-level `engines.dsh` decides alone and
  the peers are ignored. This repo declares the **nested** `dsh.engines.dsh`, so peers
  still decide (confirmed by running the real gate).
- **The version stays at this repo's own 0.3.0** (see the `v0.2.0-rc.1` round for the
  rationale).
- Verification: `node --test tests/*.test.mjs` **55 pass / 0 fail / 0 skipped** plus 24
  client-smoke checks; the former silent skip ("primitives unresolvable → SKIP") is gone
  because `dsh-client-ui-primitives@0.2.1-rc.2` is an explicit devDependency.

## dsh 0.2.0-rc.1 adaptation notes

Verified against the desktop install at `D:\DeepSeek Harness\` (`FileVersion 0.2.0-rc.1`)
by unpacking the asar source and running the real gate against it. Key points:

- **The only mandatory change was the compatibility range**: the old range was rejected by
  the startup gate under 0.2.0-rc.1 (`dsh: skipping profile bundle ...`), so the whole
  bundle never loaded (both web and desktop stopped working). Adding
  `|| >=0.2.0-alpha.0 <0.3.0` let it through.
- **The gate reads only `peerDependencies`**: the check (`evaluatePluginCompatibility` in
  `dsh-app-boot`) walks only `@deepseek-ai/dsh*` entries under `peerDependencies` and
  **never reads `dsh.engines.dsh`** (zero consumers across the tree). The two must be
  character-for-character identical, and the tests guard that.
- **Two semver modes**: the host gate uses `includePrerelease: true`, which bypasses the
  prerelease-visibility rule, so prereleases of the upper bound itself are let through
  (`<0.1.8` admits `0.1.8-rc.1`, `<0.3.0` admits `0.3.0-alpha.0`); strict mode (pnpm at
  install time) rejects them. The upper bound therefore blocks **releases**, not
  prereleases — to reject those too, write it as `<0.3.0-0`.
- **Evidence and details**: the full source comparison, change list, test results and the
  honest gaps are in [docs/DSH-0.2.0-ADAPTATION.md](docs/DSH-0.2.0-ADAPTATION.md).

## License

[MIT](LICENSE)