import { test } from 'node:test'
import assert from 'node:assert/strict'

const ENTRY = await import('../src/index.js')
const { apply, Config } = ENTRY

const ANYSEARCH_URL = 'https://api.anysearch.com/v1/search'

/** HTTP 头名大小写不敏感：按小写查值。 */
function headerValue(headers, name) {
  const wanted = String(name).toLowerCase()
  const key = Object.keys(headers || {}).find((k) => k.toLowerCase() === wanted)
  return key === undefined ? undefined : headers[key]
}

function makeCtx() {
  const providers = []
  const ctx = {
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    effect(fn) { const d = fn(); return typeof d === 'function' ? d : () => {} },
    on() { return () => {} },
    inject(services, cb) {
      cb({ settings: { installSection() {} } })
      return ctx
    },
    web: { registerSearchProvider(provider) { providers.push(provider); return () => {} } },
  }
  return { ctx, providers }
}

/** 打桩 fetch：记录调用，返回给定 JSON 信封。 */
function stubJson(payload, ok = true, status = 200) {
  const calls = []
  const real = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init })
    return { ok, status, json: async () => payload }
  }
  return { calls, restore() { globalThis.fetch = real } }
}

function provider(config) {
  const { ctx, providers } = makeCtx()
  apply(ctx, config)
  return providers[0]
}

// ---------------------------------------------------------------------------
// 1. 档位判定与请求形状
// ---------------------------------------------------------------------------

test('anysearch: auto 档按 URL 主机名判定，发 POST + 厂商信封，query 不做 URL 编码', async () => {
  const p = provider({ url: ANYSEARCH_URL, apiKey: '', maxResults: 10 })
  const { calls, restore } = stubJson({ code: 0, message: 'success', data: { results: [] } })
  try {
    await p.search({ query: 'Go 1.26 release notes' })
  } finally { restore() }
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, ANYSEARCH_URL, 'anysearch 档必须 POST 到配置的 URL，不追加查询参数')
  assert.equal(calls[0].init.method, 'POST')
  assert.equal(headerValue(calls[0].init.headers, 'content-type'), 'application/json')
  assert.deepEqual(JSON.parse(calls[0].init.body), { query: 'Go 1.26 release notes', max_results: 10 },
    'body 必须是原始 query（不得出现 %20 编码）')
})

test('anysearch: 不带 key → 完全不发 Authorization（匿名档）', async () => {
  const p = provider({ url: ANYSEARCH_URL, apiKey: '', maxResults: 5 })
  const { calls, restore } = stubJson({ code: 0, data: { results: [] } })
  try { await p.search({ query: 'x' }) } finally { restore() }
  const names = Object.keys(calls[0].init.headers).map((n) => n.toLowerCase())
  assert.ok(!names.includes('authorization'), '匿名请求不得带 Authorization: ' + JSON.stringify(calls[0].init.headers))
})

test('anysearch: 带 key → Authorization: Bearer <key>', async () => {
  const p = provider({ url: ANYSEARCH_URL, apiKey: 'sk-abc', maxResults: 5 })
  const { calls, restore } = stubJson({ code: 0, data: { results: [] } })
  try { await p.search({ query: 'x' }) } finally { restore() }
  assert.equal(headerValue(calls[0].init.headers, 'authorization'), 'Bearer sk-abc')
})

test('anysearch: key 中的 {apiKey} 占位与自定义 headers 仍然生效', async () => {
  const p = provider({ url: ANYSEARCH_URL, apiKey: 'k1', headers: '{"X-Trace":"t1"}', maxResults: 5 })
  const { calls, restore } = stubJson({ code: 0, data: { results: [] } })
  try { await p.search({ query: 'x' }) } finally { restore() }
  assert.equal(headerValue(calls[0].init.headers, 'x-trace'), 't1')
  assert.equal(headerValue(calls[0].init.headers, 'authorization'), 'Bearer k1')
})

test('anysearch: api 字段可显式指定（自建镜像 URL 也走 anysearch 档）', async () => {
  const p = provider({ api: 'anysearch', url: 'https://mirror.example/v1/search', apiKey: '', maxResults: 3 })
  const { calls, restore } = stubJson({ code: 0, data: { results: [] } })
  try { await p.search({ query: 'q' }) } finally { restore() }
  assert.equal(calls[0].init.method, 'POST')
  assert.deepEqual(JSON.parse(calls[0].init.body), { query: 'q', max_results: 3 })
})

// ---------------------------------------------------------------------------
// 2. max_results 计算
// ---------------------------------------------------------------------------

test('anysearch: max_results 取「配置值与调用方上限的较小者」，并夹在 1..10', async () => {
  const cases = [
    [{ maxResults: 10 }, 2, 2],
    [{ maxResults: 10 }, 50, 10],
    [{ maxResults: 3 }, 50, 3],
    [{ maxResults: 50 }, 20, 10],
    [{ maxResults: 0 }, 5, 1],
    [{ maxResults: 8 }, undefined, 8],
  ]
  for (const [config, caller, expected] of cases) {
    const p = provider({ url: ANYSEARCH_URL, apiKey: '', ...config })
    const { calls, restore } = stubJson({ code: 0, data: { results: [] } })
    try {
      await p.search({ query: 'q', ...(caller === undefined ? {} : { maxResults: caller }) })
    } finally { restore() }
    assert.equal(JSON.parse(calls[0].init.body).max_results, expected,
      JSON.stringify({ config, caller }) + ' → ' + expected)
  }
})

// ---------------------------------------------------------------------------
// 3. 响应映射（厂商信封）
// ---------------------------------------------------------------------------

test('anysearch: 映射 data.results[]，snippet 缺失回落 content，非法/重复 URL 丢弃', async () => {
  const p = provider({ url: ANYSEARCH_URL, apiKey: '', maxResults: 10 })
  const payload = {
    code: 0, message: 'success', request_id: 'r-1',
    data: {
      results: [
        { title: 'A', url: 'https://a.example/1', snippet: 'sa', content: 'ca' },
        { title: 'B', url: 'https://b.example/2', content: 'cb' },
        { title: '', url: 'https://c.example/3', snippet: 'sc' },
        { title: 'dup', url: 'https://a.example/1', snippet: 'dup' },
        { title: 'bad', url: 'file:///etc/passwd' },
        null,
      ],
      metadata: { total_results: 6, search_time_ms: 312 },
    },
  }
  const { restore } = stubJson(payload)
  let result
  try { result = await p.search({ query: 'q' }) } finally { restore() }
  assert.equal(result.truncated, false)
  assert.deepEqual(result.sources.map((s) => s.url), ['https://a.example/1', 'https://b.example/2', 'https://c.example/3'])
  assert.equal(result.sources[0].title, 'A')
  assert.equal(result.sources[0].snippet, 'sa')
  assert.equal(result.sources[1].snippet, 'cb', 'snippet 缺失时必须回落 content')
  assert.equal(result.sources[2].title, undefined, '空标题不得产出空串字段')
})

test('anysearch: 病态载荷降级为空 sources，不抛', async () => {
  for (const payload of [
    { code: 0, data: null },
    { code: 0, data: { results: null } },
    { data: { results: 'nope' } },
    'plain string',
    null,
  ]) {
    const p = provider({ url: ANYSEARCH_URL, apiKey: '', maxResults: 5 })
    const { restore } = stubJson(payload)
    try {
      assert.deepEqual(await p.search({ query: 'q' }), { sources: [], truncated: false },
        'payload=' + JSON.stringify(payload))
    } finally { restore() }
  }
})

// ---------------------------------------------------------------------------
// 4. 错误信封
// ---------------------------------------------------------------------------

test('anysearch: 401 抛错并带 message 与 request_id，提示去配置 key', async () => {
  const p = provider({ url: ANYSEARCH_URL, apiKey: 'bad', maxResults: 5 })
  const { restore } = stubJson({ code: -1, message: 'Invalid API key.', request_id: 'r-401' }, false, 401)
  try {
    await assert.rejects(() => p.search({ query: 'q' }), (error) => {
      assert.match(error.message, /HTTP 401/)
      assert.match(error.message, /Invalid API key\./)
      assert.match(error.message, /r-401/)
      assert.match(error.message, /apiKey/)
      return true
    })
  } finally { restore() }
})

test('anysearch: 402 的自动生成凭据不进入错误消息（脱敏）', async () => {
  const leaky = 'Your account and API key have been automatically generated. Use the API key below to continue.\nusername=u1\npassword=p1\napi_key=sk-secret-123'
  const p = provider({ url: ANYSEARCH_URL, apiKey: '', maxResults: 5 })
  const { restore } = stubJson({ code: -1, message: leaky, request_id: 'r-402' }, false, 402)
  try {
    await assert.rejects(() => p.search({ query: 'q' }), (error) => {
      assert.match(error.message, /HTTP 402/)
      assert.ok(!error.message.includes('sk-secret-123'), 'API key 不得出现在错误消息里')
      assert.ok(!error.message.includes('password=p1'), '密码不得出现在错误消息里')
      assert.match(error.message, /r-402/)
      return true
    })
  } finally { restore() }
})

test('anysearch: HTTP 200 但 code !== 0 也算失败', async () => {
  const p = provider({ url: ANYSEARCH_URL, apiKey: '', maxResults: 5 })
  const { restore } = stubJson({ code: -1, message: 'Invalid tag: nope.nothing.', request_id: 'r-bad' })
  try {
    await assert.rejects(() => p.search({ query: 'q' }), /Invalid tag: nope\.nothing\./)
  } finally { restore() }
})

// ---------------------------------------------------------------------------
// 5. generic 档不变 + 占位符
// ---------------------------------------------------------------------------

test('generic: explicit generic 档保持原语义（GET 自动补 q=，URL 编码）', async () => {
  const p = provider({ api: 'generic', url: 'http://127.0.0.1:8080/search?format=json', method: 'GET',
    resultsPath: 'results', urlField: 'url', titleField: 'title', snippetField: 'content', publishedField: 'publishedDate' })
  const { calls, restore } = stubJson({ results: [{ url: 'https://a.example', title: 'A', content: 'x' }] })
  let result
  try { result = await p.search({ query: 'hello world' }) } finally { restore() }
  assert.match(calls[0].url, /q=hello(%20|\+)world/, 'GET 缺 {query} 时自动补 q= 且仍做 URL 编码')
  assert.equal(result.sources.length, 1)
})

test('generic: {queryRaw} 提供未编码 query，{query} 语义不变', async () => {
  const p = provider({ api: 'generic', url: 'http://127.0.0.1:8080/search', method: 'POST',
    body: '{"q":"{queryRaw}","encoded":"{query}"}' })
  const { calls, restore } = stubJson({ results: [] })
  try { await p.search({ query: 'a b&c' }) } finally { restore() }
  const body = JSON.parse(calls[0].init.body)
  assert.equal(body.q, 'a b&c')
  assert.equal(body.encoded, 'a%20b%26c')
})

test('generic: 无 api 字段的非 AnySearch 端点仍按 generic 走（向后兼容）', async () => {
  const p = provider({ url: 'http://127.0.0.1:8080/search?format=json&q={query}' })
  const { calls, restore } = stubJson({ results: [] })
  try { await p.search({ query: 'x' }) } finally { restore() }
  assert.equal(calls[0].init.method, 'GET')
})

// ---------------------------------------------------------------------------
// 6. 默认值与可用性
// ---------------------------------------------------------------------------

test('defaults: 出厂默认指向 AnySearch，profile=auto，maxResults=10', () => {
  const defaults = Config()
  assert.equal(defaults.api, 'auto')
  assert.equal(defaults.url, ANYSEARCH_URL)
  assert.equal(defaults.maxResults, 10)
  assert.equal(defaults.apiKey, '', '默认匿名（免 key）')
})

test('available: anysearch 默认配置可用；空 url 不可用', () => {
  assert.equal(provider({ url: ANYSEARCH_URL }).available(), true)
  assert.equal(provider({ url: '' }).available(), false)
})

