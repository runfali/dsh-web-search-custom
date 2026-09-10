# Install / Boot / Serve Evidence — dsh 0.1.5-rc.1

> 一次性隔离实例（独立 DSH_HOME + 独立端口）上的安装、启动、provider 挂载与
> client bundle 下发全链路证据。本轮 2026-09-10 在 **dsh 0.1.5-rc.1** 上重跑，
> 未触碰任何已部署的 dsh 实例。

## Environment

| Item | Value |
|---|---|
| dsh host | @deepseek-ai/dsh **0.1.5-rc.1** |
| Node.js | v24.19.0 |
| pnpm | 11.22.0 (forwarded by `dsh plugin`) |
| Isolated home | `DSH_HOME=<workdir>/.e2e-web-search-custom/home` (never the live home) |
| Isolated port | 33082 (live instances use different ports) |
| Plugin under test | dsh-web-search-custom **0.1.5-rc.1** (local directory install) |
| Dev dependency | `@deepseek-ai/dsh-settings` **0.1.5-rc.1** (byte-identical to the host copy) |

## Manifest compatibility declaration

Declared in `package.json` (machine-readable):

```jsonc
"engines": { "node": "^22.19.0 || >=24.0.0" },
"peerDependencies": {
  "@deepseek-ai/dsh-settings": ">=0.1.2-alpha.3 <0.2.0 || >=0.1.5-alpha.1 <0.1.6",
  "@deepseek-ai/schemastery": "^3.18.2",
  "react": "^18.0.0"
},
"dsh": {
  "engines": { "dsh": ">=0.1.2-alpha.3 <0.2.0 || >=0.1.5-alpha.1 <0.1.6" },
  "bundle": { "patch": "./cordis.patch.yml" },
  "client": { "platform": "web" }
}
```

- **Node.js range**: `^22.19.0 || >=24.0.0` (verified on v24.19.0).
- **DSH range**: the disjunction is load-bearing. npm semver satisfies a
  prerelease only from a range group that itself carries a prerelease with the
  same `[major, minor, patch]` tuple, so the previous single
  `>=0.1.2-alpha.3 <0.2.0` group did **not** cover `0.1.5-rc.1` — "claims 0.1.5
  support but fails its own claim". The same trap applies to the
  `peerDependencies` range for `@deepseek-ai/dsh-settings`.
  `tests/entry.test.mjs` pins both with a 10-row decision table, a counter-proof
  against the old range, and a line-by-line cross-check against the host's real
  `semver.satisfies` (10/10).
- **Supply chain**: zero `dependencies`, zero `optionalDependencies`. The three
  peers are provided by the dsh host install; nothing is vendored inside the
  package. No install-lifecycle scripts (`preinstall`/`install`/`postinstall`/
  `prepare`), no install-time network calls. The published tarball carries the
  host/client sources, the tests, the bundle patch and the READMEs only.

## 1. Install

```console
$ DSH_HOME=$E2E/home dsh plugin --profile web add /path/to/dsh-web-search-custom

✓ Lockfile passes supply-chain policies (verified 15m ago)

dependencies:
+ dsh-web-search-custom link:/path/to/dsh-web-search-custom

Done in 1.6s using pnpm v11.22.0
```

Resulting bundle list includes the plugin (the plugin's own `cordis.patch.yml`
is discovered through `dsh.bundle.patch`):

```json
"bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "dsh-web-search-custom"]
```

## 2. Composed tree (`--dump-config`)

The plugin contributes two composed entries — the seam selection patch and the
provider mount:

```yaml
# == @deepseek-ai/dsh-base, patched by dsh-web-search-custom
- id: web
  name: '@deepseek-ai/dsh-web'
  config:
    searchProvider: custom
...
# == dsh-web-search-custom
- id: web-search-custom
  name: dsh-web-search-custom
  config:
    url: http://127.0.0.1:8080/search?format=json&q={query}
    ...
```

## 3. Boot and serve

```console
$ DSH_HOME=$E2E/home dsh web --no-open --port 33082
dsh web: http://127.0.0.1:33082/?token=<one-time token>
```

- `GET /` without the token → `401 dsh web authentication required` (expected).
- Following the printed URL → `303` to the app shell + host cookie, then `200`
  with a 27,946-byte HTML shell.
- The boot manifest lists the plugin with its own module entry:

```json
{"id":"dsh-web-search-custom","url":"/plugins/??dsh-web-search-custom/client.js&rev=<hash>","rev":"<hash>"}
```

- Fetching the combo URL from the shell returns `200` and 11,162,513 bytes of
  browser bundles (the dsh 0.1.2-alpha.5+ combo shape — a bare
  `/plugins/dsh-web-search-custom/client.js` returns `404` for official plugins
  too, so a bare-path 404 is not evidence of absence). The downloaded bytes
  contain the plugin's factory id **7** times and its Chinese card title
  **1** time, i.e. the browser really receives this plugin's client half.

## 4. Live search through the real seam

`tests/live-search.mjs` drives the real `@deepseek-ai/cordis` context, the real
`ctx.web` runtime and the real file-backed settings provider against a live
SearXNG endpoint:

```console
$ DSH_WSC_LIVE_URL='<searxng>/search?format=json&q={query}' node tests/live-search.mjs 'deepseek harness'
query = deepseek harness
sources = 5 truncated = true
 - https://www.deepseek.com/harness/en/ | DeepSeek Harness developer preview: Everything is a plugin
 - https://www.deepseek.com/ | DeepSeek | Into the Unknown
 - https://github.com/deepseek-ai/deepseek-harness | GitHub - deepseek-ai/deepseek-harness: ...
LIVE OK
```

## 5. Test baseline (dsh 0.1.5-rc.1 dev dependencies)

```console
$ npm test
# node --test tests/*.test.mjs  → 23/23 pass
# node tests/client-smoke.mjs   → 14/14 pass
```

| Suite | Cases | Result |
|---|---|---|
| `tests/entry-smoke.test.mjs` (predates this round) | 5 | pass |
| `tests/entry.test.mjs` (new) | 9 | pass |
| `tests/host-integration.test.mjs` (new) | 4 | pass |
| `tests/client-smoke.mjs` (new) | 14 | pass |
| `tests/live-search.mjs` (opt-in) | 1 | LIVE OK |

Interpreter detail: `node --test tests/*.test.mjs` uses an explicit glob because
`node --test tests/` would also execute the two non-`node:test` scripts.

## 6. Honest gaps

- No browser-side automation: verifying the card visually still requires opening
  the settings page. What is proven here is the served bundle (id, rev, factory
  present) and the card's render/commit behaviour under a faithful stub.
- The Combo URL bytes were checked by grepping for the factory id and the card
  title, not by executing the bundle in a browser engine.
- `host-integration.test.mjs` uses the file-backed settings provider for write
  coverage; the in-memory `SettingsProvider` base class is read-only by design
  and cannot exercise the write path.
