/**
 * host-integration.test.mjs —— 真宿主对象契约测试（不是自造桩）。
 *
 * 用 dsh 0.1.7-rc.1 的真实包驱动本插件，封堵 dsh-plugin-audit 的「契约形状盲区」：
 *   1. 真实 Cordis Context 上 apply 合法（同步 apply、effect 注册被宿主接受）
 *   2. provider 真注册进 WebRuntime.searchProviders，真实 ctx.web.search() 全链路走通
 *   3. 真实 volatile 协议（@deepseek-ai/cosmokit 的 createVolatile/updateVolatile）：
 *      设置卡保存 = 宿主 _commitVolatile 原地更新引用 → 下一次 search 立刻读到新值
 *   4. 真实 dsh-settings 的 schema 助手（volatileForm / isVolatilePath / projectForm /
 *      plainConfig）：reproduce 0.1.7 命名空间枚举判据与写路径校验
 *      （installSection 已移除后，describe() 只认「含 volatile 字段的 Config」）
 *   5. 真实 evaluatePluginCompatibility（dsh-app-boot）：本仓 peer 区间必须过宿主兼容闸，
 *      并反证它真的会拒绝 0.1.8/0.2.0 与旧的单区间
 *   6. 真实 provider 选择语义（configured id / 未注册 / 不可用）
 *   7. seam 的 capSources 兜底（超量结果被截断并置 truncated）
 *
 * 依赖解析：插件开发依赖（与宿主同版副本）优先 → 宿主 @deepseek-ai/dsh 包目录 →
 * POSIX 全局安装目录；解析不到时显式 skip 并打印原因（不假绿）。
 *
 * 诚实缺口：这里不启动完整的 app-boot（实时 Loader + ConfigEditor + SettingsService
 * 需要真实 profile 与全部宿主 bundle），故 describe()/mutate() 的全链路只做到
 * 「用真实 schema 助手复现其判据」这一层；端到端真机验证见 docs 的隔离实例记录。
 *
 * 运行：node --test tests/host-integration.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const { apply, SEARCH_PROVIDER_ID, Config, DEFAULT_URL } = await import('../src/index.js')

const CONFIG_KEYS = [
  'api', 'url', 'apiKey', 'maxResults', 'method', 'body', 'headers', 'authHeader', 'authScheme',
  'timeoutMs', 'resultsPath', 'urlField', 'titleField', 'snippetField', 'publishedField',
]

/** POSIX 全局安装目录（Windows 上不存在，探测失败即跳过该候选）。 */
const HOST_PKG = '/usr/lib/node_modules/@deepseek-ai/dsh/package.json'

/** 开发依赖副本里的 @deepseek-ai/dsh 包目录（宿主同版本，测试用它提供真实依赖树）。 */
function dshPackageDir() {
  for (const from of [import.meta.url, HOST_PKG]) {
    try { return dirname(createRequire(from).resolve('@deepseek-ai/dsh/package.json')) } catch { /* try next */ }
  }
  return undefined
}
const DSH_DIR = dshPackageDir()

/** 解析包的安装目录：插件开发依赖优先，其次 @deepseek-ai/dsh 自己的依赖树，最后全局安装目录。 */
function resolveDepDir(name) {
  const bases = [import.meta.url]
  if (DSH_DIR !== undefined) bases.push(join(DSH_DIR, 'package.json'))
  bases.push(HOST_PKG)
  for (const from of bases) {
    try { return dirname(createRequire(from).resolve(name + '/package.json')) } catch { /* try next */ }
  }
  return undefined
}

/** 按包自身 exports/main 解析 ESM 入口并真实 import（不猜文件布局）。 */
async function loadDep(name, relative) {
  const dir = resolveDepDir(name)
  if (dir === undefined) return undefined
  const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
  const entry = relative !== undefined ? relative : manifest.exports?.['.']
  const rel = relative !== undefined
    ? relative
    : (typeof entry === 'string' ? entry : (entry?.import ?? entry?.default ?? manifest.module ?? manifest.main))
  return import(pathToFileURL(join(dir, rel)).href)
}

/** 宿主自带 semver（经 @deepseek-ai/dsh 的依赖树解析），不可用时上层显式跳过。 */
function loadHostSemver() {
  for (const from of [import.meta.url, ...(DSH_DIR === undefined ? [] : [join(DSH_DIR, 'package.json')]), HOST_PKG]) {
    try { return createRequire(from)('semver') } catch { /* try next */ }
  }
  return undefined
}

const DEP_NAMES = [
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-web',
  '@deepseek-ai/dsh-settings',
  '@deepseek-ai/dsh-app-boot',
  '@deepseek-ai/cosmokit',
  '@deepseek-ai/schemastery',
]
const missing = DEP_NAMES.filter((name) => resolveDepDir(name) === undefined)
const SKIP_REASON = missing.length === 0 ? '' : 'unresolvable host deps: ' + missing.join(', ') + ' (run pnpm install)'

test('host-contract: 真实 dsh 依赖可解析（否则显式 skip，不假绿）', (t) => {
  if (missing.length > 0) return t.skip(SKIP_REASON)
  assert.deepEqual(missing, [])
})

// ---------------------------------------------------------------------------
// 真实宿主对象
// ---------------------------------------------------------------------------

/** 真实 cordis + 真实 cosmokit volatile 协议 + 真实 WebRuntime。 */
async function makeHost(webConfig) {
  const [{ Context }, { WebRuntime }, cosmo] = await Promise.all([
    loadDep('@deepseek-ai/cordis'),
    loadDep('@deepseek-ai/dsh-web'),
    loadDep('@deepseek-ai/cosmokit'),
  ])
  const app = new Context()
  const web = new WebRuntime(app, webConfig ?? {})
  const ctx = app.extend({ web })
  return {
    ctx, web, cosmo,
    /** 宿主 effect 在 microtask 落地：等一拍再断言注册表。 */
    settle: () => new Promise((resolve) => setTimeout(resolve, 10)),
  }
}

/** schema 解析出的默认值（0.1.7 起 volatile 字段解析结果是 {get()} 引用，逐字段解引用）。 */
function configDefaults() {
  const out = {}
  for (const [key, value] of Object.entries(Config())) {
    out[key] = value !== null && typeof value === 'object' && typeof value.get === 'function' ? value.get() : value
  }
  return out
}

/**
 * 用真实 volatile 协议构造 apply 会收到的配置：真实宿主交到 apply 手里的是
 * 「解析后的完整 config，其中 volatile 字段是 {get()} 活引用」，故这里也是全字段
 * volatile（已是引用的值原样透传，便于测试自己持有引用做 _commitVolatile）。
 */
function liveConfig(cosmo, overrides = {}) {
  const defaults = configDefaults()
  const config = {}
  for (const key of CONFIG_KEYS) {
    const raw = Object.prototype.hasOwnProperty.call(overrides, key) ? overrides[key] : defaults[key]
    config[key] = (raw !== null && typeof raw === 'object' && typeof raw.get === 'function')
      ? raw
      : cosmo.createVolatile(raw)
  }
  return config
}

/** 打桩 fetch 并记录 URL；返回恢复函数。 */
function stubFetch(calls, payload = { results: [] }, ok = true, status = 200) {
  const real = globalThis.fetch
  globalThis.fetch = async (url) => {
    calls.push(String(url))
    return { ok, status, json: async () => payload }
  }
  return () => { globalThis.fetch = real }
}

const SAMPLE = {
  results: [
    { url: 'https://a.example', title: '<b>A</b>', content: 'alpha&hellip;' },
    { url: 'https://b.example', title: 'B', content: 'beta' },
  ],
}

test('host-contract: 真实 Cordis + WebRuntime 下 apply 全链路', async (t) => {
  if (missing.length > 0) return t.skip(SKIP_REASON)
  const host = await makeHost()
  apply(host.ctx, { api: 'generic', url: 'http://127.0.0.1:18080/search?format=json' })
  await host.settle()
  // 真注册表里有我们的 provider
  assert.deepEqual([...host.web.searchProviders.keys()], [SEARCH_PROVIDER_ID])
  assert.equal(host.web.searchProviders.get(SEARCH_PROVIDER_ID).available(), true)
  // 真 seam 全链路（seam 负责 capSources）
  const calls = []
  const restore = stubFetch(calls, SAMPLE)
  try {
    const result = await host.web.search({ query: 'hello world', maxResults: 1 })
    assert.equal(calls.length, 1)
    assert.ok(/q=hello(%20|\+)world/.test(calls[0]), 'GET must append the query: ' + calls[0])
    assert.equal(result.sources.length, 1, 'seam must truncate to maxResults')
    assert.equal(result.truncated, true, 'seam must flag truncation')
    assert.equal(result.sources[0].url, 'https://a.example')
    assert.equal(result.sources[0].title, 'A', 'HTML must be stripped')
    assert.equal(result.sources[0].snippet, 'alpha…', 'entities must be decoded')
  } finally { restore() }
})

test('host-contract: 真实 volatile 提交后 search 立刻读到新值（活引用，非 apply 快照）', async (t) => {
  if (missing.length > 0) return t.skip(SKIP_REASON)
  const host = await makeHost()
  const { cosmo } = host
  const urlRef = cosmo.createVolatile('http://127.0.0.1:18080/search?format=json')
  apply(host.ctx, liveConfig(cosmo, { api: 'generic', url: urlRef }))
  await host.settle()

  const calls = []
  const restore = stubFetch(calls, SAMPLE)
  try {
    await host.web.search({ query: 'before' })
    // 宿主 _commitVolatile 的原语：把新解析出的引用原地提交进插件持有的引用
    cosmo.updateVolatile(urlRef, cosmo.createVolatile('http://127.0.0.1:19090/search?format=json'))
    await host.web.search({ query: 'after' })
  } finally { restore() }

  assert.ok(calls[0].startsWith('http://127.0.0.1:18080/'), 'first search uses the live value: ' + calls[0])
  assert.ok(calls[1].startsWith('http://127.0.0.1:19090/'),
    '设置卡保存（_commitVolatile 原地提交）后下一次 search 必须读到新值: ' + calls[1])
})

test('host-contract: 真实选择语义——唯一可用 / 未注册 / 不可用', async (t) => {
  if (missing.length > 0) return t.skip(SKIP_REASON)

  // 未配置 + 唯一可用 provider → 选中我们（不抛 = 被选中）
  const unique = await makeHost()
  apply(unique.ctx, { api: 'generic', url: 'http://127.0.0.1:18080/search?format=json' })
  await unique.settle()
  const calls = []
  const restore = stubFetch(calls, SAMPLE)
  try { await unique.web.search({ query: 'ok' }) } finally { restore() }

  // configured id 未注册 → WEB_PROVIDER_CONFIGURED_MISSING
  const gone = await makeHost({ searchProvider: 'nope' })
  apply(gone.ctx, { api: 'generic', url: 'http://127.0.0.1:18080/search?format=json' })
  await gone.settle()
  await assert.rejects(() => gone.web.search({ query: 'x' }),
    (error) => error.code === 'WEB_PROVIDER_CONFIGURED_MISSING')

  // configured id 是我们但不可用（url 为空）→ WEB_PROVIDER_CONFIGURED_UNAVAILABLE
  const unusable = await makeHost({ searchProvider: SEARCH_PROVIDER_ID })
  apply(unusable.ctx, { api: 'generic', url: '' })
  await unusable.settle()
  await assert.rejects(() => unusable.web.search({ query: 'x' }),
    (error) => error.code === 'WEB_PROVIDER_CONFIGURED_UNAVAILABLE')
})

// ---------------------------------------------------------------------------
// 0.1.7 settings 命名空间来源（真实 dsh-settings schema 助手）
// ---------------------------------------------------------------------------

test('host-contract: 真实 volatileForm —— describe() 必须枚举到本命名空间', async (t) => {
  if (missing.length > 0) return t.skip(SKIP_REASON)
  const schema = await loadDep('@deepseek-ai/dsh-settings', 'lib/types/schema.js')
  assert.ok(schema !== undefined, 'dsh-settings schema helpers must be loadable')

  // dsh-settings 的 describe()：const form = volatileForm(schema); if (form === undefined) return []
  // —— 返回 undefined 就是「宿主看不到这个命名空间」，设置卡永不注册（静默失效）。
  const form = schema.volatileForm(Config)
  assert.notEqual(form, undefined,
    'volatileForm(Config) must be defined — otherwise dsh-settings filters this namespace out')
  assert.deepEqual(Object.keys(form.dict).sort(), [...CONFIG_KEYS].sort(),
    'every Config field must be part of the editable form')

  // 写路径校验（dsh-settings write(): isVolatilePath(schema, path) 逐字段）
  for (const key of CONFIG_KEYS) {
    assert.equal(schema.isVolatilePath(Config, [key]), true, key + ' must be writable live (volatile)')
  }
})

test('host-contract: projectForm + plainConfig 还原设置卡看到的字段值（真实 volatile 协议）', async (t) => {
  if (missing.length > 0) return t.skip(SKIP_REASON)
  const [schema, { cosmo }] = await Promise.all([
    loadDep('@deepseek-ai/dsh-settings', 'lib/types/schema.js'),
    (async () => { const cosmoMod = await loadDep('@deepseek-ai/cosmokit'); return { cosmo: cosmoMod } })(),
  ])
  const config = liveConfig(cosmo, {
    api: 'anysearch',
    apiKey: 'sk-live',
    maxResults: 5,
  })
  // describe() 的 value 列：projectForm(form, plainConfig(entry.fiber.config))
  const value = schema.projectForm(schema.volatileForm(Config), schema.plainConfig(config))
  assert.deepEqual(Object.keys(value).sort(), [...CONFIG_KEYS].sort())
  assert.equal(value.api, 'anysearch', 'plainConfig must unwrap the volatile reference')
  assert.equal(value.apiKey, 'sk-live')
  assert.equal(value.maxResults, 5)
  assert.equal(value.url, DEFAULT_URL, 'unset fields keep the schema default')
  // 反向：未解引用的 {get()} 引用不该被当成普通值（证明这层是真的在跑）
  assert.equal(typeof config.url.get, 'function')
})

// ---------------------------------------------------------------------------
// 真实 client 半契约（源码级：桩测试的盲区——桩里永远存在的东西，真机可能不存在）
// ---------------------------------------------------------------------------

/** 读取宿主 client 包里的文件源码；不可解析时返回 undefined。 */
function readClientSource(name, relative) {
  const dir = resolveDepDir(name)
  if (dir === undefined) return undefined
  try { return readFileSync(join(dir, relative), 'utf8') } catch { return undefined }
}

test('host-contract: dsh.client.inject 里的每个包名都真实存在且是 web client 包', async (t) => {
  if (missing.length > 0) return t.skip(SKIP_REASON)
  const declared = pkg.dsh.client.inject ?? []
  assert.ok(declared.length > 0, 'manifest must declare the client module-graph dependencies')
  for (const name of declared) {
    const dir = resolveDepDir(name)
    assert.notEqual(dir, undefined, 'dsh.client.inject 包名必须真实存在（防拼写错误）: ' + name)
    const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
    assert.equal(manifest.dsh?.client?.platform, 'web', name + ' must be a web client bundle')
  }
})

test('host-contract: 真实 primitives 导出本卡调用的组件名', async (t) => {
  if (missing.length > 0) return t.skip(SKIP_REASON)
  const source = readClientSource('@deepseek-ai/dsh-client-ui-primitives', 'lib/index.js')
  if (source === undefined) return t.skip('@deepseek-ai/dsh-client-ui-primitives/lib/index.js not resolvable')
  const exported = new Set()
  for (const match of source.matchAll(/export\s*\{([^}]*)\}/g)) {
    for (const entry of match[1].split(',')) {
      const name = entry.trim().split(/\s+as\s+/).pop().trim()
      if (name) exported.add(name)
    }
  }
  // 桩里永远存在的名字，真机可能不存在：这里读宿主真实源码逐名核对
  for (const name of ['SettingsForm', 'SettingsValueField']) {
    assert.ok(exported.has(name), '@deepseek-ai/dsh-client-ui-primitives must export ' + name)
  }
})

test('host-contract: renderer 的 plugins.item 槽位与 inject 回调契约（源码级）', async (t) => {
  if (missing.length > 0) return t.skip(SKIP_REASON)
  const renderer = readClientSource('@deepseek-ai/dsh-client-ui-renderer', 'lib/client.js')
  const manager = readClientSource('@deepseek-ai/dsh-client-ui-plugin-manager', 'lib/client.js')
  if (renderer === undefined || manager === undefined) return t.skip('renderer/plugin-manager client bundle not resolvable')
  // 槽位由插件管理页声明；我们的卡片注册进它
  assert.ok(manager.includes('"plugins.item"'), 'plugin manager must declare the plugins.item slot')
  assert.match(manager, /renderSlot\("plugins\.item",\s*\{\s*view: "summary"\s*\}/,
    'plugin manager must render the summary view (our card returns the description string for it)')
  assert.match(manager, /renderSlot\("plugins\.item",\s*\{\s*view: "page"/,
    'plugin manager must render the page view (our card returns the SettingsForm for it)')
  // inject(key, callback)：callback 交给 ctx.effect —— 必须是「返回 disposer」的形态
  assert.match(renderer, /inject\(key, callback\)/, 'slots.inject(key, callback) contract')
  assert.match(renderer, /ctx\.effect\(callback,/, 'the callback is registered as an effect (disposer contract)')
})

// ---------------------------------------------------------------------------
// 真实兼容闸（dsh-app-boot evaluatePluginCompatibility）
// ---------------------------------------------------------------------------

test('host-contract: 真实兼容闸接受本仓 peer 区间，并拒绝越界版本与旧区间', async (t) => {
  if (missing.length > 0) return t.skip(SKIP_REASON)
  const boot = await loadDep('@deepseek-ai/dsh-app-boot')
  assert.ok(boot !== undefined, 'dsh-app-boot must be loadable')
  const { evaluatePluginCompatibility } = boot

  // 本仓 peer 区间必须在 0.2.0-rc.1（含预发布，includePrerelease）下通过
  assert.equal(evaluatePluginCompatibility(pkg, {}, '0.2.0-rc.1'), undefined,
    'manifest peers must accept the runtime this plugin is adapted to')
  assert.equal(evaluatePluginCompatibility(pkg, {}, '0.2.0'), undefined, 'also accepts the 0.2.0 release')
  assert.equal(evaluatePluginCompatibility(pkg, {}, '0.1.7-rc.1'), undefined, 'still accepts 0.1.7-rc.1')
  assert.equal(evaluatePluginCompatibility(pkg, {}, '0.1.5-rc.1'), undefined, 'still accepts 0.1.5-rc.1')

  // 反证：越界版本必须被拒（证明这道闸真的在判，而不是永远放行）
  // 0.2.0 适配轮（2026-09-29）：原先这里断言 0.2.0 被拒——那是「未验证就先拦住」的临时状态，
  // 本轮已真机验证 → 有意翻转。越界反证改用真正未验证的 0.3.0。
  const rejected = evaluatePluginCompatibility(pkg, {}, '0.3.0')
  assert.notEqual(rejected, undefined, '0.3.0 must be rejected (unverified upper bound)')
  assert.ok(Object.keys(rejected.peers).includes('@deepseek-ai/dsh'))

  // 语义澄清（实测，勿误读）：这道 preflight 用 includePrerelease:true，所以旧的
  // 单区间 '>=0.1.2-alpha.3 <0.2.0' 在 0.1.7-rc.1 下**也会通过**——真正拦住它的是
  // pnpm 的严格 semver（预发布只被同元组下界覆盖）。两种判定都要验，缺一会把结论说反。
  const legacy = { ...pkg, peerDependencies: { ...pkg.peerDependencies, '@deepseek-ai/dsh': '>=0.1.2-alpha.3 <0.2.0' } }
  assert.equal(evaluatePluginCompatibility(legacy, {}, '0.1.7-rc.1'), undefined,
    'preflight uses includePrerelease:true, so the legacy range passes THIS gate too')
  // 同一澄清在 0.2.0 线上同样成立：旧单区间在 preflight 下也放行 0.2.0-rc.1
  // （因为 includePrerelease 绕过了预发布可见性规则），但严格模式在 0.2.0 正式版上会拒。
  assert.equal(evaluatePluginCompatibility(legacy, {}, '0.2.0-rc.1'), undefined,
    'preflight also passes the legacy range at 0.2.0-rc.1')

  const semver = loadHostSemver()
  if (semver === undefined) {
    console.log('SKIP: host semver not resolvable — the strict-range counter-proof did not run')
    return
  }
  const DECLARED = pkg.peerDependencies['@deepseek-ai/dsh']
  assert.equal(semver.satisfies('0.1.7-rc.1', '>=0.1.2-alpha.3 <0.2.0'), false,
    'strict semver rejects the legacy range at 0.1.7-rc.1 → pnpm install would refuse it')
  assert.equal(semver.satisfies('0.1.7-rc.1', DECLARED), true, 'the declared range covers the adapted runtime')
  assert.equal(semver.satisfies('0.1.7-rc.1', '>=0.1.2-alpha.3 <0.2.0', { includePrerelease: true }), true,
    'with includePrerelease the same legacy range passes — that is the preflight behaviour')
  // 0.2.0 线：两种模式都要覆盖
  assert.equal(semver.satisfies('0.2.0-rc.1', DECLARED), true, 'the declared range covers 0.2.0-rc.1 (strict)')
  assert.equal(semver.satisfies('0.2.0', DECLARED), true, 'the declared range covers the 0.2.0 release (strict)')
  assert.equal(semver.satisfies('0.3.0', DECLARED), false, 'the declared range still rejects 0.3.0')
})
