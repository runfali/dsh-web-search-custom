/**
 * live-search.mjs —— 选真端点的活体全链路（默认跳过，需显式开启）。
 *
 *   DSH_WSC_LIVE_URL='http://<searxng>/search?format=json&q={query}' node tests/live-search.mjs
 *
 * 走真实 Cordis + 真实 WebRuntime + 真实文件型 settings provider，打真实搜索端点，
 * 验证「插件 → seam → 网络 → 结果映射」全链路在 dsh 0.1.5-rc.1 上可用。
 * 默认（无 env）直接退出并打印 SKIP，避免把内网依赖写进常规测试。
 */
import { createRequire } from 'node:module'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

const URL_TEMPLATE = process.env.DSH_WSC_LIVE_URL
if (!URL_TEMPLATE) {
  console.log('SKIP live-search: set DSH_WSC_LIVE_URL to run the live end-to-end check')
  process.exit(0)
}

const HOST_PKG = '/usr/lib/node_modules/@deepseek-ai/dsh/package.json'
function resolveDepDir(name) {
  for (const from of [import.meta.url, HOST_PKG]) {
    try { return dirname(createRequire(from).resolve(name + '/package.json')) } catch { /* next */ }
  }
  return undefined
}
async function loadDep(name) {
  const dir = resolveDepDir(name)
  const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
  const entry = manifest.exports?.['.']
  const rel = typeof entry === 'string' ? entry : (entry?.import ?? entry?.default ?? manifest.module ?? manifest.main)
  return import(pathToFileURL(join(dir, rel)).href)
}

const [{ Context }, { WebRuntime }, { FileSettingsProvider }] = await Promise.all([
  loadDep('@deepseek-ai/cordis'), loadDep('@deepseek-ai/dsh-web'), loadDep('@deepseek-ai/dsh-settings-file'),
])
const { apply } = await import('../src/index.js')

const dir = mkdtempSync(join(tmpdir(), 'dsh-wsc-live-'))
const root = new Context()
const store = new FileSettingsProvider(root, { path: join(dir, 'settings.yaml'), watch: false })
const web = new WebRuntime(root, {})
const ctx = root.extend({ settings: store, web })
apply(ctx, { url: URL_TEMPLATE })
await new Promise((resolve) => setTimeout(resolve, 10))

const query = process.argv[2] ?? 'deepseek harness'
const result = await web.search({ query, maxResults: 5 })
console.log('query =', query)
console.log('sources =', result.sources.length, 'truncated =', result.truncated)
for (const source of result.sources.slice(0, 3)) {
  console.log(' -', source.url, '|', source.title)
}
if (result.sources.length === 0) { console.error('LIVE FAIL: no sources returned'); process.exit(1) }
if (result.sources.some((s) => !/^https?:\/\//.test(s.url))) { console.error('LIVE FAIL: non-http source URL'); process.exit(1) }
console.log('LIVE OK')

/**
 * 可选负路径：DSH_WSC_LIVE_BAD_KEY=1 时用无效 key 再搜一次，
 * 断言错误消息走厂商信封（HTTP 401 + message + request_id）且带处置提示。
 */
if (process.env.DSH_WSC_LIVE_BAD_KEY === '1') {
  const { Context } = await loadDep('@deepseek-ai/cordis')
  const { WebRuntime } = await loadDep('@deepseek-ai/dsh-web')
  const { FileSettingsProvider } = await loadDep('@deepseek-ai/dsh-settings-file')
  const dir2 = mkdtempSync(join(tmpdir(), 'dsh-wsc-live-bad-'))
  const root2 = new Context()
  const store2 = new FileSettingsProvider(root2, { path: join(dir2, 'settings.yaml'), watch: false })
  const web2 = new WebRuntime(root2, {})
  const ctx2 = root2.extend({ settings: store2, web: web2 })
  apply(ctx2, { url: URL_TEMPLATE, apiKey: 'sk-definitely-invalid-key' })
  await new Promise((resolve) => setTimeout(resolve, 10))
  try {
    await web2.search({ query: 'auth path probe', maxResults: 1 })
    console.error('LIVE FAIL: invalid key unexpectedly succeeded')
    process.exit(1)
  } catch (error) {
    const message = String(error && error.message)
    console.log('bad-key error =', message.slice(0, 200))
    if (!/HTTP 40[13]/.test(message) || !/request_id=/.test(message) || !/apiKey/.test(message)) {
      console.error('LIVE FAIL: unrecognized error envelope:', message)
      process.exit(1)
    }
    console.log('LIVE BAD-KEY OK (401/403 envelope + request_id + hint)')
  } finally {
    rmSync(dir2, { recursive: true, force: true })
  }
}
rmSync(dir, { recursive: true, force: true })
