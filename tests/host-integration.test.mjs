/**
 * host-integration.test.mjs —— 真宿主对象契约测试（不是自造桩）。
 *
 * 用 dsh 0.1.5-rc.1 的真实包（@deepseek-ai/cordis + dsh-web + dsh-settings-file）
 * 驱动本插件，封堵 dsh-plugin-audit 的「契约形状盲区」：
 *   1. 真实 Cordis Context 上 apply 合法（同步 apply、effect 注册被宿主接受）
 *   2. provider 真注册进 WebRuntime.searchProviders，真实 ctx.web.search() 全链路走通
 *   3. 真实文件型 settings provider：命名空间被 serve，文档提交后 search 立刻读到新值
 *   4. 真实 provider 选择语义（configured id / 未注册 / 不可用）
 *   5. seam 的 capSources 兜底（超量结果被截断并置 truncated）
 *
 * 依赖解析：插件自身 node_modules（开发依赖，与宿主同版本）→ 宿主安装目录；
 * 解析不到时显式 skip 并打印原因（不假绿）。
 *
 * 运行：node --test tests/host-integration.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

const { apply, SEARCH_PROVIDER_ID } = await import('../src/index.js')

const HOST_PKG = '/usr/lib/node_modules/@deepseek-ai/dsh/package.json'

/** 解析包的安装目录：插件开发依赖优先，其次宿主安装目录。 */
function resolveDepDir(name) {
  for (const from of [import.meta.url, HOST_PKG]) {
    try {
      return dirname(createRequire(from).resolve(name + '/package.json'))
    } catch { /* try next */ }
  }
  return undefined
}

/** 按包自身 exports/main 解析 ESM 入口并真实 import（不猜文件布局）。 */
async function loadDep(name) {
  const dir = resolveDepDir(name)
  if (dir === undefined) return undefined
  const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
  const entry = manifest.exports?.['.']
  const rel = typeof entry === 'string'
    ? entry
    : (entry?.import ?? entry?.default ?? manifest.module ?? manifest.main)
  return import(pathToFileURL(join(dir, rel)).href)
}

const DEP_NAMES = ['@deepseek-ai/cordis', '@deepseek-ai/dsh-web', '@deepseek-ai/dsh-settings-file']
const missing = DEP_NAMES.filter((name) => resolveDepDir(name) === undefined)

test('host-contract: 真实 dsh 依赖可解析（否则显式 skip，不假绿）', (t) => {
  if (missing.length > 0) return t.skip('unresolvable host deps: ' + missing.join(', '))
  assert.deepEqual(missing, [])
})

/** 搭真实宿主：真实 Context + 真实 WebRuntime + 真实文件型 SettingsProvider。 */
async function makeHost(webConfig) {
  const [{ Context }, { WebRuntime }, { FileSettingsProvider }] = await Promise.all([
    loadDep('@deepseek-ai/cordis'),
    loadDep('@deepseek-ai/dsh-web'),
    loadDep('@deepseek-ai/dsh-settings-file'),
  ])
  const dir = mkdtempSync(join(tmpdir(), 'dsh-wsc-'))
  const root = new Context()
  const store = new FileSettingsProvider(root, { path: join(dir, 'settings.yaml'), watch: false })
  const web = new WebRuntime(root, webConfig ?? {})
  const ctx = root.extend({ settings: store, web })
  return {
    ctx, web, store, dir,
    /** 宿主 effect 在 microtask 落地：等一拍再断言注册表。 */
    settle: () => new Promise((resolve) => setTimeout(resolve, 10)),
    cleanup() { try { rmSync(dir, { recursive: true, force: true }) } catch { /* best effort */ } },
  }
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

test('host-contract: 真实 Cordis + WebRuntime + 文件型 settings 下 apply 全链路', async (t) => {
  if (missing.length > 0) return t.skip('host deps unavailable: ' + missing.join(', '))
  const host = await makeHost()
  try {
    apply(host.ctx, { url: 'http://127.0.0.1:18080/search?format=json' })
    await host.settle()
    // 真注册表里有我们的 provider
    assert.deepEqual([...host.web.searchProviders.keys()], [SEARCH_PROVIDER_ID])
    assert.equal(host.web.searchProviders.get(SEARCH_PROVIDER_ID).available(), true)
    // 宿主真的 serve 了这个命名空间（设置卡能挂到「插件配置」页的前提）
    assert.ok(host.store.describe().map((d) => d.ns).includes('web-search-custom'),
      'host must serve the namespace: ' + JSON.stringify(host.store.describe().map((d) => d.ns)))
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
  } finally { host.cleanup() }
})

test('host-contract: 真实文档提交后 search 立刻读到新值（活引用，非 apply 快照）', async (t) => {
  if (missing.length > 0) return t.skip('host deps unavailable: ' + missing.join(', '))
  const host = await makeHost()
  try {
    apply(host.ctx, { url: 'http://127.0.0.1:18080/search?format=json' })
    await host.settle()
    await host.store.update('web-search-custom', { url: 'http://127.0.0.1:19090/search?format=json' })
    const calls = []
    const restore = stubFetch(calls, SAMPLE)
    try {
      const result = await host.web.search({ query: 'x' })
      assert.ok(calls[0].startsWith('http://127.0.0.1:19090/'), 'live source must win: ' + calls[0])
      assert.equal(result.sources.length, 2)
    } finally { restore() }
  } finally { host.cleanup() }
})

test('host-contract: 真实选择语义——唯一可用 / 未注册 / 不可用', async (t) => {
  if (missing.length > 0) return t.skip('host deps unavailable: ' + missing.join(', '))

  // 未配置 + 唯一可用 provider → 选中我们（不抛 = 被选中）
  const unique = await makeHost()
  try {
    apply(unique.ctx, { url: 'http://127.0.0.1:18080/search?format=json' })
    await unique.settle()
    const calls = []
    const restore = stubFetch(calls, SAMPLE)
    try { await unique.web.search({ query: 'ok' }) } finally { restore() }
  } finally { unique.cleanup() }

  // configured id 未注册 → WEB_PROVIDER_CONFIGURED_MISSING
  const gone = await makeHost({ searchProvider: 'nope' })
  try {
    apply(gone.ctx, { url: 'http://127.0.0.1:18080/search?format=json' })
    await gone.settle()
    await assert.rejects(() => gone.web.search({ query: 'x' }),
      (error) => error.code === 'WEB_PROVIDER_CONFIGURED_MISSING')
  } finally { gone.cleanup() }

  // configured id 是我们但不可用（url 为空）→ WEB_PROVIDER_CONFIGURED_UNAVAILABLE
  const unusable = await makeHost({ searchProvider: SEARCH_PROVIDER_ID })
  try {
    apply(unusable.ctx, { url: '' })
    await unusable.settle()
    await assert.rejects(() => unusable.web.search({ query: 'x' }),
      (error) => error.code === 'WEB_PROVIDER_CONFIGURED_UNAVAILABLE')
  } finally { unusable.cleanup() }
})
