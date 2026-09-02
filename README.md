# dsh-web-search-custom

让 DeepSeek Harness 的 Web UI（`dsh --profile web`）使用**任意的 JSON 搜索 API**——只要提供一个 URL 和（可选的）API key，就能替换默认的 DeepSeek 搜索。默认配置直接可用自建 SearXNG：

```text
http://127.0.0.1:8080/search?format=json&q={query}
```

## 特性

- 标准 Cordis bundle 插件，零侵入、不修改 dsh 源码；卸载后即恢复官方 DeepSeek 搜索；
- 除 dsh 平台自带包（`@deepseek-ai/dsh-settings`、`@deepseek-ai/schemastery`）外无第三方依赖；
- 浏览器端自带配置卡片（**设置 → 插件配置**），URL / API key / 超时 / 字段映射全都可以直接在页面上填写；
- 支持 GET / POST、`Authorization` 鉴权、额外请求头以及结果字段映射；
- 兼容任何返回 SearXNG 风格 JSON（`results[]`）的接口。

## 环境要求

- DeepSeek Harness（dsh）**≥ 0.1.2-alpha.3**，以 `web` profile 运行（已在 0.1.2-alpha.4 实测）；
- Node.js `^22.19.0 || >=24.0.0`；
- 运行时依赖：**无**——`@deepseek-ai/dsh-settings`、`@deepseek-ai/schemastery`、`react` 三个 peer 全部由 dsh 宿主自身提供；插件仅访问你在设置页配置的搜索端点，无文件写、无子进程；
- 一个可用的 JSON 搜索接口（如自建 SearXNG 或其他兼容服务）。

## 安装

```bash
dsh plugin --profile web add dsh-web-search-custom
```

安装完成后重启 dsh Web 生效。

## 在设置页配置（推荐）

打开 Web UI 的 **设置 → 插件配置**，会看到「自定义搜索（web-search-custom）」卡片，展开后可直接填写：

- 搜索 URL（支持 `{query}` / `{apiKey}` 占位符）
- API Key（**可留空**；非空时默认以 `Authorization: Bearer` 发送）
- 请求方法、POST body 模板、额外请求头（JSON）、超时
- 结果字段映射（`resultsPath` / `urlField` / `titleField` / `snippetField` / `publishedField`）

保存后写回 `~/.dsh/settings.yaml` 的 `web-search-custom:` 段并热生效；「已覆盖 / 重置」状态与官方插件卡片一致。

## 配置项一览

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `url` | 本机 SearXNG | 搜索地址。支持 `{query}`、`{apiKey}` 占位符（自动 URL 编码）；GET 且不含 `{query}` 时自动补 `q=` 参数 |
| `apiKey` | 空 | 可选。非空时默认以 `Authorization: Bearer <key>` 发送；若 `url` 或 POST `body` 里已有 `{apiKey}` 则不再额外加头 |
| `method` | `GET` | `GET` 或 `POST` |
| `body` | `{"query":"{query}"}` | POST body 模板，支持 `{query}` / `{apiKey}` |
| `headers` | `{}` | 额外请求头，JSON 字符串 |
| `authHeader` | `Authorization` | apiKey 使用的请求头名 |
| `authScheme` | `Bearer` | 鉴权 scheme；填空字符串则裸发 key 值 |
| `timeoutMs` | `30000` | 单次请求超时 |
| `resultsPath` | `results` | JSON 中结果数组的点路径，如 `data.results` |
| `urlField` / `titleField` / `snippetField` / `publishedField` | `url` / `title` / `content` / `publishedDate` | 结果字段名映射（SearXNG 默认即 `content`、`publishedDate`） |

## 其他配置方式

### profile 用户补丁层（`~/.dsh/profiles/web/cordis.patch.yml`）

```yaml
- id: web-search-custom
  config:
    url: 'http://127.0.0.1:8080/search?format=json&q={query}'
    apiKey: ''
    method: GET
    body: '{"query":"{query}"}'
    headers: '{}'
    authHeader: Authorization
    authScheme: Bearer
    timeoutMs: 30000
    resultsPath: results
    urlField: url
    titleField: title
    snippetField: content
    publishedField: publishedDate
```

> 注意：补丁是整段替换 `config`，覆盖时要写全所有项。

### 环境变量（不改文件，优先级高于设置页配置）

| 变量 | 说明 |
| --- | --- |
| `WEB_SEARCH_CUSTOM_URL` | 覆盖搜索 URL |
| `WEB_SEARCH_CUSTOM_API_KEY` | 覆盖 API key（推荐用于含 secret 的场景） |
| `WEB_SEARCH_CUSTOM_HEADERS` | 额外请求头，JSON 字符串 |
| `WEB_SEARCH_CUSTOM_TIMEOUT_MS` | 超时毫秒数 |

## 卸载

```bash
dsh plugin --profile web remove dsh-web-search-custom
```

重启 dsh 后恢复自带的 DeepSeek 搜索。

## 限制

- `apiKey` 作为普通设置字段保存（`~/.dsh/settings.yaml`），不经过凭据系统；敏感环境建议用环境变量 `WEB_SEARCH_CUSTOM_API_KEY` 覆盖。
- 结果页大小由 SearXNG 服务端决定，客户端无法指定 `count`；工具层仍会按 `maxResults` 截断。

## 许可证

[MIT](LICENSE)
