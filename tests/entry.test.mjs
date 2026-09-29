/**
 * entry.test.mjs — dsh 0.1.7-rc.1 适配守护测试（真实入口 + 声明面 + 键集合一致性）。
 *
 * 覆盖 dsh-plugin-audit 的盲区清单：
 *   1. 真实加载路径：直接 import('../src/index.js')（P0 级 import/顶层求值错误当场炸出）
 *   2. 声明面：version / exports / dsh.bundle.patch / dsh.client.platform + dsh.client.inject
 *   3. settings 命名空间来源（0.1.7 硬破坏）：Config 必须从模块导出，且 15 个字段
 *      全部 .volatile() —— 否则 dsh-settings 的 describe() 枚举不到入口、client 半
 *      whileServed 永不注册、插件页无配置入口（静默失效）
 *   4. volatile 活引用：apply 收到的 volatile 字段是 {get()} 引用，provider 每次
 *      现读（设置卡保存经 _commitVolatile 原地提交，不重启 fiber）
 *   5. 展示策略：自带卡片的插件必须 configure({ auto: false }, fiber) 关闭自动页
 *   6. engines 判定表：dsh.engines.dsh 与 peerDependencies 里的 dsh / dsh-settings
 *      区间必须真的覆盖 0.1.7-rc.1（npm semver 预发布同元组规则），内置手写比较器
 *      + 反证 + 与宿主真实 semver.satisfies 逐行交叉验证
 *   7. 键集合一致性：host Config 键 === client FIELD_KEYS === client FIELD_VIEWS
 *      === cordis.patch.yml 里的 config 键（四处不等 = 静默调不到 / 静默丢配置）
 *   8. 0.1.7 客户端契约：settingsScope / settings.plugin.item / generator 形态
 *      一律不得复活（静态断言，防回退）
 *   9. 依赖卫生：无安装期脚本、无运行时依赖
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
const hostSource = readFileSync(join(root, 'src', 'index.js'), 'utf8')
const patchSource = readFileSync(join(root, 'cordis.patch.yml'), 'utf8')

/** 去掉注释后的代码文本：注释里提到旧 API 名称不算「回退到旧契约」。 */
function code(text) {
  return String(text)
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:\w])\/\/[^\n]*/g, '$1')
}

const ENTRY = await import('../src/index.js')

/** schema 解析出的默认配置：0.1.7 起 volatile 字段是 {get()} 活引用，逐字段解引用。 */
function configDefaults() {
  const out = {}
  for (const [key, value] of Object.entries(ENTRY.Config())) {
    out[key] = value !== null && typeof value === 'object' && typeof value.get === 'function' ? value.get() : value
  }
  return out
}

const CONFIG_KEYS = [
  'api', 'url', 'apiKey', 'maxResults', 'method', 'body', 'headers', 'authHeader', 'authScheme',
  'timeoutMs', 'resultsPath', 'urlField', 'titleField', 'snippetField', 'publishedField',
]

// ---------------------------------------------------------------------------
// 1. 真实入口加载（第三/四路测试盲区的封堵）
// ---------------------------------------------------------------------------

function makeCtx() {
  const providers = []
  const configureCalls = []
  const ctx = {
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    fiber: { name: 'web-search-custom' },
    effect(fn) { const d = fn(); return typeof d === 'function' ? d : () => {} },
    on() { return () => {} },
    // 0.1.7 宿主语义：settings 服务晚到也回调；子上下文自带 effect（configure 的
    // disposer 必须交给 effect 回收，官方示例同款）
    inject(services, cb) {
      cb({
        effect(fn) { const d = fn(); return typeof d === 'function' ? d : () => {} },
        settings: {
          configure(presentation, owner) {
            configureCalls.push({ presentation, owner })
            return () => {}
          },
        },
      })
      return ctx
    },
    web: { registerSearchProvider(provider) { providers.push(provider); return () => {} } },
  }
  return { ctx, providers, configureCalls }
}

test('entry: src/index.js 真实加载路径 + 导出面', () => {
  assert.equal(typeof ENTRY.apply, 'function')
  assert.equal(ENTRY.name, 'web-search-custom')
  assert.equal(ENTRY.SEARCH_PROVIDER_ID, 'custom')
  assert.equal(ENTRY.WEB_SEARCH_CUSTOM_SETTINGS_NAMESPACE, 'web-search-custom')
  assert.equal(typeof ENTRY.Config, 'function')
  assert.deepEqual([...ENTRY.inject], ['web'])
  // apply 必须同步（Cordis 红线：await 后注册 effect 会抛 Invalid effect）
  const { ctx, providers } = makeCtx()
  const ret = ENTRY.apply(ctx, { url: 'http://127.0.0.1:8080/search?format=json' })
  assert.equal(ret, undefined)
  assert.equal(providers.length, 1)
})

test('settings: 命名空间 === cordis 行 id（0.1.7 起 ns 就是行 id）', () => {
  assert.equal(ENTRY.WEB_SEARCH_CUSTOM_SETTINGS_NAMESPACE, ENTRY.name)
  const block = /- insert:\n    - id: ([A-Za-z][A-Za-z0-9-]*)/.exec(patchSource)
  assert.ok(block !== null, 'cordis.patch.yml must declare an insert id')
  assert.equal(block[1], ENTRY.WEB_SEARCH_CUSTOM_SETTINGS_NAMESPACE,
    'settings namespace must equal the cordis row id (host looks the entry up by id)')
})

test('settings: 宿主不再有 installSection —— 静态断言防回退', () => {
  const hostCode = code(hostSource)
  assert.equal(/\.installSection\s*\(/.test(hostCode), false, 'host half must not call settings.installSection()')
  assert.equal(/setSource\s*[:(]/.test(hostCode), false, 'host half must not use the removed setSource hook')
  assert.equal(/ctx\.inject\(\['settings'\]/.test(hostCode), true, 'settings wiring must stay behind ctx.inject')
  assert.equal(/settings\.configure\(\{ auto: false \}/.test(hostCode), true, 'must register the {auto:false} presentation policy')
})

test('settings: 自带卡片 → configure({ auto: false }, fiber) 关闭宿主自动页', () => {
  const { ctx, configureCalls } = makeCtx()
  ENTRY.apply(ctx, { url: 'http://127.0.0.1:8080/search?format=json' })
  assert.equal(configureCalls.length, 1, 'exactly one configure call')
  assert.deepEqual(configureCalls[0].presentation, { auto: false })
  assert.equal(configureCalls[0].owner, ctx.fiber, 'owner must be this plugin fiber')
})

// ---------------------------------------------------------------------------
// 2. settings 命名空间来源：Config 导出 + 全量 volatile
// ---------------------------------------------------------------------------

test('settings: Config 导出且 15 个字段全部 .volatile()', () => {
  const dict = ENTRY.Config.dict ?? {}
  const keys = Object.keys(dict).sort()
  assert.deepEqual(keys, [...CONFIG_KEYS].sort(), 'Config keys')
  for (const key of keys) {
    // volatileForm(schema) 按 meta.volatile 选字段；不声明 = 该字段不可热编辑
    assert.equal(dict[key].meta?.volatile, true, key + ' must declare .volatile()')
  }
  // 整段可编辑才让设置卡一次保存覆盖全部字段
  assert.equal(Object.keys(dict).length, CONFIG_KEYS.length)
})

test('settings: volatile {get()} 活引用 —— provider 每次现读（设置卡保存即生效）', async () => {
  const live = { url: 'http://127.0.0.1:8080/search?format=json' }
  const { ctx, providers } = makeCtx()
  // 模拟 0.1.7 宿主交到 apply 手里的形状：volatile 字段是活引用，普通字段是裸值
  ENTRY.apply(ctx, {
    api: 'generic',
    url: { get: () => live.url },
    timeoutMs: { get: () => 30000 },
  })
  const realFetch = globalThis.fetch
  const calls = []
  globalThis.fetch = async (url) => { calls.push(String(url)); return { ok: true, status: 200, json: async () => ({ results: [] }) } }
  try {
    await providers[0].search({ query: 'before' }, undefined)
    live.url = 'http://elsewhere:9000/search?format=json'
    await providers[0].search({ query: 'after' }, undefined)
    assert.ok(calls[0].startsWith('http://127.0.0.1:8080/'), 'first search uses the live value')
    assert.ok(calls[1].startsWith('http://elsewhere:9000/'), 'search must read volatile fields live, not the apply-time snapshot')
  } finally {
    globalThis.fetch = realFetch
  }
})

test('settings: 普通（非 volatile）配置形状同样可用 —— 新旧宿主兼容', async () => {
  const { ctx, providers } = makeCtx()
  ENTRY.apply(ctx, { api: 'generic', url: 'http://127.0.0.1:8080/search?format=json' })
  const realFetch = globalThis.fetch
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ results: [] }) })
  try {
    const result = await providers[0].search({ query: 'x' }, undefined)
    assert.deepEqual(result, { sources: [], truncated: false })
  } finally { globalThis.fetch = realFetch }
})

// ---------------------------------------------------------------------------
// 3. 声明面
// ---------------------------------------------------------------------------

test('manifest: version / exports / bundle / client 平台与模块图依赖', () => {
  assert.equal(pkg.version, '0.3.0')
  assert.equal(pkg.main, 'src/index.js')
  assert.equal(pkg.exports['.'], './src/index.js')
  assert.equal(pkg.exports['./client'], './lib/client.js')
  assert.equal(pkg.dsh.bundle.patch, './cordis.patch.yml')
  assert.equal(pkg.dsh.client.platform, 'web')
  // 0.1.7：client 半消费 configForms（dsh-client-ui-settings）、slots（renderer）、
  // locale —— 包名进 dsh.client.inject，保证它们的 client bundle 先行加载。
  const graph = pkg.dsh.client.inject ?? []
  for (const name of [
    '@deepseek-ai/dsh-client-locale',
    '@deepseek-ai/dsh-client-ui-renderer',
    '@deepseek-ai/dsh-client-ui-settings',
    '@deepseek-ai/dsh-client-ui-plugin-manager',
  ]) {
    assert.ok(graph.includes(name), 'dsh.client.inject must contain ' + name)
  }
  for (const f of ['src', 'lib', 'tests', 'cordis.patch.yml', 'README.md', 'LICENSE']) {
    assert.ok(pkg.files.includes(f), 'files must ship ' + f)
  }
})

// ---------------------------------------------------------------------------
// 4. engines 判定表（内置手写比较器，不引 semver 依赖）
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

/** 把 '~X.Y.Z' 展开成 '>=X.Y.Z <X.(Y+1).0'（只支持本仓库用到的一种写法）。 */
function expandTilde(range) {
  const m = /^~\s*(\d+)\.(\d+)\.(\d+)$/.exec(String(range).trim())
  if (m === null) return range
  return '>=' + m[1] + '.' + m[2] + '.' + m[3] + ' <' + m[1] + '.' + (Number(m[2]) + 1) + '.0'
}

const DECLARED = pkg.dsh.engines.dsh
const PEER_DSH = pkg.peerDependencies['@deepseek-ai/dsh']
const PEER_SETTINGS = pkg.peerDependencies['@deepseek-ai/dsh-settings']
const OLD_RANGE = '>=0.1.2-alpha.3 <0.2.0'

// 判定表（左：版本；右：是否被声明区间覆盖）
// 此表建模**严格模式**（pnpm 安装期，默认选项）——预发布只被区间内含同元组预发布者覆盖，
// 所以上界自身的预发布（0.1.8-rc.1 / 0.1.9-alpha.1）在此列为 false。
// 注意宿主闸用的是 includePrerelease:true，那一列会放行它们；差异见 host-integration.test.mjs。
const DECISION_TABLE = [
  ['0.1.2-alpha.3', true],
  ['0.1.2-rc.1', true],
  ['0.1.3', true],
  ['0.1.4', true],
  ['0.1.5-alpha.1', true],
  ['0.1.5-rc.1', true],
  ['0.1.5', true],
  ['0.1.6', true],
  ['0.1.7-alpha.0', true],
  ['0.1.7-rc.1', true],
  ['0.1.7', true],
  // 0.2.0 适配轮（2026-09-29）：宿主实测 0.2.0-rc.1，新区间必须放行 0.2.x 全系。
  // 上一轮这里断言 0.2.0 === false（当时未验证，故意拦住），本轮已验证 → 有意翻转。
  ['0.2.0-alpha.0', true],
  ['0.2.0-rc.1', true],
  ['0.2.0', true],
  ['0.2.3', true],
  ['0.1.8-rc.1', false],
  ['0.1.8', false],
  ['0.1.9-alpha.1', false],
  ['0.3.0', false],
]

test('engines: 判定表逐行命中 dsh.engines.dsh 与 peerDependencies 区间', () => {
  for (const [version, expected] of DECISION_TABLE) {
    const why = 'dsh.engines.dsh must ' + (expected ? 'cover ' : 'exclude ') + version
    assert.equal(satisfies(version, DECLARED), expected, why)
    assert.equal(satisfies(version, PEER_DSH), expected, 'peer @deepseek-ai/dsh: ' + why)
    assert.equal(satisfies(version, PEER_SETTINGS), expected, 'peer @deepseek-ai/dsh-settings: ' + why)
  }
  // 声称适配的宿主版本必须真的被覆盖
  assert.equal(satisfies('0.1.7-rc.1', DECLARED), true, 'declared adaptation target must be covered by its own range')
  assert.equal(satisfies('0.2.0-rc.1', DECLARED), true, 'the 0.2.0-rc.1 adaptation target must be covered by its own range')
  // 兼容闸（dsh-app-boot 的 evaluatePluginCompatibility）**只**遍历 peerDependencies 里
  // @deepseek-ai/dsh* 的条目，**从不读 dsh.engines.dsh**（全树 grep 零消费者）。
  // 两者必须逐字一致：peer 决定生死，engines 只影响 pnpm 安装期。
  assert.equal(PEER_DSH, DECLARED, 'peer @deepseek-ai/dsh 必须与 dsh.engines.dsh 逐字一致（闸只认 peer）')
  assert.equal(PEER_SETTINGS, DECLARED, 'peer @deepseek-ai/dsh-settings 必须与 dsh.engines.dsh 逐字一致')
})

test('engines: 反证——旧区间覆盖不了 0.1.7-rc.1（这正是两轮修复的缺陷）', () => {
  assert.equal(satisfies('0.1.7-rc.1', OLD_RANGE), false)
  assert.equal(satisfies('0.1.5-rc.1', OLD_RANGE), false)
  assert.equal(satisfies('0.1.2-rc.1', OLD_RANGE), true)
  assert.notEqual(DECLARED, OLD_RANGE)
})

test('engines: 反证——旧三段区间覆盖不了 0.2.0-rc.1（故新段非冗余声明）', () => {
  // 真机证据：未加新段时宿主启动闸打印 `skipping profile bundle "dsh-web-search-custom"`，
  // 整个 bundle 不加载。
  const OLD_THREE_CLAUSE = '>=0.1.2-alpha.3 <0.1.8 || >=0.1.5-alpha.1 <0.1.6 || >=0.1.7-alpha.0 <0.1.8'
  assert.equal(satisfies('0.2.0-rc.1', OLD_THREE_CLAUSE), false)
  assert.equal(satisfies('0.2.0-rc.1', DECLARED), true)
})

/** 宿主自带 semver：从插件 devDep 副本解析 @deepseek-ai/dsh，再以它为根 require。 */
function loadHostSemver() {
  for (const name of ['@deepseek-ai/dsh', '@deepseek-ai/cordis']) {
    try {
      const dir = dirname(createRequire(import.meta.url).resolve(name + '/package.json'))
      return createRequire(join(dir, 'package.json'))('semver')
    } catch { /* try next */ }
  }
  return undefined
}

test('engines: 与宿主真实 semver.satisfies 逐行交叉验证', () => {
  const semver = loadHostSemver()
  if (semver === undefined) {
    console.log('SKIP: host semver not resolvable (run pnpm install) — hand-rolled comparator assertions still ran')
    return
  }
  let crossChecked = 0
  for (const [version, expected] of DECISION_TABLE) {
    assert.equal(semver.satisfies(version, DECLARED), expected, 'host semver disagrees for ' + version)
    assert.equal(semver.satisfies(version, PEER_DSH), expected, 'host semver disagrees for peer dsh at ' + version)
    assert.equal(semver.satisfies(version, PEER_SETTINGS), expected, 'host semver disagrees for peer dsh-settings at ' + version)
    assert.equal(semver.satisfies(version, OLD_RANGE), satisfies(version, OLD_RANGE), 'comparator drift at ' + version)
    crossChecked += 1
  }
  assert.ok(crossChecked > 0)
})

// ---------------------------------------------------------------------------
// 5. 键集合一致性（host schema ↔ client 表单 ↔ 行级字段视图 ↔ 补丁 config）
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

test('keys: client 词典覆盖全部 label/hint 键（含 SettingsForm 框架文案）', () => {
  const zhBlock = extract(clientSource, /const zh = \{([\s\S]*?)\n    \};/, 'zh dict')[1]
  const enBlock = extract(clientSource, /const en = \{([\s\S]*?)\n    \};/, 'en dict')[1]
  const zhKeys = [...zhBlock.matchAll(/"([A-Za-z.]+)":/g)].map((m) => m[1]).sort()
  const enKeys = [...enBlock.matchAll(/"([A-Za-z.]+)":/g)].map((m) => m[1]).sort()
  assert.deepEqual(enKeys, zhKeys, 'zh/en dictionaries must cover the same key set')
  const viewsBlock = extract(clientSource, /const FIELD_VIEWS = \[([\s\S]*?)\n    \];/, 'FIELD_VIEWS')[1]
  for (const [, key] of viewsBlock.matchAll(/key: "([A-Za-z][A-Za-z0-9]*)"/g)) {
    assert.ok(zhKeys.includes('field.' + key), 'zh dict must define field.' + key)
  }
  for (const [, key] of viewsBlock.matchAll(/hintKey: "([A-Za-z.]+)"/g)) {
    assert.ok(zhKeys.includes(key), 'zh dict must define ' + key)
  }
  // SettingsForm 需要的框架文案（官方卡同款键）
  for (const key of ['unavailable', 'readOnly', 'saveFailed', 'save', 'saving']) {
    assert.ok(zhKeys.includes(key), 'zh dict must define ' + key)
  }
})

test('keys: cordis.patch.yml 的值 === host Config 默认值（补丁层与 schema 不漂移）', () => {
  const defaults = configDefaults()
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
  const defaults = configDefaults()
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
// 6. 0.1.7 客户端契约静态守护（防回退到已移除的 API）
// ---------------------------------------------------------------------------

test('client: 已移除的契约一个都不许复活', () => {
  const clientCode = code(clientSource)
  assert.equal(/ctx\.settingsScope/.test(clientCode), false, 'settingsScope service was removed in 0.1.7')
  assert.equal(/["']settings\.plugin\.item["']/.test(clientCode), false, 'that slot was removed in 0.1.7')
  assert.equal(/installSettingsSection/.test(clientCode), false)
  assert.equal(/function\s*\*/.test(clientCode), false, '0.1.7 slots.inject takes a disposer-returning function, not a generator')
  assert.match(clientCode, /ctx\.configForms\.get\(NS\)/, 'must bind through configForms.get(ns)')
  assert.match(clientCode, /configForms\.whileServed\(\[NS\]/, 'must gate registration on whileServed')
  assert.match(clientCode, /slots\.inject\("plugins\.item",\s*\(\) =>/, 'callback must return the registration disposer')
  assert.match(clientCode, /id: NS/, 'plugins.item entry id must be the host row id')
  assert.match(clientCode, /props\.view === "summary"/, 'must render the framework summary view')
  assert.equal(/exports\.inject = inject/.test(clientCode), true)
})

test('client: inject 为短服务名，模块图依赖走 package.json', () => {
  const m = /const inject = \[([^\]]*)\]/.exec(clientSource)
  assert.ok(m !== null, 'client must declare inject')
  const services = [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1])
  assert.deepEqual(services, ['slots', 'locale', 'configForms'])
  for (const name of services) {
    assert.equal(name.includes('@'), false, 'exports.inject must use short service names, not package names')
  }
})

// ---------------------------------------------------------------------------
// 7. 依赖卫生
// ---------------------------------------------------------------------------

test('hygiene: 无安装期脚本、无运行时依赖', () => {
  const scripts = pkg.scripts ?? {}
  for (const forbidden of ['preinstall', 'install', 'postinstall', 'prepare', 'prepublishOnly']) {
    assert.equal(scripts[forbidden], undefined, 'must not declare a ' + forbidden + ' script')
  }
  assert.deepEqual(Object.keys(pkg.dependencies ?? {}), [], 'runtime dependencies must stay empty (peers only)')
  assert.ok(pkg.peerDependencies['@deepseek-ai/dsh'])
  assert.ok(pkg.peerDependencies['@deepseek-ai/dsh-settings'])
  // .volatile() 是 schemastery 3.18.4 新增 API；区间必须排掉 3.18.2（3.18.2 无 .volatile，
  // 真实加载会当场 TypeError）。'~X.Y.Z' 展开为 '>=X.Y.Z <X.(Y+1).0' 后复用同一比较器。
  const schemasteryRange = expandTilde(pkg.peerDependencies['@deepseek-ai/schemastery'])
  assert.equal(satisfies('3.18.2', schemasteryRange), false)
  assert.equal(satisfies('3.18.4', schemasteryRange), true)
  assert.equal(satisfies('3.19.0', schemasteryRange), false)
})

// ---------------------------------------------------------------------------
// 8. 健壮性（第 5 轮复核固化：极端输入 / 取消 / 超时）
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
