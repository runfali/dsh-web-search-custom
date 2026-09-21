/**
 * live-settings-parity.mjs —— 可选的双臂活体对照（默认跳过，需显式开启）。
 *
 *   DSH_WSC_LIVE_PARITY=1 node tests/live-settings-parity.mjs
 *
 * 用真宿主（真 Cordis + 真 WebRuntime + 真文件型 settings provider）跑两臂，只差
 * settings 文档里的 url，其余完全一致：
 *   A 臂：url = 旧内网 SearXNG（历史上被用户层钉住的值）—— 用于证明「用户层 url 决定实际
 *         请求」以及该端点当前的可用性；
 *   B 臂：url = 出厂默认 AnySearch —— 证明新默认真的能拿到结果。
 * 之所以单列成 opt-in 脚本而不是 *.test.mjs：两条臂都要打真实网络（外网 + 内网），
 * 而默认套件必须能在无网络环境下离线跑绿（同 live-search.mjs 的约定）。
 */
import { createRequire } from 'node:module'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

if (process.env.DSH_WSC_LIVE_PARITY !== '1') {
  console.log('SKIP live-settings-parity: set DSH_WSC_LIVE_PARITY=1 to run the two-arm live check')
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

const DEAD_URL = process.env.DSH_WSC_PARITY_OLD_URL ?? 'http://10.200.0.5:8080/search?format=json&q={query}'
const LIVE_URL = process.env.DSH_WSC_PARITY_NEW_URL ?? 'https://api.anysearch.com/v1/search'

/** 一臂：真宿主 + 用户层 url 覆盖；记录实际请求的 URL，同时真发网络。 */
async function runArm(label, userUrl) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-wsc-parity-'))
  const root = new Context()
  const store = new FileSettingsProvider(root, { path: join(dir, 'settings.yaml'), watch: false })
  const web = new WebRuntime(root, {})
  const ctx = root.extend({ settings: store, web })
  apply(ctx, {})
  await new Promise((resolve) => setTimeout(resolve, 20))
  await store.update('web-search-custom', { url: userUrl })

  const hits = []
  const realFetch = globalThis.fetch
  globalThis.fetch = async (url, init) => { hits.push(String(url)); return realFetch(url, init) }
  let out
  try {
    const res = await web.search({ query: 'deepseek harness', maxResults: 5 })
    out = { requested: hits[0], sources: res.sources.length, first: res.sources[0]?.url ?? null }
  } catch (error) {
    out = { requested: hits[0], sources: 0, error: String(error.message).slice(0, 120) }
  } finally {
    globalThis.fetch = realFetch
    rmSync(dir, { recursive: true, force: true })
  }
  console.log(label.padEnd(30), JSON.stringify(out))
  return out
}

const dead = await runArm('user-layer url (legacy)', DEAD_URL)
const live = await runArm('AnySearch new default', LIVE_URL)

let failed = false
if (!String(dead.requested).startsWith(new URL(DEAD_URL).origin + '/')) {
  console.error('FAIL: the user-layer url must be the one that is used, got ' + dead.requested)
  failed = true
}
if (dead.sources !== 0) {
  console.error('FAIL: the legacy endpoint was expected to yield no sources, got ' + dead.sources)
  failed = true
}
if (!String(live.requested).startsWith('https://api.anysearch.com/')) {
  console.error('FAIL: the live arm must hit AnySearch, got ' + live.requested)
  failed = true
}
if (live.sources === 0) {
  console.error('FAIL: AnySearch returned no sources: ' + JSON.stringify(live))
  failed = true
}
if (failed) process.exit(1)
console.log('PARITY OK: user layer decides the request; the AnySearch default yields real sources')
