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


## Round 6 — AnySearch live evidence (v0.2.0, dsh 0.1.5-rc.2, 2026-09-21)

This round is provider-internal and the endpoint is external, so evidence was collected on the live host (no isolated instance needed).

### Anonymous (keyless) end-to-end through the real seam

```text
$ DSH_WSC_LIVE_URL='https://api.anysearch.com/v1/search' node tests/live-search.mjs 'DeepSeek Harness plugin'
query = DeepSeek Harness plugin
sources = 5 truncated = false
 - https://www.deepseek.com/harness/en/ | DeepSeek Harness developer preview: Everything is a ...
 - https://github.com/deepseek-ai/deepseek-harness | DeepSeek Harness: Everything is a Plugin.
LIVE OK
```

Chain: our provider -> real `WebRuntime` -> real `fetch` -> AnySearch gateway -> envelope mapping -> `sources[]`.
This path sends no Authorization header (asserted in unit tests; the live run proves the anonymous tier accepts it).

### Invalid key path

```text
$ DSH_WSC_LIVE_BAD_KEY=1 node tests/live-search.mjs 'Kubernetes node 内存监控'
bad-key error = AnySearch search failed: HTTP 401 (code -1) Invalid API key. request_id=25ba37be-... check the "apiKey" setting ...
LIVE BAD-KEY OK (401/403 envelope + request_id + hint)
```

### Test totals (same run)

| Command | Result |
|---|---|
| `npm test` | `tests 39 / pass 39 / fail 0` plus client-smoke 17 checks |
| `node --test tests/anysearch.test.mjs` | 16/16 |
| RED baseline before implementation | 10 failed / 5 passed |

### Known non-runnable surface (honest gap)

The browser half could not be curl-verified on this host: the dsh web UI sits behind the login
gateway (`http://127.0.0.1:3080` answers 401 without a session), so `__DSH_BOOT__` / combo-URL
extraction is unavailable from the shell. The client card change is covered by
`tests/client-smoke.mjs` (bundle load, 15 field rows rendered, locale parity, save/reset write path),
the strongest check available without a session.



---

# Round 7 — dsh 0.1.7-rc.1 contract evidence (v0.3.0, 2026-09-26)

> 本轮**不是**隔离实例 E2E —— 那一步必须先重启用户正在使用的 dsh 实例（重启红线，待批准）。
> 这里记录的是**源码级 + 真宿主对象级**证据，逐条给出坐标，可原样复跑。

## Environment

| Item | Value |
|---|---|
| dsh host (installed) | @deepseek-ai/dsh **0.1.7-rc.1** (`%APPDATA%\npm\node_modules\@deepseek-ai\dsh`) |
| Node.js | v24.21.0 |
| pnpm | 12.6.0 |
| Dev dependencies | `@deepseek-ai/dsh` + `@deepseek-ai/dsh-settings` **0.1.7-rc.1**, `@deepseek-ai/schemastery` **3.18.4** |
| Plugin under test | dsh-web-search-custom **0.3.0** |
| Registry | `registry.npmjs.org` 直连 200；代理 `http://127.0.0.1:10808` 亦 200（出口 38.246.231.53） |

## 1. Host-source contract checks (grep-level, on the installed tree)

命令均以 `<dsh>/node_modules/@deepseek-ai` 为根（`<dsh>` = 上面的安装目录）。

| 检查 | 命令（要点） | 结果 |
|---|---|---|
| `installSection` 是否还存在 | `rg installSection <dsh>/node_modules/@deepseek-ai` | **0 命中** → 已移除 |
| `settingsScope` 是否还存在 | `rg settingsScope ...` | **0 命中** → 已移除 |
| `settings.plugin.item` 槽位 | `rg "settings\.plugin\.item" ...` | **0 命中** → 已移除 |
| 新槽位 `plugins.item` | `rg "plugins\.item" ...` | 5 个官方设置卡 + plugin-manager 在用 |
| `plugins.item` 双视图 | `dsh-client-ui-plugin-manager/lib/client.js:1662,1718,1726` | `renderSlot("plugins.item", { view: "summary" \| "page" }, { only: item.id })` |
| `slots.inject` 回调形态 | `dsh-client-ui-renderer/lib/client.js:1343-1398` | `ctx.effect(callback, ...)`；文档明确「Callback effects are synchronous disposers; iterable effects install transactionally」 |
| `configForms` 服务 | `dsh-client-ui-settings/lib/client.js:1309`（`get`）/ `:1330`（`whileServed`） | `whileServed(namespaces, register)` 按 describe 视图的 ns 列表门控 |
| 命名空间枚举判据 | `dsh-settings/lib/index.js:413-420` + `lib/types/schema.js:43` | `volatileForm(schema(entry.fiber.runtime.Config))` 为 undefined 即被过滤 |
| 热编辑字段判据 | `dsh-settings/lib/index.js:505-507` | 写路径逐字段 `isVolatilePath(schema, path)`，非 volatile 直接抛 |
| volatile 协议 | `cosmokit/lib/index.js:102-118` | `createVolatile(value) → { get(), [write](v) }`；`isVolatile` 判 `Symbol.for("cosmokit.volatile.write")` |
| 写回目标 | `dsh-config-editor/lib/index.js:24`（`documentPath`） | profile 补丁文档（`cordis.patch.yml`），非 settings.yaml |
| 兼容闸 | `dsh-app-boot/lib/index.js:286-313` | `semver.satisfies(runtimeVersion, range, { includePrerelease: true })` |
| provider 缝 | `dsh-web/lib/index.js:67` | `registerSearchProvider` 未变（零漂移） |

## 2. Real-host-object test evidence

`pnpm run test:host`（也含在 `pnpm test`），全部走**真实宿主包**：

```
ok 1 - host-contract: 真实 dsh 依赖可解析（否则显式 skip，不假绿）
ok 2 - host-contract: 真实 Cordis + WebRuntime 下 apply 全链路
ok 3 - host-contract: 真实 volatile 提交后 search 立刻读到新值（活引用，非 apply 快照）
ok 4 - host-contract: 真实选择语义——唯一可用 / 未注册 / 不可用
ok 5 - host-contract: 真实 volatileForm —— describe() 必须枚举到本命名空间
ok 6 - host-contract: projectForm + plainConfig 还原设置卡看到的字段值（真实 volatile 协议）
ok 7 - host-contract: dsh.client.inject 里的每个包名都真实存在且是 web client 包
ok 8 - host-contract: 真实 primitives 导出本卡调用的组件名
ok 9 - host-contract: renderer 的 plugins.item 槽位与 inject 回调契约（源码级）
ok 10 - host-contract: 真实兼容闸接受本仓 peer 区间，并拒绝越界版本与旧区间
# tests 10 / # pass 10 / # fail 0
```

关键读数（用例 10）：

```
evaluatePluginCompatibility(pkg, {}, '0.1.7-rc.1')                       → undefined（通过）
evaluatePluginCompatibility(pkg, {}, '0.2.0')                            → 拒绝
evaluatePluginCompatibility(<旧单区间>, {}, '0.1.7-rc.1')                → undefined（preflight 放行，includePrerelease）
semver.satisfies('0.1.7-rc.1', '>=0.1.2-alpha.3 <0.2.0')                 → false（pnpm 严格侧拒绝）
semver.satisfies('0.1.7-rc.1', <本仓区间>)                                → true
```

## 3. Test baseline (dsh 0.1.7-rc.1 dev dependencies)

```
pnpm test  →  node --test tests/*.test.mjs   # tests 53 / pass 53 / fail 0 / skipped 0
              node tests/client-smoke.mjs    # 24 项全部通过
```

## 4. Honest gaps

- **未做隔离实例 E2E**：`dsh plugin add` + 重启这套流程本轮没跑（重启需用户批准）。
  步骤已写死在 [DSH-0.1.7-ADAPTATION.md](DSH-0.1.7-ADAPTATION.md) 第 5 节，含三条活体核验
  （`pluginInventory/list` / `__DSH_BOOT__.entries` / combo URL 的字节特征）与「设置页无重复自动页」的判据。
- 卡片在真机插件页的**视觉**呈现未验证（与上一轮同样的限制，无浏览器自动化）。
- devDeps 升级后传递依赖带进 `@deepseek-ai/libreoffice-kit-win32-x64`（~71 MB，dev-only）——
  发布物不受影响（`files` 白名单 + 零 dependencies + 零安装脚本）。
