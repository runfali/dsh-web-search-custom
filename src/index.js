/**
 * dsh-web-search-custom — 通用 JSON 搜索 provider（ctx.web 能力缝）。
 *
 * - Host 侧：注册 web-search-custom 设置命名空间（Settings 页面可填参数），
 *   并把 SearXNG 兼容的 JSON 搜索结果映射到 web 缝。
 * - 浏览器侧（lib/client.js）：在「设置 → 插件配置」里提供配置卡片。
 *
 * 除 dsh 平台自带的 @deepseek-ai/dsh-settings / @deepseek-ai/schemastery 外
 * 无任何第三方依赖；不改 dsh 源码。
 */
import z from '@deepseek-ai/schemastery'
// dsh 0.1.2-alpha.3：installSettingsSection/settingsNamespace 已从 dsh-settings 移除，
// 设置接线改用 provider 方法 settings.installSection(owner, ns, schema, entry, hooks)。

/** Cordis 插件短名（路由/日志用）。 */
export const name = 'web-search-custom'

/** 本 provider 在 ctx.web 搜索注册表中的稳定 id。 */
export const SEARCH_PROVIDER_ID = 'custom'

/** Settings 命名空间（浏览器卡片与 host 共用同一字符串）。
 * dsh 0.1.2-alpha 起 settingsNamespace() brand 辅助已移除；
 * 命名空间在 settings.register/installSection 处校验（小写连字符标识符）。 */
export const WEB_SEARCH_CUSTOM_SETTINGS_NAMESPACE = 'web-search-custom'

export const DEFAULT_TIMEOUT_MS = 30000

/** 需要 web 能力缝已就绪再 apply。 */
export const inject = ['web']

/** 设置命名空间的字段模式（也是 Settings 页面渲染/校验的依据）。 */
export const Config = z.object({
  url: z.string().default('http://127.0.0.1:8080/search?format=json&q={query}'),
  apiKey: z.string().default(''),
  method: z.string().default('GET'),
  body: z.string().default('{"query":"{query}"}'),
  headers: z.string().default('{}'),
  authHeader: z.string().default('Authorization'),
  authScheme: z.string().default('Bearer'),
  timeoutMs: z.number().step(1).min(1000).default(DEFAULT_TIMEOUT_MS),
  resultsPath: z.string().default('results'),
  urlField: z.string().default('url'),
  titleField: z.string().default('title'),
  snippetField: z.string().default('content'),
  publishedField: z.string().default('publishedDate')
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

/** 解析当前生效的 provider 选项（设置层 + 环境变量覆盖）。 */
function resolveOptions(config) {
  const env = process.env
  const method = String(config.method || 'GET').toUpperCase()
  return {
    url: env.WEB_SEARCH_CUSTOM_URL || config.url || '',
    apiKey: env.WEB_SEARCH_CUSTOM_API_KEY || config.apiKey || '',
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

/** 把模板里的 {query}/{apiKey} 换成已编码值；未知占位符原样保留。 */
function fillTemplate(template, values) {
  return template.replace(/\{(\w+)\}/g, (match, key) =>
    Object.prototype.hasOwnProperty.call(values, key) ? values[key] : match
  )
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

/** 组合请求头：accept + 用户 headers + 可选的 Authorization。 */
function buildHeaders(options, keyAlreadyEmbedded) {
  const headers = { accept: 'application/json' }
  for (const [name, value] of Object.entries(options.headers)) headers[name] = String(value)
  if (options.method === 'POST') headers['content-type'] = 'application/json'
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

/** 取 item 上第一个非空字段。 */
function firstString(item, keys) {
  for (const key of keys) {
    const value = item[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return ''
}

/** 把任意 JSON 结果数组映射为 web 缝的 WebSearchSource[]（按 url 去重）。 */
function mapResults(payload, options) {
  const list = getPath(payload, options.resultsPath)
  const seen = new Set()
  const sources = []
  if (Array.isArray(list)) {
    for (const item of list) {
      const url = firstString(item, [options.urlField, 'url', 'link'])
      if (!url || seen.has(url)) continue
      try {
        const parsed = new URL(url)
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') continue
      } catch {
        continue
      }
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

/**
 * Cordis apply：注册设置命名空间，并构造搜索 provider 注册到 ctx.web。
 * @param {object} ctx - cordis 上下文（已注入 web）。
 * @param {object} config - web-search-custom 行配置（作为设置的 composition base）。
 */
export function apply(ctx, config = {}) {
  let current = () => config
  // dsh 0.1.2-alpha.3：独立 installSettingsSection 帮助函数已从 dsh-settings 移除，
  // 同样的接线改为 provider 上的 settings.installSection(owner, ns, schema, entry, hooks)
  // （宿主源码级核对：register(base=entry) → setSource(scope.get) → 卸载回落 effect →
  // onChange() 同步首发 → scope.watch 持续通知）。settings 晚于本插件 apply 时到达，
  // current() 闭包天然兼容晚接线。
  ctx.inject(['settings'], (sctx) => {
    sctx.settings.installSection(ctx, WEB_SEARCH_CUSTOM_SETTINGS_NAMESPACE, Config, config, {
      setSource: (source) => {
        current = source
      },
      onChange: () => {
        // provider 每次搜索时读取 current()，无需主动刷新
      }
    })
  })

  ctx.web.registerSearchProvider({
    id: SEARCH_PROVIDER_ID,

    /** 廉价本地可用性检查（不得发网络请求）。 */
    available() {
      const options = resolveOptions(current())
      if (!options.url || options.timeoutMs <= 0) return false
      try {
        const url = new URL(fillTemplate(options.url, { query: 'x', apiKey: 'x' }))
        return url.protocol === 'http:' || url.protocol === 'https:'
      } catch {
        return false
      }
    },

    /** 执行一次搜索。 */
    async search(request, signal) {
      const options = resolveOptions(current())
      const values = {
        query: encodeURIComponent(request.query),
        queryRaw: request.query,
        apiKey: encodeURIComponent(options.apiKey || ''),
        apiKeyRaw: options.apiKey || ''
      }
      const keyAlreadyEmbedded =
        options.url.includes('{apiKey}') ||
        (options.method === 'POST' && options.body.includes('{apiKey}'))

      const appendQuery = options.method === 'GET' && !options.url.includes('{query}')
      const url = buildUrl(options.url, values, appendQuery)
      const headers = buildHeaders(options, keyAlreadyEmbedded)
      let body
      if (options.method === 'POST') body = fillTemplate(options.body, values)

      const timeout = withTimeout(signal, options.timeoutMs)
      let response
      try {
        response = await fetch(url, {
          method: options.method,
          headers,
          ...(body !== undefined ? { body } : {}),
          signal: timeout.signal
        })
      } catch (error) {
        if (signal && signal.aborted === true) {
          throw new Error('custom web search aborted', { cause: error })
        }
        if (timeout.signal.aborted) {
          const reason = timeout.signal.reason
          throw new Error(reason instanceof Error ? reason.message : 'search timed out', { cause: error })
        }
        throw new Error('custom web search request failed: ' + String(error), { cause: error })
      } finally {
        timeout.cleanup()
      }

      let payload
      try {
        payload = await response.json()
      } catch (error) {
        throw new Error('search API returned unparseable JSON (HTTP ' + response.status + ')', { cause: error })
      }

      if (!response.ok) {
        const detail = payload && (payload.error || payload.message)
        throw new Error('search API returned HTTP ' + response.status + (detail ? ': ' + detail : ''))
      }

      return mapResults(payload, options)
    }
  })
}
