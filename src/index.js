/**
 * dsh-web-search-custom — 搜索 provider（ctx.web 能力缝），出厂默认接 AnySearch。
 *
 * 两档策略（api 字段：auto | anysearch | generic）：
 * - anysearch：AnySearch 专用档（POST https://api.anysearch.com/v1/search）。
 *   带 apiKey → Authorization: Bearer；不带 → 匿名免费档（完全不发鉴权头）。
 * - generic：通用 JSON 档（GET/POST 模板 + 字段映射），SearXNG 等端点照旧可用。
 *
 * - Host 侧：导出 volatile Config —— 声明即设置命名空间（ns = cordis 行 id
 *   'web-search-custom'）；浏览器侧（lib/client.js）在「插件」页注册同名设置卡。
 * - 除 dsh 平台自带的 @deepseek-ai/dsh-settings / @deepseek-ai/schemastery 外
 * 无任何第三方依赖；不改 dsh 源码。
 *
 * dsh 0.1.7-rc.1 契约（本仓库适配轮，宿主源码级核对）：
 * - settings.installSection() 已移除；dsh-settings 的 describe() 直接枚举「active
 *   且含 volatile 字段的 Config」的入口，ns = cordis 行 id —— Config 声明即命名空间。
 * - 可热编辑字段必须 .volatile()：volatile-only 变更经 loader _commitVolatile
 *   原地提交（不重启 fiber），apply 收到的对应字段是 {get()} 活引用。
 * - 自带卡片的插件按 dsh-settings README 的配方注册展示策略
 *   settings.configure({ auto: false }, fiber)，关闭宿主按 schema 自动生成的页面。
 */
import z from '@deepseek-ai/schemastery'

/** Cordis 插件短名（路由/日志用）。 */
export const name = 'web-search-custom'

/** 本 provider 在 ctx.web 搜索注册表中的稳定 id。 */
export const SEARCH_PROVIDER_ID = 'custom'

/** Settings 命名空间（浏览器卡片与 host 共用同一字符串）。
 * 0.1.7 起命名空间就是 cordis 行 id（本插件 = 'web-search-custom'，与
 * cordis.patch.yml 的 insert id 一致）；Config 导出即声明命名空间。 */
export const WEB_SEARCH_CUSTOM_SETTINGS_NAMESPACE = 'web-search-custom'

/** 读取配置字段：0.1.7 起 volatile 字段经 apply 收到的是 {get()} 活引用
 * （cosmokit createVolatile 协议），普通字段是裸值。统一在此解引用，
 * 新旧宿主形状都兼容。 */
function readField(value) {
  if (value !== null && typeof value === 'object' && typeof value.get === 'function' && !Array.isArray(value)) {
    return value.get()
  }
  return value
}

/** 把整块配置逐字段解引用（volatile 活引用 → 当前值）。 */
function readConfig(config) {
  if (config === null || config === undefined) return {}
  const out = {}
  for (const [key, value] of Object.entries(config)) out[key] = readField(value)
  return out
}

export const DEFAULT_TIMEOUT_MS = 30000

/** 出厂默认端点：AnySearch 统一搜索入口（免 key 匿名档即可用）。 */
export const DEFAULT_URL = 'https://api.anysearch.com/v1/search'

/** 出厂默认结果上限（AnySearch 单次请求允许 1–10）。 */
export const DEFAULT_MAX_RESULTS = 10

/** AnySearch 单次请求的结果上限（厂商文档：max_results 1–10）。 */
export const ANYSEARCH_MAX_RESULTS_CAP = 10

/** AnySearch 官方主机（auto 档判定用；子域一并命中）。 */
export const ANYSEARCH_HOSTS = ['anysearch.com', 'www.anysearch.com', 'api.anysearch.com']

/** 需要 web 能力缝已就绪再 apply。 */
export const inject = ['web']

/** 设置命名空间的字段模式（也是设置卡渲染/校验的依据）。
 * 0.1.7 起：Config 必须从模块导出（cordis runtime.Config）——dsh-settings 的
 * describe() 按「entry 有 volatileForm(schema)」枚举命名空间，未导出 = 宿主看不到
 * 本命名空间 = client 半 whileServed 永不注册（插件页无配置入口）。
 * 15 个字段全部 .volatile()：整段配置可在设置卡热编辑，改动经 _commitVolatile
 * 原地提交、不重启 fiber（schema 其余约束仍逐字段校验）。 */
export const Config = z.object({
  api: z.string().default('auto').volatile(),
  url: z.string().default(DEFAULT_URL).volatile(),
  apiKey: z.string().default('').volatile(),
  maxResults: z.number().step(1).default(DEFAULT_MAX_RESULTS).volatile(),
  method: z.string().default('GET').volatile(),
  body: z.string().default('{"query":"{query}"}').volatile(),
  headers: z.string().default('{}').volatile(),
  authHeader: z.string().default('Authorization').volatile(),
  authScheme: z.string().default('Bearer').volatile(),
  timeoutMs: z.number().step(1).min(1000).default(DEFAULT_TIMEOUT_MS).volatile(),
  resultsPath: z.string().default('results').volatile(),
  urlField: z.string().default('url').volatile(),
  titleField: z.string().default('title').volatile(),
  snippetField: z.string().default('content').volatile(),
  publishedField: z.string().default('publishedDate').volatile()
})

function toInt(value, fallback) {
  const n = Number(value)
  return Number.isFinite(n) ? Math.trunc(n) : fallback
}

/** headers 字段在设置里是 JSON 字符串；兼容直接传对象的写法。 */
function parseHeaders(headers) {
  if (headers === null || headers === undefined) return {}
  if (typeof headers === 'object') return headers
  const text = String(headers).trim()
  if (text === '') return {}
  try {
    const parsed = JSON.parse(text)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

/** 解析当前生效的 provider 选项（设置层 + 环境变量覆盖）。
 * config 里 volatile 字段是 {get()} 活引用，先逐字段解引用再取值。 */
function resolveOptions(rawConfig) {
  const env = process.env
  const config = readConfig(rawConfig)
  const method = String(config.method || 'GET').toUpperCase()
  return {
    api: env.WEB_SEARCH_CUSTOM_API || config.api || 'auto',
    url: env.WEB_SEARCH_CUSTOM_URL || config.url || '',
    apiKey: env.WEB_SEARCH_CUSTOM_API_KEY || config.apiKey || '',
    maxResults: toInt(env.WEB_SEARCH_CUSTOM_MAX_RESULTS, config.maxResults ?? DEFAULT_MAX_RESULTS),
    method: method === 'POST' ? 'POST' : 'GET',
    body: config.body || '{"query":"{query}"}',
    headers: parseHeaders(env.WEB_SEARCH_CUSTOM_HEADERS || config.headers),
    authHeader: config.authHeader || 'Authorization',
    authScheme: config.authScheme ?? 'Bearer',
    timeoutMs: toInt(env.WEB_SEARCH_CUSTOM_TIMEOUT_MS, config.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    resultsPath: config.resultsPath || 'results',
    urlField: config.urlField || 'url',
    titleField: config.titleField || 'title',
    snippetField: config.snippetField || 'content',
    publishedField: config.publishedField || 'publishedDate'
  }
}

/** 取 URL 模板的主机名：先剥掉 {占位符}（模板化主机名也能判定），解析失败返回空串。 */
function hostOf(urlTemplate) {
  const staticPart = String(urlTemplate || '').replace(/\{\w+\}/g, 'x').split('?')[0]
  try {
    return new URL(staticPart).hostname.toLowerCase()
  } catch {
    return ''
  }
}

/** 主机是否属于 AnySearch（含子域）。 */
function isAnySearchHost(host) {
  if (!host) return false
  return ANYSEARCH_HOSTS.includes(host) || host.endsWith('.anysearch.com')
}

/** 决定本次请求走哪一档：显式 anysearch/generic 优先，auto 按主机名判定。 */
function resolveApi(options) {
  const wanted = String(options.api || 'auto').trim().toLowerCase()
  if (wanted === 'anysearch') return 'anysearch'
  if (wanted === 'generic') return 'generic'
  return isAnySearchHost(hostOf(options.url)) ? 'anysearch' : 'generic'
}

/** 把模板里的 {query}（已编码）/ {queryRaw}（未编码）/ {apiKey} 换值；未知占位符原样保留。 */
function fillTemplate(template, values) {
  return template.replace(/\{(\w+)\}/g, (match, key) =>
    Object.prototype.hasOwnProperty.call(values, key) ? values[key] : match
  )
}

/** 模板占位符取值表：{query} 语义不变（已编码），{queryRaw} 为原始查询串。 */
function templateValues(request, options) {
  return {
    query: encodeURIComponent(request.query),
    queryRaw: request.query,
    apiKey: encodeURIComponent(options.apiKey || ''),
    apiKeyRaw: options.apiKey || ''
  }
}

/** 构造最终请求 URL：模板优先；GET 且无 {query} 时自动补 q= 参数。 */
function buildUrl(raw, values, appendQuery) {
  let urlString = fillTemplate(raw, values)
  if (appendQuery) {
    const url = new URL(urlString)
    url.searchParams.set('q', values.queryRaw)
    urlString = url.toString()
  }
  return urlString
}

/** 组合请求头：accept + 用户 headers + 可选的 Authorization。
 * keyAlreadyEmbedded=true 时（URL/body 里已带 {apiKey}）不再重复发鉴权头。 */
function buildHeaders(options, keyAlreadyEmbedded, method) {
  const headers = { accept: 'application/json' }
  for (const [name, value] of Object.entries(options.headers)) headers[name] = String(value)
  if ((method || options.method) === 'POST') headers['content-type'] = 'application/json'
  if (options.apiKey && !keyAlreadyEmbedded) {
    headers[options.authHeader] = options.authScheme
      ? options.authScheme + ' ' + options.apiKey
      : options.apiKey
  }
  return headers
}

function decodeEntities(input) {
  const named = {
    amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
    hellip: '…', mdash: '—', ndash: '–',
    lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”'
  }
  return input.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (match, body) => {
    if (body[0] === '#') {
      const isHex = body[1] === 'x' || body[1] === 'X'
      const code = isHex ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10)
      if (Number.isInteger(code) && code >= 0 && code <= 0x10FFFF) {
        try { return String.fromCodePoint(code) } catch { /* keep original */ }
      }
    }
    const value = named[body]
    return value === undefined ? match : value
  })
}

/** 去掉 HTML 标签、折叠空白（SearXNG 的 title/content 常带 HTML）。 */
function cleanText(value) {
  return decodeEntities(String(value))
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** 按点路径取值，例如 "data.results"。 */
function getPath(object, path) {
  if (!path) return object
  let current = object
  for (const key of path.split('.')) {
    if (current === null || current === undefined || typeof current !== 'object') return undefined
    current = current[key]
  }
  return current
}

/** 取 item 上第一个非空字符串字段（非对象条目一律视为无字段）。 */
function firstString(item, keys) {
  if (item === null || item === undefined || typeof item !== 'object') return ''
  for (const key of keys) {
    const value = item[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return ''
}

/** 校验并归一化一条结果的 URL（只接受 http/https；非法返回空串）。 */
function normalizeUrl(value) {
  if (typeof value !== 'string' || value.trim() === '') return ''
  const url = value.trim()
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return ''
  } catch {
    return ''
  }
  return url
}

/** 把任意 JSON 结果数组映射为 web 缝的 WebSearchSource[]（按 url 去重；非对象条目直接跳过）。 */
function mapResults(payload, options) {
  const list = getPath(payload, options.resultsPath)
  const seen = new Set()
  const sources = []
  if (Array.isArray(list)) {
    for (const item of list) {
      if (item === null || item === undefined || typeof item !== 'object' || Array.isArray(item)) {
        continue
      }
      const url = normalizeUrl(firstString(item, [options.urlField, 'url', 'link']))
      if (!url || seen.has(url)) continue
      seen.add(url)
      const source = { url }
      const title = firstString(item, [options.titleField, 'title', 'name'])
      if (title) source.title = cleanText(title)
      const snippet = firstString(item, [options.snippetField, 'content', 'snippet', 'description', 'text'])
      if (snippet) source.snippet = cleanText(snippet)
      const published = firstString(item, [options.publishedField, 'publishedDate', 'publishedAt', 'pubdate', 'date'])
      if (published) source.publishedAt = published
      sources.push(source)
    }
  }
  return { sources, truncated: false }
}

/** AnySearch 单次请求的 max_results：取「配置值、调用方上限」较小者，再夹进 1..10。 */
function anysearchMaxResults(options, callerMax) {
  const configured = toInt(options.maxResults, DEFAULT_MAX_RESULTS)
  const caller = toInt(callerMax, configured)
  return Math.max(1, Math.min(ANYSEARCH_MAX_RESULTS_CAP, Math.min(configured, caller)))
}

/**
 * 脱敏厂商错误文案：402 会自动回吐「自动生成的凭据」（username/password/api_key），
 * 这类字段一律不进入错误消息（错误消息会进会话记录/日志）。
 */
function redactCredentials(text) {
  let out = String(text)
  for (const key of ['api_key', 'password', 'username', 'secret', 'token']) {
    out = out.replace(new RegExp(key + '\\s*=\\s*\\S+', 'gi'), key + '=<redacted>')
  }
  out = out.replace(/(sk-|ak-)[A-Za-z0-9_-]{6,}/g, '<redacted-key>')
  return out
}

/** 把非成功响应（HTTP != 2xx 或业务 code !== 0）归一化成带处置提示的错误。 */
function anysearchError(status, envelope) {
  const source = envelope && typeof envelope === 'object' ? envelope : {}
  const detail = firstString(source, ['message', 'error'])
  const requestId = firstString(source, ['request_id'])
  const code = typeof source.code === 'number' ? source.code : undefined
  const parts = ['AnySearch search failed: HTTP ' + status + (code !== undefined && code !== 0 ? ' (code ' + code + ')' : '')]
  if (detail) parts.push(redactCredentials(detail))
  if (requestId) parts.push('request_id=' + requestId)
  if (status === 401 || status === 403) {
    parts.push('check the "apiKey" setting for the web-search-custom plugin (or clear it to use the anonymous free tier)')
  } else if (status === 402) {
    parts.push('anonymous daily free quota exhausted: set an "apiKey" in the web-search-custom settings (the key/credentials in the response were redacted and NOT stored)')
  } else if (status === 429) {
    parts.push('rate limited: retry later or set an "apiKey" in the web-search-custom settings')
  } else if (status === 400 || status === 502) {
    parts.push('check the request settings (tag/params/zone/language are forwarded as-is in the POST body)')
  }
  return new Error(parts.join(' '))
}

/** 把 AnySearch 信封映射成 web 缝结果：data.results[].{title,url,snippet|content}。 */
function mapAnySearchResults(payload) {
  const envelope = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {}
  const results = getPath(envelope, 'data.results')
  const seen = new Set()
  const sources = []
  if (Array.isArray(results)) {
    for (const item of results) {
      if (item === null || item === undefined || typeof item !== 'object' || Array.isArray(item)) continue
      const url = normalizeUrl(item.url)
      if (!url || seen.has(url)) continue
      seen.add(url)
      const source = { url }
      const title = typeof item.title === 'string' ? item.title.trim() : ''
      if (title) source.title = cleanText(title)
      const snippet = firstString(item, ['snippet', 'content'])
      if (snippet) source.snippet = cleanText(snippet)
      sources.push(source)
    }
  }
  return { sources, truncated: false }
}

/** 合并调用方取消信号与本插件超时，返回 signal + 清理函数。 */
function withTimeout(signal, timeoutMs) {
  const controller = new AbortController()
  const onAbort = () => controller.abort(signal && signal.reason !== undefined ? signal.reason : new Error('web search aborted'))
  if (signal && signal.aborted === true) {
    onAbort()
  } else {
    signal && signal.addEventListener('abort', onAbort, { once: true })
  }
  const timer = setTimeout(() => controller.abort(new Error('search timed out after ' + timeoutMs + ' ms')), timeoutMs)
  timer.unref && timer.unref()
  return {
    signal: controller.signal,
    cleanup() {
      clearTimeout(timer)
      if (signal) signal.removeEventListener('abort', onAbort)
    }
  }
}

/** 发一次请求并把网络层错误归一化（保持既有文案与 abort 语义）。 */
async function dispatch(target, init, callSignal, callerSignal) {
  try {
    return await fetch(target, { ...init, signal: callSignal })
  } catch (error) {
    if (callerSignal && callerSignal.aborted === true) {
      throw new Error('custom web search aborted', { cause: error })
    }
    if (callSignal.aborted) {
      const reason = callSignal.reason
      throw new Error(reason instanceof Error ? reason.message : 'search timed out', { cause: error })
    }
    throw new Error('custom web search request failed: ' + String(error), { cause: error })
  }
}

/** 解析响应 JSON；不可解析时抛带 HTTP 状态的消息（与既有文案一致）。 */
async function readJson(response) {
  try {
    return await response.json()
  } catch (error) {
    throw new Error('search API returned unparseable JSON (HTTP ' + response.status + ')', { cause: error })
  }
}

/** generic 档：模板化 GET/POST + 字段映射（SearXNG 等端点，行为与既有版本一致）。 */
async function searchGeneric(options, request, callSignal, callerSignal) {
  const values = templateValues(request, options)
  const keyAlreadyEmbedded =
    options.url.includes('{apiKey}') ||
    (options.method === 'POST' && options.body.includes('{apiKey}'))
  const appendQuery = options.method === 'GET' && !options.url.includes('{query}')
  const url = buildUrl(options.url, values, appendQuery)
  const headers = buildHeaders(options, keyAlreadyEmbedded)
  const body = options.method === 'POST' ? fillTemplate(options.body, values) : undefined

  const response = await dispatch(url, {
    method: options.method,
    headers,
    ...(body !== undefined ? { body } : {})
  }, callSignal, callerSignal)

  const payload = await readJson(response)
  if (!response.ok) {
    const detail = payload && (payload.error || payload.message)
    throw new Error('search API returned HTTP ' + response.status + (detail ? ': ' + detail : ''))
  }
  return mapResults(payload, options)
}

/** anysearch 档：厂商信封 POST，带 key 走鉴权配额、不带 key 走匿名免费档。 */
async function searchAnySearch(options, request, callSignal, callerSignal) {
  const keyAlreadyEmbedded = options.url.includes('{apiKey}')
  const url = buildUrl(options.url, templateValues(request, options), false)
  const headers = buildHeaders(options, keyAlreadyEmbedded, 'POST')
  const body = JSON.stringify({
    query: request.query,
    max_results: anysearchMaxResults(options, request.maxResults)
  })

  const response = await dispatch(url, { method: 'POST', headers, body }, callSignal, callerSignal)
  const payload = await readJson(response)
  const code = payload && typeof payload === 'object' && typeof payload.code === 'number' ? payload.code : undefined

  if (!response.ok || (code !== undefined && code !== 0)) {
    throw anysearchError(response.status, payload)
  }
  return mapAnySearchResults(payload)
}

/**
 * Cordis apply：声明设置命名空间，并构造搜索 provider 注册到 ctx.web。
 * @param {object} ctx - cordis 上下文（已注入 web）。
 * @param {object} config - web-search-custom 行配置（volatile 字段为 {get()} 活引用）。
 */
export function apply(ctx, config = {}) {
  // 0.1.7 起不再有 installSection：导出的 Config 即命名空间（ns = 行 id）。
  // 本插件自带设置卡（client 半注册进插件页 plugins.item 槽位），故按 dsh-settings
  // README 的配方关闭宿主按 schema 自动生成的默认页（configure 的 disposer 交给
  // effect 回收；owner 显式传本插件 fiber 与官方示例一致）。
  ctx.inject(['settings'], (sctx) => {
    sctx.effect(() => sctx.settings.configure({ auto: false }, ctx.fiber))
  })

  // config 本身即活引用容器：volatile 字段经 readConfig/readField 每次现读，
  // 设置卡保存（_commitVolatile 原地提交）后无需订阅即生效。
  const current = () => config

  ctx.web.registerSearchProvider({
    id: SEARCH_PROVIDER_ID,

    /** 廉价本地可用性检查（不得发网络请求）。 */
    available() {
      const options = resolveOptions(current())
      if (!options.url || options.timeoutMs <= 0) return false
      try {
        const url = new URL(fillTemplate(options.url, { query: 'x', apiKey: 'x', queryRaw: 'x' }))
        return url.protocol === 'http:' || url.protocol === 'https:'
      } catch {
        return false
      }
    },

    /** 执行一次搜索（按 api 档分派）。 */
    async search(request, signal) {
      const options = resolveOptions(current())
      const timeout = withTimeout(signal, options.timeoutMs)
      try {
        if (resolveApi(options) === 'anysearch') {
          return await searchAnySearch(options, request, timeout.signal, signal)
        }
        return await searchGeneric(options, request, timeout.signal, signal)
      } finally {
        timeout.cleanup()
      }
    }
  })
}

