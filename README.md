# dsh-web-search-custom

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A522-green.svg)](package.json)
[![Platform](https://img.shields.io/badge/platform/DeepSeek%20Harness-orange)](https://deepseek.com)

[English](README.md) | [简体中文](README.zh-CN.md)

Point the [DeepSeek Harness (dsh)](https://github.com/deepseek-ai/deepseek-harness)
`web` profile at **any JSON search API** — give it a URL and (optionally) an API
key, and it replaces the built-in DeepSeek search. The shipped default already
works against a self-hosted SearXNG:

```text
http://127.0.0.1:8080/search?format=json&q={query}
```

> [!IMPORTANT]
> **Design intent.** The plugin is a thin adapter, nothing more: it owns one
> search provider behind the `ctx.web` capability seam and one settings card.
> It ships no search engine, no index, no cache, and no bundled credentials; it
> talks only to the endpoint you configure. Uninstall it and the stock provider
> is back with zero residue.

---

## Table of Contents

- [Why](#why)
- [Features](#features)
- [How it works](#how-it-works)
- [Requirements](#requirements)
- [Install](#install)
- [Configure in the settings page](#configure-in-the-settings-page)
- [Configuration reference](#configuration-reference)
- [Other configuration channels](#other-configuration-channels)
- [Uninstall](#uninstall)
- [Limits](#limits)
- [Development](#development)
- [License](#license)

## Why

dsh's web profile resolves search through the `ctx.web` seam. Out of the box
that seam is served by a hosted search backend, which is the wrong trade for
anyone who already runs their own search stack (SearXNG, an internal search
gateway, a vendor API) or who wants queries to stay inside their own network.

This plugin registers one additional provider into that seam and lets you select
it. Everything else — the `web_search` tool, result capping, cancellation, error
propagation — keeps working unchanged, because it is the same seam the stock
provider uses.

## Features

- **Standard dsh bundle plugin.** Zero intrusion: no dsh source is modified;
  removing the plugin restores the stock search provider.
- **Zero runtime dependencies.** Only dsh-shipped packages are used
  (`@deepseek-ai/dsh-settings`, `@deepseek-ai/schemastery`, plus React on the browser
  side). Nothing is vendored or bundled.
- **In-settings configuration card** (Settings → Plugins): URL, API key,
  timeout and the whole field mapping are editable in the page, with the same
  overridden/reset affordances as first-party plugin cards.
- **Works with any JSON API**: GET or POST, `Authorization` bearer (or any header
  name/scheme), extra headers, and dotted-path field mapping.
- **SearXNG-compatible by default**: the shipped mapping matches SearXNG's
  `results[]` / `url` / `title` / `content` / `publishedDate` shape.

## How it works

```text
web_search tool
      │
      ▼
ctx.web (capability seam)  ──selection──▶  provider id "custom"
      │                                          │
      │                                          ▼
      │                              fetch(your endpoint)  ──▶  your JSON API
      │                                          │
      └◀──── WebSearchResult { sources[], truncated } ◀──┘
```

The host side registers the namespace `web-search-custom` (so the settings page
can render a card for it) and registers a search provider with the stable id
`custom`. The provider's `search(query, signal)` reads the live settings value on
**every call**, fills the `{query}` / `{apiKey}` placeholders, performs the HTTP
request with the caller's cancellation signal plus its own timeout, and maps the
JSON payload into `sources[]` (deduplicated by URL, non-`http(s)` entries dropped,
HTML stripped, entities decoded).

Provider selection follows the seam's own rules, resolved at call time:
a configured id wins; with no id configured, exactly one usable provider is
required. The plugin's own `cordis.patch.yml` therefore also sets
`web.searchProvider: custom` so the choice is explicit rather than accidental.

## Requirements

| Item | Value |
|---|---|
| DeepSeek Harness | `>=0.1.2-alpha.3 <0.2.0 || >=0.1.5-alpha.1 <0.1.6` (verified on 0.1.2-alpha.4 and 0.1.5-rc.1) |
| Node.js | `^22.19.0 || >=24.0.0` |
| Runtime dependencies | **none** — the three peers come from the dsh host install |
| Network | outbound access from the dsh host to the endpoint you configure |

The `dsh` range is declared under `dsh.engines.dsh` (and mirrored in
`peerDependencies` for the dsh packages the plugin relies on). The disjunction is
load-bearing rather than cosmetic: npm semver only satisfies a prerelease from a
range group that itself contains a prerelease with the same
`[major, minor, patch]` tuple, so a plain `<0.2.0` group does **not** cover
`0.1.5-rc.1`. `tests/entry.test.mjs` pins this with a decision table and a
counter-proof against the old single range.

## Install

```bash
dsh plugin --profile web add dsh-web-search-custom
```

Restart the dsh web instance afterwards. From a local checkout, pass the
directory path instead of the package name.

## Configure in the settings page

Open **Settings → Plugins** in the web UI and expand the
"Custom search (web-search-custom)" card. Everything is editable there:

- the search URL (with `{query}` / `{apiKey}` placeholders),
- the API key (**optional**; when set it is sent as `Authorization: Bearer`),
- request method, POST body template, extra headers (JSON), timeout,
- the result field mapping (`resultsPath` / `urlField` / `titleField` /
  `snippetField` / `publishedField`).

Saving writes the `web-search-custom:` section of your dsh settings document and
takes effect immediately — the next search uses the new value, no restart. The
overridden/reset badges behave exactly like first-party plugin cards.

## Configuration reference

| Field | Default | Description |
| --- | --- | --- |
| `url` | local SearXNG | Search endpoint. Supports `{query}` and `{apiKey}` placeholders (URL-encoded automatically). For GET without a `{query}` placeholder, `q=` is appended automatically |
| `apiKey` | empty | Optional. When set, sent as `Authorization: Bearer <key>` by default; if the URL or the POST body already contains `{apiKey}`, no extra header is added |
| `method` | `GET` | `GET` or `POST`; any other value degrades to `GET` |
| `body` | `{"query":"{query}"}` | POST body template, supports `{query}` / `{apiKey}` |
| `headers` | `{}` | Extra request headers as a JSON string |
| `authHeader` | `Authorization` | Header name used for the API key |
| `authScheme` | `Bearer` | Auth scheme; leave empty to send the bare key |
| `timeoutMs` | `30000` | Per-request timeout |
| `resultsPath` | `results` | Dotted path to the result array, e.g. `data.results` |
| `urlField` / `titleField` / `snippetField` / `publishedField` | `url` / `title` / `content` / `publishedDate` | Result field-name mapping (SearXNG's defaults) |

Each field also falls back to a wider list of common aliases at mapping time
(for example a missing `titleField` value still tries `title` then `name`).

## Other configuration channels

### Profile patch layer (settings document alternative)

```yaml
- id: web-search-custom
  config:
    url: 'http://127.0.0.1:8080/search?format=json&q={query}'
    apiKey: ''
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
| `WEB_SEARCH_CUSTOM_URL` | Override the search URL |
| `WEB_SEARCH_CUSTOM_API_KEY` | Override the API key (recommended for secrets) |
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
- The page size is decided by the upstream service; the client cannot request a
  specific `count`. The tool layer still truncates to `maxResults`.
- Result mapping is field-based, not query-language aware: exotic payload shapes
  need the field mapping (and, if necessary, a `resultsPath`) adjusted.

## Development

```bash
npm install          # dev dependencies (dsh packages, for the host-contract test)
npm test             # node --test tests/*.test.mjs && node tests/client-smoke.mjs
npm run test:host    # real Cordis + WebRuntime + file settings provider
```

| Test | What it proves |
|---|---|
| `tests/entry.test.mjs` | Real entry load (`import('../src/index.js')`), manifest declarations, the engines decision table (hand-rolled comparator + counter-proof + cross-check against the host's real `semver.satisfies`), four-way key parity (host schema ↔ client fields ↔ client views ↔ patch config), settings hot-reload alive reference, dependency hygiene |
| `tests/host-integration.test.mjs` | Driven by the real `@deepseek-ai/cordis` context, the real `ctx.web` runtime and the real file-backed settings provider: provider registration, full `web.search()` path, `maxResults` capping by the seam, live settings → next-call effect, and the seam's selection semantics |
| `tests/client-smoke.mjs` | Browser half: bundle id, short service names, locale parity, slot registration contract, card rendering, save/reset write path, read-only disabling |
| `tests/live-search.mjs` | Opt-in live check against a real endpoint: `DSH_WSC_LIVE_URL='http://host/search?format=json&q={query}' node tests/live-search.mjs` |

```text
src/index.js          host half — settings namespace, URL/body templating, mapping
lib/client.js         browser half — settings card (hand-written bundle, no build step)
cordis.patch.yml      bundle patch: select provider "custom" and mount the plugin
tests/                entry + host-contract + client-smoke + opt-in live check
```

## License

[MIT](LICENSE)
