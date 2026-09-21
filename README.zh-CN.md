# dsh-web-search-custom

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A522-green.svg)](package.json)
[![Platform](https://img.shields.io/badge/platform/DeepSeek%20Harness-orange)](https://deepseek.com)

[English](README.md) | 简体中文

让 [DeepSeek Harness (dsh)](https://github.com/deepseek-ai/deepseek-harness) 的
`web` profile 使用**任意 JSON 搜索 API**——只要提供一个 URL 和（可选的）API key，
就能替换内置的 DeepSeek 搜索。出厂默认指向
[AnySearch](https://www.anysearch.com/docs/api-endpoints) 统一搜索接口，**不填 key 也能直接用**：

```text
POST https://api.anysearch.com/v1/search    # apiKey 为空 → 匿名档，完全不发 Authorization 头
POST https://api.anysearch.com/v1/search    # apiKey 已填 → Authorization: Bearer <key>，走该 key 的配额
```

> [!IMPORTANT]
> **设计意图。** 本插件只是一个薄适配层：它在 `ctx.web` 能力缝后面注册一个搜索
> provider，再提供一个设置卡。它不带搜索引擎、不带索引、不带缓存；它发送的唯一凭据
> 就是你在卡片里填的（或用环境变量导出的）那一个，而**key 为空时连鉴权头都不发**。
> 卸载即恢复官方 provider，零残留。

---

## 目录

- [为什么](#为什么)
- [特性](#特性)
- [工作原理](#工作原理)
- [环境要求](#环境要求)
- [安装](#安装)
- [在设置页配置](#在设置页配置)
- [配置项一览](#配置项一览)
- [垂直检索](#垂直检索与参数化查询)
- [其他配置方式](#其他配置方式)
- [卸载](#卸载)
- [限制](#限制)
- [开发与测试](#开发与测试)
- [许可证](#许可证)

## 为什么

dsh 的 web profile 通过 `ctx.web` 能力缝解析搜索。开箱即用时该缝由一个托管搜索
后端服务——但对已经自建搜索栈（SearXNG、内网搜索网关、厂商 API）、希望查询不出内网、
或者想用自己那把自己的搜索 key 的场景，这个取舍并不合适。

本插件向这个缝里注册**一个额外的 provider**，并让你选中它。其余一切——`web_search`
工具、结果截断、取消、错误传播——都原样继续工作，因为它们走的是同一条缝。

## 特性

- **标准 dsh bundle 插件。** 零侵入：不改任何 dsh 源码；卸载后即恢复官方搜索
  provider。
- **零运行时依赖。** 只用 dsh 自带包（`@deepseek-ai/dsh-settings`、
  `@deepseek-ai/schemastery`，浏览器侧另有 React），不内置、不打包任何第三方副本。
- **出厂默认 AnySearch，免 key 开箱可用。** `api: auto` 识别 AnySearch 主机后走它的
  原生 POST 信封。`apiKey` 留空则请求**完全不发** `Authorization` 头（匿名档，按 IP
  限流的每日免费额度）；填了 key 就以 `Authorization: Bearer <key>` 发送、走该 key 的
  配额。key 无效会报明确错误，而不会静默回落匿名档。
- **SearXNG 等端点照样能用。** 把 `api` 切成 `generic` 即恢复模板化 GET/POST；
  出厂字段映射就是 SearXNG 的 `results[]` / `url` / `title` / `content` /
  `publishedDate` 形状。
- **设置页配置卡**（设置 → 插件配置）：档位、URL、API key、结果条数、超时、全套字段
  映射都能在页面上直接填写，「已覆盖 / 重置」状态与官方插件卡一致。

## 工作原理

```text
web_search 工具
      │
      ▼
ctx.web（能力缝）  ──选择──▶  provider id "custom"
      │                              │
      │                              ▼
      │                    fetch(你的端点)  ──▶  你的 JSON API
      │                              │
      └◀──── WebSearchResult { sources[], truncated } ◀──┘
```

Host 侧注册 `web-search-custom` 命名空间（设置页据此渲染卡片），并注册一个 id 稳定为
`custom` 的搜索 provider。provider 的 `search(query, signal)` **每次调用都现读**
当前设置值，选定档位，带调用方取消信号 + 自身超时发请求，再把 JSON 载荷映射成
`sources[]`（按 URL 去重、丢弃非 `http(s)` 条目、剥离 HTML、解码实体）。

| `api` | 请求 | 响应映射 | 生效字段 |
| --- | --- | --- | --- |
| `anysearch`（auto 判定） | `POST` `{"query","max_results"}`；**仅在填了 key 时**发 `Authorization: Bearer` | `data.results[].{title,url,snippet}`，snippet 缺失时回落 `content` | `url`、`apiKey`、`headers`、`timeoutMs`、`maxResults` |
| `generic` | 模板化 GET/POST（`{query}` 已 URL 编码、`{queryRaw}` 原样、`{apiKey}`） | `resultsPath` + `urlField` / `titleField` / `snippetField` / `publishedField` | 上面全部，外加 `method`、`body`、`authHeader`、`authScheme`、`resultsPath` 与四个字段名 |

HTTP 非 2xx 与业务 `code` 非 0 都算失败：错误文本保留厂商 `message` 与 `request_id`；
402 响应体里可能回吐的自动生成凭据会在进入日志或模型之前被**脱敏**。

provider 选择遵循能力缝自身的规则，且在调用时刻解析：配置了 id 就以它为准；未配置时
要求「恰好一个可用 provider」。因此插件自带的 `cordis.patch.yml` 同时写了
`web.searchProvider: custom`，把选择显式化而不是靠默认。

## 环境要求

| 项 | 值 |
|---|---|
| DeepSeek Harness | `>=0.1.2-alpha.3 <0.2.0 || >=0.1.5-alpha.1 <0.1.6`（已在 0.1.2-alpha.4、0.1.5-rc.1、0.1.5-rc.2 实测） |
| Node.js | `^22.19.0 || >=24.0.0` |
| 运行时依赖 | **无**——三个 peer 全部由 dsh 宿主自带 |
| 网络 | dsh 宿主到你所配置端点的出站访问（AnySearch 解析到其国内网关） |
| AnySearch API key | **可选**——匿名档不需要 |

dsh 区间声明在 `dsh.engines.dsh`（并在 `peerDependencies` 里镜像到插件依赖的 dsh 包）。
这个析取区间是**承重的、不是装饰**：npm semver 只让「区间内含同一
`[major, minor, patch]` 元组预发布」的分组满足预发布版本，所以单写 `<0.2.0` 的
分组**覆盖不了** `0.1.5-rc.1`。`tests/entry.test.mjs` 用判定表 + 对旧单区间的反证
把这条钉死。

## 安装

```bash
dsh plugin --profile web add dsh-web-search-custom
```

安装后重启 dsh web 实例。本地检出场景改为传目录路径。

## 在设置页配置

打开 Web UI 的 **设置 → 插件配置**，展开「自定义搜索（web-search-custom）」卡片：

- 接口档位（`auto` / `anysearch` / `generic`）；
- 搜索 URL（默认已是 AnySearch）；
- API Key —— **留空即免 key 匿名档**；
- 结果条数上限（`maxResults`，AnySearch 侧为 1–10）；
- 请求方法、POST body 模板、额外请求头（JSON）、超时；
- 结果字段映射（`resultsPath` / `urlField` / `titleField` /
  `snippetField` / `publishedField`，仅 generic 档）。

保存后写回 dsh 设置文档的 `web-search-custom:` 段并**立即生效**——下一次搜索就用新值，
无需重启。「已覆盖 / 重置」徽标行为与官方插件卡一致。

若旧版本曾把别的 URL 钉在这里，请在该字段上点「重置」再保存，让出厂的 AnySearch 默认值
重新生效。

## 配置项一览

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `api` | `auto` | 档位：`auto`（按 URL 主机名判定）/ `anysearch`（AnySearch POST 接口）/ `generic`（任意模板化 JSON 端点） |
| `url` | `https://api.anysearch.com/v1/search` | 搜索地址。anysearch 档 POST 到此；generic 档支持 `{query}`（URL 编码）、`{queryRaw}`（原样）、`{apiKey}` 占位符，GET 且不含 `{query}` 时自动补 `q=` |
| `apiKey` | 空 | 可选。anysearch 档留空则**完全不发** `Authorization` 头（匿名免费额度）；填了发 `Authorization: Bearer <key>`。generic 档走头名/scheme 两个字段，且 URL 或 body 里已有 `{apiKey}` 时不再额外加头 |
| `maxResults` | `10` | 仅 anysearch 档：作为 `max_results` 发送，取「本值与调用方上限的较小者」，并夹在 1–10 |
| `method` | `GET` | 仅 generic 档：`GET` 或 `POST`；其他值一律降级为 `GET` |
| `body` | `{"query":"{query}"}` | 仅 generic 档：POST body 模板，支持 `{query}` / `{queryRaw}` / `{apiKey}` |
| `headers` | `{}` | 额外请求头，JSON 字符串 |
| `authHeader` | `Authorization` | 仅 generic 档：apiKey 使用的请求头名 |
| `authScheme` | `Bearer` | 仅 generic 档：鉴权 scheme；填空字符串则裸发 key 值 |
| `timeoutMs` | `30000` | 单次请求超时 |
| `resultsPath` | `results` | 仅 generic 档：JSON 中结果数组的点路径，如 `data.results` |
| `urlField` / `titleField` / `snippetField` / `publishedField` | `url` / `title` / `content` / `publishedDate` | 仅 generic 档：结果字段名映射（SearXNG 默认值） |

generic 档每个字段在映射时还有一层常见别名兜底（例如 `titleField` 取不到时依次尝试
`title`、`name`）。anysearch 档固定读 `data.results[].title` / `.url` / `.snippet`，
snippet 缺失时回落 `.content`。

## 垂直检索与参数化查询

anysearch 档只发通用网页查询。需要垂直检索（`tag` / `params` / `zone` /
`language`，见 [API 文档](https://www.anysearch.com/docs/api-endpoints/v1-search)）时，
切到 generic 档自己写 body —— 响应信封不变，只是字段映射换成对应的名字：

```yaml
- id: web-search-custom
  config:
    api: generic
    url: 'https://api.anysearch.com/v1/search'
    method: POST
    body: '{"query":"{queryRaw}","tag":"code.doc","params":{"library":"golang"},"max_results":5}'
    resultsPath: data.results
    urlField: url
    titleField: title
    snippetField: snippet
    publishedField: ''
```

## 其他配置方式

### profile 补丁层（设置页之外的写法）

```yaml
- id: web-search-custom
  config:
    api: auto
    url: 'https://api.anysearch.com/v1/search'
    apiKey: ''
    maxResults: 10
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

### 环境变量

环境变量优先级高于设置页，且不需要改文件：

| 变量 | 说明 |
| --- | --- |
| `WEB_SEARCH_CUSTOM_API` | 覆盖档位（`auto` / `anysearch` / `generic`） |
| `WEB_SEARCH_CUSTOM_URL` | 覆盖搜索 URL |
| `WEB_SEARCH_CUSTOM_API_KEY` | 覆盖 API key（推荐用于含 secret 的场景）；置空即保持免 key 匿名档 |
| `WEB_SEARCH_CUSTOM_MAX_RESULTS` | 覆盖 AnySearch 结果条数上限 |
| `WEB_SEARCH_CUSTOM_HEADERS` | 额外请求头，JSON 字符串 |
| `WEB_SEARCH_CUSTOM_TIMEOUT_MS` | 超时毫秒数 |

## 卸载

```bash
dsh plugin --profile web remove dsh-web-search-custom
```

重启 dsh 后恢复官方搜索 provider。

## 限制

- `apiKey` 作为普通设置字段保存，不经过凭据系统；敏感环境建议用
  `WEB_SEARCH_CUSTOM_API_KEY` 覆盖。
- AnySearch 单次请求最多 10 条（`max_results` 1–10）；工具层仍会按调用方的
  `maxResults` 进一步截断。
- AnySearch 匿名档按客户端 IP 限流并计每日免费额度；额度用尽时接口返回 402，且可能
  回吐自动生成的凭据。本插件把它作为错误上报，并**脱敏**这些凭据而不落盘。要继续搜就填
  一个 key。
- 结果映射是字段级的、不懂查询语言：generic 档遇到异常载荷形状需要调整字段映射
  （必要时还要调 `resultsPath`）。

## 开发与测试

```bash
npm install          # 开发依赖（dsh 包，供宿主契约测试使用）
npm test             # node --test tests/*.test.mjs && node tests/client-smoke.mjs
npm run test:host    # 真实 Cordis + WebRuntime + 文件型 settings provider
```

| 测试 | 证明了什么 |
|---|---|
| `tests/entry.test.mjs` | 真实入口加载（`import('../src/index.js')`）、manifest 声明、engines 判定表（手写比较器 + 反证 + 与宿主真实 `semver.satisfies` 交叉验证）、四处键集合一致性（host schema ↔ client 字段 ↔ client 视图 ↔ 补丁 config）、settings 热更新活引用、依赖卫生 |
| `tests/anysearch.test.mjs` | anysearch 档：auto 判定、免 key 与 Bearer 两态请求头、`max_results` 取值算术、厂商信封映射、错误信封（`message` + `request_id` + 402 凭据脱敏），以及 generic 档不回归 |
| `tests/host-integration.test.mjs` | 由真实 `@deepseek-ai/cordis` Context、真实 `ctx.web` 运行时、真实文件型 settings provider 驱动：provider 注册、`web.search()` 全链路、seam 的 `maxResults` 截断、设置提交 → 下次调用即生效、seam 的选择语义 |
| `tests/client-smoke.mjs` | 浏览器半：bundle id、短服务名、双语词典键集合一致、槽位注册契约、卡片渲染、保存/重置写路径、只读态禁用 |
| `tests/live-search.mjs` | 可选的真端点活体检查：`DSH_WSC_LIVE_URL='https://api.anysearch.com/v1/search' node tests/live-search.mjs`（加 `DSH_WSC_LIVE_BAD_KEY=1` 可一并验证无效 key 的错误路径） |

### 活体检查（默认跳过，会打真实网络）

```bash
# 真实端点 → 真实 seam 全链路
DSH_WSC_LIVE_URL='https://api.anysearch.com/v1/search' node tests/live-search.mjs '你的查询'
# 同上，外加无效 key 的错误路径
DSH_WSC_LIVE_URL='https://api.anysearch.com/v1/search' DSH_WSC_LIVE_BAD_KEY=1 node tests/live-search.mjs '你的查询'
# 双臂对照：证明「用户层 url 决定实际请求」，且新默认真的能出结果
DSH_WSC_LIVE_PARITY=1 node tests/live-settings-parity.mjs
```

默认 `npm test` 套件保持离线可跑；未设上面的环境变量时这些脚本打印 `SKIP` 后退出。

```text
src/index.js          host 半——设置命名空间、档位分派、结果映射
lib/client.js         浏览器半——设置卡（手写 bundle，无构建步骤）
cordis.patch.yml      bundle 补丁：选中 provider "custom" 并挂载插件
tests/                entry + anysearch + 宿主契约 + client-smoke + 可选活体检查
```

## 许可证

[MIT](LICENSE)
