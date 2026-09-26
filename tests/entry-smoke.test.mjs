/**
 * dsh-web-search-custom entry-smoke：真实加载 src/index.js（P0 防护）。
 * 直测宿主入口的 apply 驱动：
 *   1. 模块可加载（任何 import / 顶层求值错误当场炸出）
 *   2. web.registerSearchProvider 注册了 custom provider（id/available/search 形状）
 *   3. 0.1.7 settings 接线：ctx.inject(['settings']) 回调被驱动，且 configure({auto:false})
 *      的 disposer 交给 sub-ctx 的 effect 回收（installSection 已移除）
 *   4. provider.search 行为模拟：模板 URL 填充、GET 自动补 q=、映射去重
 *
 * 运行：node --test tests/*.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

const { apply, name, inject, SEARCH_PROVIDER_ID, WEB_SEARCH_CUSTOM_SETTINGS_NAMESPACE, Config } =
  await import('../src/index.js')

function makeCtx() {
  const providers = []
  const events = []
  const ctx = {
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    fiber: { name: 'web-search-custom' },
    effect(fn) {
      const d = fn()
      return typeof d === 'function' ? d : () => {}
    },
    on() { return () => {} },
    inject(services, cb) {
      // 模拟 settings 服务就绪（宿主语义：settings 晚到也回调）
      cb({
        effect(fn) {
          events.push('sub-effect')
          const d = fn()
          return typeof d === 'function' ? d : () => {}
        },
        settings: {
          configure(presentation, owner) {
            events.push({ configure: presentation, owner })
            return () => { events.push('configure-disposed') }
          },
        },
      })
      return ctx
    },
    web: {
      registerSearchProvider(provider) {
        providers.push(provider)
        return () => {}
      },
    },
  }
  return { ctx, providers, events }
}

test('entry: 模块可加载且契约常量正确', () => {
  assert.equal(name, 'web-search-custom')
  assert.equal(SEARCH_PROVIDER_ID, 'custom')
  assert.equal(WEB_SEARCH_CUSTOM_SETTINGS_NAMESPACE, 'web-search-custom')
  assert.equal(typeof Config, 'function')
  assert.ok(Array.isArray(inject)) // eslint 无此语义，仅防未定义
  assert.ok(typeof apply === 'function')
})

test('entry: apply 注册 custom 搜索 provider 并接线 settings', () => {
  const { ctx, providers, events } = makeCtx()
  apply(ctx, { api: 'generic', url: 'http://127.0.0.1:8080/search?format=json&q={query}' })
  assert.equal(providers.length, 1)
  const p = providers[0]
  assert.equal(p.id, 'custom')
  assert.equal(typeof p.available, 'function')
  assert.equal(typeof p.search, 'function')
  assert.equal(p.available(), true)
  // 0.1.7 settings 接线：configure({auto:false}, fiber) 在 sub-ctx 的 effect 里注册
  const configureEvents = events.filter((event) => typeof event === 'object')
  assert.equal(configureEvents.length, 1, 'exactly one configure call')
  assert.deepEqual(configureEvents[0], { configure: { auto: false }, owner: ctx.fiber })
})

test('behavior: available 拒绝非法配置（无 url / 非 http(s)）', () => {
  const { ctx, providers } = makeCtx()
  apply(ctx, { api: 'generic', url: '' })
  assert.equal(providers[0].available(), false)
  const { ctx: ctx2, providers: p2 } = makeCtx()
  apply(ctx2, { api: 'generic', url: 'gopher://x' })
  assert.equal(p2[0].available(), false)
})

test('behavior: search 默认 GET 自动补 q=，结果映射去重', async () => {
  const { ctx, providers } = makeCtx()
  apply(ctx, {
    api: 'generic',
    url: 'http://127.0.0.1:8080/search?format=json',
    resultsPath: 'results',
    urlField: 'url',
    titleField: 'title',
    snippetField: 'content',
    publishedField: 'publishedDate',
  })
  const p = providers[0]
  const calls = []
  const realFetch = globalThis.fetch
  globalThis.fetch = async (url, opts) => {
    calls.push({ url: String(url), opts })
    return {
      ok: true,
      status: 200,
      json: async () => ({
        results: [
          { url: 'https://a.com', title: '<b>A</b>', content: 'a&hellip;' },
          { url: 'https://a.com', title: 'dup', content: 'dup' },
          { url: 'file:///x', title: 'bad protocol', content: 'x' },
          { url: 'https://b.com', title: 'B', content: 'b', publishedDate: '2026-01-01' },
        ],
      }),
    }
  }
  try {
    const r = await p.search({ query: 'hello world' }, undefined)
    assert.ok(calls[0].url.includes('q='), 'GET without {query} must append q=')
    assert.ok(/\?format=json&q=hello(?:%20|\+)world/.test(calls[0].url), 'query value present (URL-encoded)')
    assert.equal(r.sources.length, 2) // 去重 + 非 http(s) 过滤
    assert.equal(r.sources[0].url, 'https://a.com')
    assert.equal(r.sources[0].title, 'A')
    assert.equal(r.sources[0].snippet, 'a…')
    assert.equal(r.sources[1].publishedAt, '2026-01-01')
    assert.equal(r.truncated, false)
  } finally {
    globalThis.fetch = realFetch
  }
})

test('behavior: search 遇 HTTP 错误抛状态', async () => {
  const { ctx, providers } = makeCtx()
  apply(ctx, { api: 'generic', url: 'http://127.0.0.1:8080/search?format=json' })
  const realFetch = globalThis.fetch
  globalThis.fetch = async () => ({ ok: false, status: 503, json: async () => ({ error: 'down' }) })
  try {
    await assert.rejects(() => providers[0].search({ query: 'x' }, undefined), /HTTP 503: down/)
  } finally {
    globalThis.fetch = realFetch
  }
})
