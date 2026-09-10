/**
 * entry.test.mjs — dsh 0.1.5-rc.1 适配守护测试（真实入口 + 声明面 + 键集合一致性）。
 *
 * 覆盖 dsh-plugin-audit 的盲区清单：
 *   1. 真实加载路径：直接 import('../src/index.js')（P0 级 import/顶层求值错误当场炸出）
 *   2. 声明面：version / exports / dsh.bundle.patch / dsh.client.platform
 *   3. engines 判定表：dsh.engines.dsh 与 peerDependencies 里的 dsh 区间必须真的覆盖
 *      0.1.5-rc.1（npm semver 预发布同元组规则），内置手写比较器 + 反证 + 与宿主真实
 *      semver.satisfies 逐行交叉验证
 *   4. 键集合一致性：host Config 键 === client FIELD_KEYS === client FIELD_VIEWS
 *      === cordis.patch.yml 里的 config 键（四处不等 = 静默调不到 / 静默丢配置）
 *   5. 依赖卫生：无安装期脚本、无运行时依赖
 *
 * 运行：node --test tests/*.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const clientSource = readFileSync(join(root, 'lib', 'client.js'), 'utf8')
const patchSource = readFileSync(join(root, 'cordis.patch.yml'), 'utf8')

const ENTRY = await import('../src/index.js')

// ---------------------------------------------------------------------------
// 1. 真实入口加载（第三/四路测试盲区的封堵）
// ---------------------------------------------------------------------------

function makeCtx() {
  const providers = []
  const installs = []
  const ctx = {
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    effect(fn) { const d = fn(); return typeof d === 'function' ? d : () => {} },
    on() { return () => {} },
    inject(services, cb) {
      cb({ settings: { installSection(owner, ns, schema, entry, hooks) { installs.push({ owner, ns, schema, entry, hooks }) } } })
      return ctx
    },
    web: { registerSearchProvider(provider) { providers.push(provider); return () => {} } },
  }
  return { ctx, providers, installs }
}

test('entry: src/index.js 真实加载路径 + 导出面', () => {
  assert.equal(typeof ENTRY.apply, 'function')
  assert.equal(ENTRY.name, 'web-search-custom')
  assert.equal(ENTRY.SEARCH_PROVIDER_ID, 'custom')
  assert.equal(ENTRY.WEB_SEARCH_CUSTOM_SETTINGS_NAMESPACE, 'web-search-custom')
  assert.equal(typeof ENTRY.Config, 'function')
  assert.deepEqual([...ENTRY.inject], ['web'])
  // apply 必须同步（Cordis 红线：await 后注册 effect 会抛 Invalid effect）
  const { ctx, providers, installs } = makeCtx()
  const ret = ENTRY.apply(ctx, { url: 'http://127.0.0.1:8080/search?format=json' })
  assert.equal(ret, undefined)
  assert.equal(providers.length, 1)
  assert.equal(installs.length, 1)
  assert.equal(installs[0].ns, 'web-search-custom')
  assert.equal(typeof installs[0].hooks.setSource, 'function')
  assert.equal(typeof installs[0].hooks.onChange, 'function')
})

test('entry: settings.setSource 热更新活引用（闭包传参快照陷阱）', async () => {
  const { ctx, providers, installs } = makeCtx()
  ENTRY.apply(ctx, { url: 'http://127.0.0.1:8080/search?format=json' })
  const { hooks } = installs[0]
  hooks.setSource(() => ({ url: 'http://elsewhere:9000/search?format=json' }))
  const realFetch = globalThis.fetch
  const calls = []
  globalThis.fetch = async (url) => { calls.push(String(url)); return { ok: true, status: 200, json: async () => ({ results: [] }) } }
  try {
    await providers[0].search({ query: 'q' }, undefined)
    assert.ok(calls[0].startsWith('http://elsewhere:9000/'), 'search must read the live source, not the apply-time snapshot')
  } finally {
    globalThis.fetch = realFetch
  }
})

// ---------------------------------------------------------------------------
// 2. 声明面
// ---------------------------------------------------------------------------

test('manifest: version / exports / bundle / client 平台声明', () => {
  assert.equal(pkg.version, '0.1.5-rc.1')
  assert.equal(pkg.main, 'src/index.js')
  assert.equal(pkg.exports['.'], './src/index.js')
  assert.equal(pkg.exports['./client'], './lib/client.js')
  assert.equal(pkg.dsh.bundle.patch, './cordis.patch.yml')
  assert.equal(pkg.dsh.client.platform, 'web')
  for (const f of ['src', 'lib', 'tests', 'cordis.patch.yml', 'README.md', 'LICENSE']) {
    assert.ok(pkg.files.includes(f), 'files must ship ' + f)
  }
})

// ---------------------------------------------------------------------------
// 3. engines 判定表（内置手写比较器，不引 semver 依赖）
// ---------------------------------------------------------------------------

function parseVersion(text) {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(String(text).trim())
  if (!m) return undefined
  return {
    major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]),
    pre: m[4] === undefined ? [] : m[4].split('.'),
  }
}

function comparePrerelease(a, b) {
  if (a.length === 0 && b.length === 0) return 0
  if (a.length === 0) return 1   // release > prerelease
  if (b.length === 0) return -1
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const x = a[i]
    const y = b[i]
    if (x === undefined) return -1
    if (y === undefined) return 1
    const nx = /^\d+$/.test(x)
    const ny = /^\d+$/.test(y)
    if (nx && ny) { if (Number(x) !== Number(y)) return Number(x) < Number(y) ? -1 : 1 }
    else if (nx !== ny) return nx ? -1 : 1
    else if (x !== y) return x < y ? -1 : 1
  }
  return 0
}

function compare(a, b) {
  for (const key of ['major', 'minor', 'patch']) {
    if (a[key] !== b[key]) return a[key] < b[key] ? -1 : 1
  }
  return comparePrerelease(a.pre, b.pre)
}

/** npm semver 预发布规则的最小实现：只支持 '>=X.Y.Z[-pre] <A.B.C[-pre]' 的 '||' 组合。 */
function satisfies(version, range) {
  const v = parseVersion(version)
  if (v === undefined) return false
  return String(range).split('||').some((clause) => {
    const terms = clause.trim().split(/\s+/).filter(Boolean)
    if (terms.length === 0) return false
    const bounds = []
    for (const term of terms) {
      const match = /^(>=|<)(.+)$/.exec(term)
      if (match === null) return false
      const bound = parseVersion(match[2])
      if (bound === undefined) return false
      bounds.push({ op: match[1], version: bound })
    }
    for (const bound of bounds) {
      const order = compare(v, bound.version)
      if (bound.op === '>=' && order < 0) return false
      if (bound.op === '<' && order >= 0) return false
    }
    // 预发布版本只被「区间内含同一 [major,minor,patch] 元组的预发布」满足
    if (v.pre.length > 0) {
      const anchored = bounds.some((bound) =>
        bound.version.major === v.major &&
        bound.version.minor === v.minor &&
        bound.version.patch === v.patch &&
        bound.version.pre.length > 0)
      if (!anchored) return false
    }
    return true
  })
}

const DECLARED = pkg.dsh.engines.dsh
const OLD_RANGE = '>=0.1.2-alpha.3 <0.2.0'

// 判定表（左：版本；右：是否被声明区间覆盖）
const DECISION_TABLE = [
  ['0.1.2-alpha.3', true],
  ['0.1.2-rc.1', true],
  ['0.1.3', true],
  ['0.1.4', true],
  ['0.1.5-alpha.1', true],
  ['0.1.5-rc.1', true],
  ['0.1.5', true],
  ['0.1.6', true],
  ['0.1.9-alpha.1', false],
  ['0.2.0', false],
]

test('engines: 判定表逐行命中 dsh.engines.dsh 与 peerDependencies 区间', () => {
  for (const [version, expected] of DECISION_TABLE) {
    assert.equal(satisfies(version, DECLARED), expected, 'dsh.engines.dsh must ' + (expected ? 'cover ' : 'exclude ') + version)
    assert.equal(satisfies(version, pkg.peerDependencies['@deepseek-ai/dsh-settings']), expected,
      'peerDependencies dsh range must ' + (expected ? 'cover ' : 'exclude ') + version)
  }
  // 声称适配的宿主版本必须真的被覆盖
  assert.equal(satisfies('0.1.5-rc.1', DECLARED), true, 'declared adaptation target must be covered by its own range')
})

test('engines: 反证——旧单区间覆盖不了 0.1.5-rc.1（这正是本轮修复的缺陷）', () => {
  assert.equal(satisfies('0.1.5-rc.1', OLD_RANGE), false)
  assert.equal(satisfies('0.1.2-rc.1', OLD_RANGE), true)
  assert.notEqual(DECLARED, OLD_RANGE)
})

test('engines: 与宿主真实 semver.satisfies 逐行交叉验证', () => {
  let semver
  try {
    const require = createRequire('/usr/lib/node_modules/@deepseek-ai/dsh/package.json')
    semver = require('semver')
  } catch {
    semver = undefined
  }
  if (semver === undefined) {
    console.log('SKIP: host semver not resolvable in this environment — hand-rolled comparator assertions still ran')
    return
  }
  let crossChecked = 0
  for (const [version, expected] of DECISION_TABLE) {
    assert.equal(semver.satisfies(version, DECLARED), expected, 'host semver disagrees for ' + version)
    assert.equal(semver.satisfies(version, pkg.peerDependencies['@deepseek-ai/dsh-settings']), expected,
      'host semver disagrees for peer range at ' + version)
    assert.equal(semver.satisfies(version, OLD_RANGE), satisfies(version, OLD_RANGE), 'comparator drift at ' + version)
    crossChecked += 1
  }
  assert.ok(crossChecked > 0)
})

// ---------------------------------------------------------------------------
// 4. 键集合一致性（host schema ↔ client 表单 ↔ 行级字段视图 ↔ 补丁 config）
// ---------------------------------------------------------------------------

function extract(source, pattern, label) {
  const match = pattern.exec(source)
  assert.ok(match !== null, 'could not extract ' + label)
  return match
}

test('keys: host Config 键 === client FIELD_KEYS === FIELD_VIEWS === cordis.patch.yml', () => {
  const hostKeys = Object.keys(ENTRY.Config.dict ?? {}).sort()

  const fieldsBlock = extract(clientSource, /const FIELD_KEYS = \[([\s\S]*?)\]/, 'FIELD_KEYS')[1]
  const clientKeys = [...fieldsBlock.matchAll(/"([A-Za-z][A-Za-z0-9]*)"/g)].map((m) => m[1]).sort()

  const viewsBlock = extract(clientSource, /const FIELD_VIEWS = \[([\s\S]*?)\n    \];/, 'FIELD_VIEWS')[1]
  const viewKeys = [...viewsBlock.matchAll(/key: "([A-Za-z][A-Za-z0-9]*)"/g)].map((m) => m[1]).sort()

  const patchBlock = extract(patchSource, /- id: web-search-custom\n      name: [^\n]*\n      config:\n([\s\S]*)$/, 'patch config')[1]
  const patchKeys = [...patchBlock.matchAll(/^ {8}([A-Za-z][A-Za-z0-9]*):/gm)].map((m) => m[1]).sort()

  assert.ok(hostKeys.length > 0)
  assert.deepEqual(clientKeys, hostKeys, 'client FIELD_KEYS must equal host Config keys')
  assert.deepEqual(viewKeys, hostKeys, 'client FIELD_VIEWS must equal host Config keys')
  assert.deepEqual(patchKeys, hostKeys, 'cordis.patch.yml config must equal host Config keys')
})

test('keys: cordis.patch.yml 的值 === host Config 默认值（补丁层与 schema 不漂移）', () => {
  const defaults = ENTRY.Config()
  const block = extract(patchSource, /- id: web-search-custom\n      name: [^\n]*\n      config:\n([\s\S]*)$/, 'patch config')[1]
  for (const [key, value] of Object.entries(defaults)) {
    const match = new RegExp('^ {8}' + key + ': ' + '(.*)$', 'm').exec(block)
    assert.ok(match !== null, 'patch must declare ' + key)
    let raw = match[1].trim()
    if ((raw.startsWith("'") && raw.endsWith("'")) || (raw.startsWith('"') && raw.endsWith('"'))) raw = raw.slice(1, -1)
    assert.equal(raw, String(value), key + ' patch value must equal the schema default')
  }
})

test('keys: client 表单字段与 host schema 逐键可写（默认值类型一致）', () => {
  const defaults = ENTRY.Config()
  const fieldsBlock = extract(clientSource, /this\.form = new CardForm\(scope, \[([\s\S]*?)\n      \]\)/, 'form specs')[1]
  const specs = [...fieldsBlock.matchAll(/(textField|numberField)\("([A-Za-z][A-Za-z0-9]*)"\)/g)]
  const byField = new Map(specs.map((m) => [m[2], m[1]]))
  for (const [key, value] of Object.entries(defaults)) {
    assert.ok(byField.has(key), 'form must expose ' + key)
    const expectedSpec = typeof value === 'number' ? 'numberField' : 'textField'
    assert.equal(byField.get(key), expectedSpec, key + ' must use ' + expectedSpec)
  }
})

// ---------------------------------------------------------------------------
// 5. 依赖卫生
// ---------------------------------------------------------------------------

test('hygiene: 无安装期脚本、无运行时依赖', () => {
  const scripts = pkg.scripts ?? {}
  for (const forbidden of ['preinstall', 'install', 'postinstall', 'prepare', 'prepublishOnly']) {
    assert.equal(scripts[forbidden], undefined, 'must not declare a ' + forbidden + ' script')
  }
  assert.deepEqual(Object.keys(pkg.dependencies ?? {}), [], 'runtime dependencies must stay empty (peers only)')
  assert.ok(pkg.peerDependencies['@deepseek-ai/dsh-settings'])
})


// ---------------------------------------------------------------------------
// 5. 依赖卫生
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 6. 健壮性（第 5 轮复核固化：极端输入 / 取消 / 超时）
// ---------------------------------------------------------------------------

function stubJson(payload, ok = true, status = 200) {
  const real = globalThis.fetch
  globalThis.fetch = async () => ({ ok, status, json: async () => payload })
  return () => { globalThis.fetch = real }
}

test('robustness: 病态载荷一律降级为空 sources，不抛', async () => {
  const cases = [
    ['results 是对象', { results: { a: 1 } }],
    ['results 为 null', { results: null }],
    ['payload 为 null', null],
    ['payload 为字符串', 'not json shaped'],
    ['resultsPath 路径缺失', { data: {} }],
    ['results 元素为 null/undefined（P2-3 修复点）', { results: [null, undefined, 42] }],
    ['results 元素为字符串/布尔/空数组', { results: ['x', true, [], 0] }],
  ]
  for (const [label, payload] of cases) {
    const { ctx, providers } = makeCtx()
    ENTRY.apply(ctx, { url: 'http://127.0.0.1:8080/search?format=json' })
    const restore = stubJson(payload)
    try {
      const result = await providers[0].search({ query: 'x' }, undefined)
      assert.deepEqual(result, { sources: [], truncated: false }, label)
    } finally { restore() }
  }
})

test('robustness: 条目字段类型错时不崩，非字符串字段被忽略', async () => {
  const { ctx, providers } = makeCtx()
  ENTRY.apply(ctx, { url: 'http://127.0.0.1:8080/search?format=json' })
  const restore = stubJson({ results: [{ url: 'https://a.example', title: 42, content: [1, 2] }] })
  try {
    const result = await providers[0].search({ query: 'x' }, undefined)
    assert.equal(result.sources.length, 1)
    assert.equal(result.sources[0].url, 'https://a.example')
    assert.equal(result.sources[0].title, undefined, 'non-string title must be dropped')
    assert.equal(result.sources[0].snippet, undefined, 'non-string content must be dropped')
  } finally { restore() }
})

test('robustness: 调用方取消 → 拒绝并保留 abort 语义', async () => {
  const { ctx, providers } = makeCtx()
  ENTRY.apply(ctx, { url: 'http://127.0.0.1:8080/search?format=json' })
  const real = globalThis.fetch
  globalThis.fetch = (url, init) => new Promise((resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(init.signal.reason ?? new Error('aborted')), { once: true })
  })
  try {
    const ac = new AbortController()
    const pending = providers[0].search({ query: 'x' }, ac.signal)
    ac.abort(new Error('caller cancelled'))
    await assert.rejects(() => pending, /custom web search aborted/)
  } finally { globalThis.fetch = real }
})

test('robustness: 超时 → abort 底层 fetch 并按超时消息拒绝，之后仍可继续搜索', async () => {
  const { ctx, providers } = makeCtx()
  ENTRY.apply(ctx, { url: 'http://127.0.0.1:8080/search?format=json', timeoutMs: 1000 })
  const real = globalThis.fetch
  globalThis.fetch = (url, init) => new Promise((resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(init.signal.reason ?? new Error('aborted')), { once: true })
  })
  let capturedSignal
  globalThis.fetch = (url, init) => new Promise((resolve, reject) => {
    capturedSignal = init.signal
    init.signal.addEventListener('abort', () => reject(init.signal.reason ?? new Error('aborted')), { once: true })
  })
  try {
    await assert.rejects(() => providers[0].search({ query: 'x' }, undefined), /timed out|timeout/i)
    // 超时必须走 abort 路径（而非仅拒绝 promise 后仍挂着 fetch），且 reason 是超时消息
    assert.equal(capturedSignal.aborted, true, 'timeout must abort the underlying fetch signal')
    assert.match(String(capturedSignal.reason && capturedSignal.reason.message), /timed out/i)
  } finally { globalThis.fetch = real }
  // 超时后状态不被污染：紧接着再搜一次仍能正常完成（cleanup 已清定时器/监听）
  const restore2 = stubJson({ results: [{ url: 'https://after-timeout.example' }] })
  try {
    const again = await providers[0].search({ query: 'after' }, undefined)
    assert.equal(again.sources.length, 1, 'a search after a timeout must still work')
  } finally { restore2() }
})
