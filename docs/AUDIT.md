# dsh-web-search-custom 审计报告

> 历史轮次：2026-09-01 · v0.3.0（commit 98fec72，dsh 0.1.2-alpha.3 适配后）——见文末「附录：历史轮次」。
> 方法：代码级逐文件通读 + 契约级源码对照（dsh-web / dsh-settings / cordis）+ 行为模拟

---

# 第 6 轮：适配 AnySearch（2026-09-21，v0.2.0）

> 审计对象：v0.2.0（工作树）
> 宿主：@deepseek-ai/dsh **0.1.5-rc.2**（/usr/lib/node_modules 实装版本）
> 触发：用户要求接入 https://www.anysearch.com/docs/api-endpoints，且「带 key 走鉴权、不带 key 免 key」
> 方法：官方文档实测取证 → 缺口分析 → TDD（先写失败测试）→ 真宿主契约测试 → 真端点端到端

## 0. 开工前实测取证（不靠文档转述）

| 探针 | 结果 | 结论 |
|---|---|---|
| 旧默认端点（内网 SearXNG 10.200.0.5:8080） | `q=deepseek` / `q=anysearch` 均返回 **0 条**，baidu/bing/sogou/startpage/wikipedia 全 timeout | 旧默认已实质失效：本轮不只是「换引擎」，而是修复 |
| AnySearch 匿名（无 Authorization） | HTTP 200、1.6–2.1s；直连与走代理均通 | 免 key 可行；宿主直连可达（DNS 落 cn.gtm.anysearch.com），插件无需内置代理 |
| 无效 key | HTTP 401 `{"code":-1,"message":"Invalid API key.","error_code":"invalid_api_key"}` | 鉴权档失败是硬错误，**不会静默回落匿名** |
| 未知 tag | HTTP 400 `Invalid tag: nope.nothing.` | 参数错误走 error envelope，可原样上报 |
| `max_results` 传 20 / 0 | 都返回 10 条 | 服务端夹取 1–10；插件侧仍显式夹取，语义明确 |
| query 被 URL 编码（`Go%201.26%20release%20notes`） | 返回**完全无关**的结果 | 旧 generic 档「POST body 里塞编码后的 query」是真 bug，anysearch 档必须用原始 query |
| 402 语义（官方文档） | 额度耗尽时响应体含自动生成的 username/password/api_key | 必须脱敏，不得进日志或错误文本 |

## 1. 设计判据（为什么新增 `api` 档位而不是改写 generic）

- 厂商契约与 generic 档**不是超集关系**：anysearch 固定 POST、固定 `{query,max_results}` 信封、固定 `data.results` 路径与 `snippet|content` 语义；且「无 key = 匿名档」是**厂商特性**（generic 档的无 key 只是「不加鉴权头」，语义不同）。
- 因此按**档位**建模（`auto | anysearch | generic`），而不是往 generic 里塞 if。`auto` 按 URL 主机名判定 `*.anysearch.com`，保住「改 URL 即生效」的直觉。
- 向后兼容：未设 `api` 且 URL 非 AnySearch 的存量配置，行为与 v0.1.5 一致（有测试钉住）。

## 2. 实现面（结论：**无 P0/P1**）

| 项 | 判定 | 证据 |
|---|---|---|
| 免 key / 带 key 两态 | ✅ | `apiKey` 为空时 `buildHeaders` 根本不写 Authorization（测试断言**头名不存在**，而非断言空值） |
| 错误信封保真 | ✅ | 错误文本带 HTTP 状态 + 厂商 message + `request_id`；401/402/429 各附处置提示 |
| 402 凭据脱敏（原 P1 风险，已消） | ✅ | `redactCredentials` 抹 `api_key=`/`password=`/`username=`/`secret=`/`token=` 与 `sk-*` 形态；测试用真实形状 402 载荷断言 key 与密码不出现在 message 中 |
| `max_results` 算术 | ✅ | 取 `min(配置值, 调用方 maxResults)` 再夹 1–10；6 组边界用例（含 caller 缺失、配置越界） |
| 病态载荷 | ✅ | `data` 为 null / `results` 为字符串 / 载荷为字符串或 null → 一律降级 `{sources:[],truncated:false}` 不抛 |
| 向后兼容 | ✅ | generic 档 GET 补 `q=`、URL 编码、字段映射、`{apiKey}` 优先级全部原样；新增 `{queryRaw}` 不改 `{query}` 语义 |
| 键集合一致性（四处） | ✅ | host schema ↔ client FIELD_KEYS ↔ FIELD_VIEWS ↔ 补丁 config，测试逐键比对（新增 `api`/`maxResults` 后仍对齐） |
| 文档承诺 = 行为 | ✅ | README 双语「anysearch 档只认 5 个字段」与实现一致；垂直检索给出 generic 写法而非虚构字段 |

### P2（已处理）

- anysearch 档下 `method`/`body`/`authHeader`/`authScheme`/字段映射会**静默忽略**，属「配置了不生效」体感：已在设置卡标签标注「仅 generic」，并在 README 配置表中逐项写明作用域。

## 3. 测试面（TDD 证据链）

| 阶段 | 命令 | 结果 |
|---|---|---|
| RED | `node --test tests/anysearch.test.mjs`（实现前） | **10 失败 / 5 通过**（通过项正是「向后兼容」现状，反证测试有效） |
| GREEN | 同上（实现后） | **16/16 通过** |
| 回归 | `npm test` | **39/39 通过** + client-smoke 17 项通过 |
| 真宿主 | `npm test` 内 host-integration | 真 Cordis + 真 WebRuntime + 真文件 settings provider 全链路通过 |
| 真端点 | `DSH_WSC_LIVE_URL=... node tests/live-search.mjs` | 匿名档 5 条真实结果 LIVE OK；`DSH_WSC_LIVE_BAD_KEY=1` 时 401 信封 + request_id + 处置提示 LIVE BAD-KEY OK |

RED 阶段两条假绿教训（已修正断言口径）：① HTTP 头名大小写不敏感，断言必须按小写查名，不能断言 `headers.authorization` 字面量；② 断言「不发鉴权头」要断言**头名不存在**，只断言值为 undefined 会被 `{}[key]` 也满足。

## 4. 遗留（P3，不阻塞交付）

- 垂直检索要求用户手写 generic body（未做 `tag`/`params`/`zone`/`language` 专用字段）：刻意 YAGNI，等真有场景再加。
- `available()` 不发网络请求（seam 契约要求廉价），因此「key 有效但额度耗尽」只能在首次搜索时以 402 暴露。


# 第 5 轮：适配 dsh 0.1.5-rc.1（2026-09-10）

> 审计对象：**v0.1.5-rc.1**（工作树，未推送）
> 宿主：`@deepseek-ai/dsh@0.1.5-rc.1`（/usr/lib/node_modules 实装版本）
> 方法：真宿主源码逐条对照 + 真宿主对象集成测试 + 隔离实例真机 E2E + 反证

## 0. 先证「改动面有多大」，而不是先改代码

按适配纪律第零步，在真实宿主包里逐条对照插件依赖的每个契约，**结论是代码本体零改动**：

| 契约点 | 0.1.5-rc.1 宿主坐标 | 判定 |
|---|---|---|
| `ctx.web.registerSearchProvider(provider)` | `dsh-web/lib/index.js:67` → `registerProvider(searchProviders, provider)`；重复 id 抛 `WEB_DUPLICATE_PROVIDER`；disposer 走调用方 fiber 的 effect | 形状未变 ✅ |
| `WebSearchProvider` 接口 | `dsh-web/lib/types/types.d.ts:98`：`{id, available(), search(request, signal)}` | 逐字段一致 ✅ |
| seam 结果兜底 `capSources` | `dsh-web/lib/index.js` 尾部：超 `maxResults` 则切片并置 `truncated: true` | 未变 ✅（插件自身无需截断） |
| provider 选择语义 | `resolveProvider`：configured id 优先 → 未注册 `WEB_PROVIDER_CONFIGURED_MISSING` → 未可用 `WEB_PROVIDER_CONFIGURED_UNAVAILABLE` → 唯一可用 → 多可用 `WEB_PROVIDER_AMBIGUOUS` | 未变；插件 `available()` 不发网络请求，满足契约 ✅ |
| `settings.installSection(owner, ns, schema, entry, hooks)` | `dsh-settings/lib/index.js:327`：`register(base=entry) → hooks.setSource(() => scope.get()) → 卸载回落 effect → hooks.onChange() 首发 → scope.watch 持续通知` | 逐行与插件用法一致 ✅ |
| 依赖副本一致性 | 插件开发依赖 `@deepseek-ai/dsh-settings@0.1.5-rc.1` 与宿主包内副本 `diff -r`（排除嵌套 node_modules）**零差异** | 无嵌套私有副本漂移 ✅ |
| client 半服务名与槽位 | `slots` / `locale` / `settingsScope` / `connection` / `remote` 仍为短服务名；`settings.plugin.item` 槽位由官方 `dsh-client-ui-settings-plugins` 声明（`:1785` 起注册四个官方卡，key 语义未变） | 未变 ✅ |
| client 卡片渲染契约 | 官方卡注册形状 `{name, key, locale, inject}` 与插件逐字段相同；`settings.plugin.item` 仍以 namespace 为 key 与宿主 serve 的命名空间集合求交（`:1093` `ConfigurablePluginsTabController`） | 未变 ✅ |
| client 运行时模块 | `dsh-web-frontend/dist/assets/index-*.js` 内可见 `"@deepseek-ai/dsh-client-ui-primitives"` / `"@deepseek-ai/dsh-client-ui-slots"`，`IconChevronDownOutline14` 仍在（设置卡排他依赖的图标） | 未变 ✅ |

→ 因此本轮工作量全部落在**声明面 / 测试面 / 文档面**，源码一行未动（`git diff` 仅 package.json、
测试、文档）。

## 1. 发现并修复的缺陷

### 🔴 P1-1 `dsh.engines.dsh` 与 `peerDependencies` 区间覆盖不了 0.1.5-rc.1（同一坑两处）

- **事实**：原声明 `">=0.1.2-alpha.3 <0.2.0"`。npm semver 规则：预发布版本只被「区间内含
  **同一 `[major,minor,patch]` 元组**的预发布」满足——该区间里的预发布只有 `0.1.2-alpha.3`，
  所以 `0.1.5-rc.1` **不被覆盖**。实测（宿主真实 `semver@7.8.5`）：
  `0.1.2-rc.1 ✅ / 0.1.5-alpha.1 ❌ / 0.1.5-rc.1 ❌ / 0.1.5 ✅ / 0.1.6 ✅ / 0.2.0 ❌`。
  即「声称适配 0.1.5，却不被自己的声明覆盖」。
- **第二处**：`peerDependencies["@deepseek-ai/dsh-settings"]` 是同一坑的另一个入口，容易被漏审。
- **修复**：两处均改为析取区间 `">=0.1.2-alpha.3 <0.2.0 || >=0.1.5-alpha.1 <0.1.6"`（加析取而非
  放宽上界：仍把 0.1.6 / 0.2.0 挡在外面）。
- **回归**：`tests/entry.test.mjs` 的 10 行判定表 + 内置手写比较器（不引 semver 依赖，避免测试
  与依赖一起漂移）+ 对旧单区间的**显式反证**（断言 `satisfies('0.1.5-rc.1', OLD) === false`）
  + 与宿主真实 `semver.satisfies` **逐行交叉验证**（10/10，两处区间各一遍；不可解析时显式
  SKIP 打印原因，不假绿）。
- **反证实测**：把区间改回旧单区间 → 判定表用例立刻变红（已跑，见下）。

### 🟠 P2-1 client 表单与 host schema 的键集合一致性无守护

- **事实**：`lib/client.js` 是手写 bundle（无构建源），`FIELD_KEYS` / `FIELD_VIEWS` 与 host
  `Config` 的 13 个键靠人工同步；`cordis.patch.yml` 里还有**第三处**同名 config 键。
- **影响**：任一处漂移 = 设置页调不到该开关（或补丁层静默丢配置），且完全静默。
- **修复**：`tests/entry.test.mjs` 新增四处逐键 deepEqual 断言（host schema 调用结果键 /
  client `FIELD_KEYS` / client `FIELD_VIEWS` / 补丁 `config`），并对 13 个字段断言
  「表单控件类型与默认值类型一致」（number 字段必须用 `numberField`）。
- **反证实测**：删一个 `FIELD_KEYS` 项 / 删一行 `FIELD_VIEWS` / 删补丁一个键 → 三种改法全部变红。

### 🟠 P2-2 缺少真宿主对象契约测试（第三/四路盲区）

- **事实**：原 `entry-smoke.test.mjs` 用自造 ctx 桩（`installSection` 桩自行实现），只能证明
  「插件调用了桩」，不能证明「真 Cordis/真 WebRuntime/真 settings provider 接受这套调用」。
- **修复**：新增 `tests/host-integration.test.mjs`，用**真宿主对象**驱动：
  真 `@deepseek-ai/cordis` `Context` + 真 `WebRuntime` + 真文件型 `FileSettingsProvider`
  （隔离临时目录，`watch: false`），断言 provider 真进注册表、`ctx.web.search()` 真走全链路、
  seam 的 `maxResults` 截断与 `truncated` 置位由 seam 完成、设置文档提交后下一次搜索即读到新值、
  以及 seam 三种选择分支的错误码。
- **顺带证实的运行时事实**：Cordis 的 effect 在 **microtask** 落地（`apply` 返回后立即
  `describe()` 为空，过一个微任务才出现）——桩测试对此无感，真宿主测试必须 `settle` 一拍，
  否则会写出假红/假绿。

### 🟡 P3-1 client 交互层盲区无守护（可写态控件是否真的可点）

- **修复**：新增 `tests/client-smoke.mjs`（14 项）：bundle id、`exports.inject` 短服务名、
  zh/en 词典键集合一致、`settings.plugin.item` 注册契约（key/locale/inject 载荷形状）、
  卡片渲染出全部 13 个字段行、保存写路径（文本 / 数字类型 / 重置 = unset 回落默认）、
  **只读态 13 个输入框 + 保存/放弃 + 行级重置按钮全部 disabled**、以及反向断言
  **可写态 + dirty 时这些按钮必须可用**（防「恒禁用」这类只在真机现形的交互层缺陷）。
- **反证实测**：把 `disabled: props.disabled` 全量改成 `false` / 单独让重置按钮恒可用 /
  单独让保存按钮恒可用 → 三种改法全部变红。

### 🟡 P3-2 `method` 自由文本无跨层语义守护（本轮补测，非新缺陷）

- **事实**：设置卡只有 GET/POST 二选，但字段本身是自由文本框，非法值原样落盘；host
  `resolveOptions` 把「非 POST」一律归一化为 GET。
- **处置**：不收紧实现（保持两半各自的既有语义），改为**把这条跨层约定写入测试**：
  `entry.test.mjs` 断言 `method: 'BANANA'` → 实际以 GET 发出；`client-smoke.mjs` 断言
  客户端按输入原样落盘、不做隐式改写。任一侧偏离立刻变红。

## 2. 修复面与测试基线

| 面 | 变动 |
|---|---|
| package.json | `version` 0.1.2-rc.1 → **0.1.5-rc.1**；`dsh.engines.dsh` + `peerDependencies` 补析取；`files` 补 `docs`/`README.zh-CN.md`；`scripts.test` 统一为 `node --test tests/*.test.mjs && node tests/client-smoke.mjs`，新增 `test:host`；补 `repository` |
| 开发依赖 | 真升级：`rm -rf node_modules pnpm-lock.yaml` → 代理 + pnpm store 重装 → 断言装到 `@deepseek-ai/dsh-settings@0.1.5-rc.1`（`node_modules` 实测版本号），且与宿主副本 `diff -r` 零差异 |
| pnpm-workspace.yaml | `minimumReleaseAgeExclude` 从 `0.1.2-alpha.3` 系刷新为 `0.1.5-rc.1` 系（10 条）——不带这份白名单时 pnpm 会静默退回 `0.1.5-alpha.1`，是个容易忽略的「假升级」 |
| 测试 | 5 → **37**：entry-smoke 5 + entry 14 + host-integration 4 + client-smoke 14（+ 可选 live 1）；每条新增守护均已跑反证变红 |
| 文档 | README 双语化（英文主版 + `README.zh-CN.md`）、新增 `docs/EVIDENCE.md`、本文件新增第 5 轮 |

## 3. 隔离实例真机 E2E（未触碰线上）

独立 `DSH_HOME` + 独立端口 33082 上跑完整链路，证据见 `docs/EVIDENCE.md`：

1. `dsh plugin --profile web add <仓库路径>` → 依赖装上、`dsh.profile.bundles` 自动加入插件；
2. `dsh --profile web --dump-config` → 组合树出现两条本插件条目（`web.searchProvider: custom` 补丁 + provider 挂载行）；
3. `dsh web --no-open --port 33082` → 无 token 401；带 token 303 → 200（27,946 B 外壳）；
4. 外壳 boot manifest 含 `{"id":"dsh-web-search-custom","url":"/plugins/??dsh-web-search-custom/client.js&rev=..."}`；
5. 按 combo URL 拉取（11,162,513 B，HTTP 200），字节里含插件工厂 id ×7、卡片中文标题 ×1；
6. `tests/live-search.mjs` 用真 Cordis + 真 seam + 真搜索端点跑通全链路（5 条真实结果）。

## 4. 诚实缺口

- 未做浏览器自动化：设置卡的**视觉**呈现仍需人工开页面确认；已证的只有「bundle 已下发（id/rev/
  工厂在列）」+「卡片在忠实桩下的渲染与提交行为」。
- combo 字节只做了关键特征串核对（工厂 id、卡片标题），未在浏览器引擎里执行。
- 写路径覆盖用文件型 provider；基类 `SettingsProvider` 设计上只读（in-process 写会抛
  `read-only`），不是缺陷。
- **启动阶段确实存在一次假故障**：首轮 E2E 用 `curl http://127.0.0.1:<port>/` 得 404/401 被
  当成「插件没起来」；实际 dsh web 需先走打印出的带 token URL（303 → 落 cookie）才能拿到外壳。
  属探针保真度问题，不是插件缺陷——已记入 EVIDENCE 的验证顺序。

## 5. 第 5 轮复核（换角度：极端输入 / 并发 / 补丁层优先级）

按「修完必须开新一轮、且换新角度」的纪律，本轮复核不复核修复面，改从三个新角度深挖：

### 5.1 极端输入（全部通过，无需修复）

用真宿主对象跑 12 组病态输入，逐条记录实际表现：

| 输入 | 结果 |
|---|---|
| query 长 100,000 字符 | 正常发出（URL 长度 100,040），不崩、不截断 |
| `results` 是对象 / `null` / 整体 payload 为 `null` / 为字符串 | 一律映射为 `sources: []`，不抛 |
| **数组元素为 `null` / `undefined`** | **本轮发现并修复（P2-3，详见 5.5）** |
| `resultsPath` 指向的路径缺失（`{data:{}}`） | `sources: []`，不抛 |
| 条目字段类型错（`title: 42`、`content: [1,2]`） | 非字符串字段被忽略，URL 仍保留 |
| 条目为字符串 / 布尔 / 数字 / 空数组 | 视为无字段，跳过（不崩） |
| 10,000 条结果 | seam 截断到 `maxResults` 并置 `truncated: true` |
| URL 重复 | 按 URL 去重塌缩为 1 条 |
| `<script>` + `&amp;&lt;&gt;&#x41;&bogus;` | 标签被剥离、已知实体解码、未知实体原样保留 |

### 5.2 并发与取消（全部通过）

- **搜索在飞行中设置被改写**：`web.search()` 挂起期间提交新的 `url`，结果正常返回、不崩、不串值
  （每次调用现读 `current()`，不存在「半新半旧」的读法）。
- **调用方取消**：`AbortSignal` 触发后以 `custom web search aborted` 拒绝（包装保留 cause），
  不会静默返回空结果。

### 5.3 补丁层默认值与 schema 默认值的一致性（发现并修复：🟡 P3-3）

- **事实**：`cordis.patch.yml` 里写着一份**第三处** config 键**值**副本（键集合此前已守护，
  **值**没有）。它既不是 schema 默认值，也不是 `~/.dsh/settings.yaml` 里的用户值——却决定了
  「设置页点重置后回落成什么」和「未配置时的出厂端点」。
- **影响**：schema 默认或补丁值任一侧漂移，都会静默产生「重置后行为与出厂文档不一致」，
  且没有任何测试会发现。
- **修复**：`tests/entry.test.mjs` 新增「补丁值 === schema 默认值」逐键断言（去掉 YAML 引号后比较）。
- **反证实测**：把补丁里的 `timeoutMs` / `url` / `apiKey` 任一改掉 → 立刻变红（三种改法均验证）。

### 5.5 上游载荷含 null 元素时抛 TypeError（发现并修复：🟠 P2-3）

- **事实**：`mapResults` 直接对每个元素调 `firstString(item, ...)`，而该函数用 `item[key]` 取字段。
  当上游 JSON 的 `results` 数组里含 `null` / `undefined` 元素时（真实搜索服务在结果被过滤时确实会
  产出稀疏/null 项），`item[key]` 直接抛 `TypeError: Cannot read properties of null (reading 'url')`，
  **整个搜索失败**。
- **影响**：一条脏数据毁掉整次搜索；且因为抛在 provider 内，用户只会看到「搜索失败」，没有任何线索
  指向上游载荷形状。属于「单条脏数据放大成全链路失败」的典型 P2。
- **修复**：`firstString`（以及既有的 `getPath`）统一加非对象守卫——`null`/`undefined`/非对象一律返回 `''`，
  该条目随后因「无 url」被正常跳过。数组里混入字符串/数字/布尔/空数组同样安全。
- **回归**：`tests/entry.test.mjs` 的 `robustness` 用例覆盖 `[null, undefined, 42]` 与
  `['x', true, [], 0]` 两组元素形状。
- **反证实测**：删掉这行守卫 → 用例立刻变红。

### 5.4 本轮结论

未发现 P0/P1。新修的 P3-3 已配反证。按停止线规则，**下一轮复核**需再换角度（建议：真实浏览器
引擎里执行 combo bundle；多 provider 共存时的歧义分支端到端；超时路径的真实计时精度）。

## 6. 处置

P1-1 已修并配判定表 + 反证 + 宿主 semver 交叉验证；P2/P3 项已修并全部配反证。**建议下轮复核时
换角度**（不重复复核本轮修复面）：并发（`available()` 与 `search()` 之间的设置竞态）、极端输入
（超长 query / 异常 JSON 载荷形状 / 超大响应）、补丁层与设置页同时改同一字段时的优先级语义。

---

# 附录：历史轮次

> 审计时间：2026-09-01 · 审计对象：v0.3.0（commit 98fec72，dsh 0.1.2-alpha.3 适配后）
> 方法：代码级逐文件通读 + 契约级源码对照（dsh-web / dsh-settings / cordis）+ 行为模拟

## 一、总体结论

**骨架正确，无 P0/P1 阻断项**；发现 1 个 P2（测试未入库）与若干 P3。`settings.installSection` 接线与 `ctx.web.registerSearchProvider` 契约均与宿主源码实核对齐。

## 二、契约级核实（通过 ✅）

| 契约点 | 核实结果 |
|---|---|
| `settings.installSection(owner, ns, schema, entry, hooks)` | dsh-settings `lib/index.js:327` 真实存在：`register(base=entry) → setSource(scope.get) → 卸载回落 effect → onChange 同步首发 → scope.watch 持续通知`，与插件用法逐行一致 |
| `ctx.web.registerSearchProvider(provider)` | dsh-web `lib/index.js:67`：`registerProvider(searchProviders, provider)`，重复 id 抛 `WEB_DUPLICATE_PROVIDER`；`available()` 必须不发网络请求——插件实现满足 |
| provider 接口形状 | `{id, available(), search(request, signal)}` 与 `WebSearchProvider` d.ts 一致；`search` 返回 `{sources, truncated}` 会被 `capSources` 兜底截断 |
| `inject: ['web']` + 内部 `ctx.inject(['settings'])` | web 服务名确认（dsh-web `super(ctx,'web')`）；settings 晚到接线用闭包 `current()` 兼容，正确 |
| schemastery 默认值 | `Config` 全部字段带 default，cordis `resolveConfig`（`cordis/lib/index.js:955`）用 `Config['~standard'].validate(config)` 填充——`apply` 收到的 config 必含默认值 |

## 三、发现的问题

### 🟠 P2-1 测试未入库（交付不完整）

- **事实**：commit 98fec72 message 声称「测试：entry-smoke 过」，但 `git ls-files` 无任何测试文件（仅 9 个文件），package.json 无 test script。
- **影响**：entry-smoke（installSection 接线 + provider 注册的真实加载冒烟）只在本地跑过，未进版本库——后续改动无法回归，`import z from '@deepseek-ai/schemastery'` 这类 P0 隐患（default export 误用）无法被 CI 抓住。
- **修复**：把 entry-smoke 固化为 `tests/entry-smoke.test.mjs`（`await import('../src/index.js')` + apply 驱动 + provider 注册断言 + installSection 接线断言），package.json 加 `"test": "node --test tests/*.mjs"`。

### 🟡 P2-2 client bundle 手写无构建源

- **事实**：`lib/client.js` 为手写 bundle（478 行），仓库无 build.mjs / 源码（对照 paperclip/config-center 有 build.mjs + src/client.tsx）。
- **影响**：字段增改靠手工同步，易与 host `Config` 漂移；本轮核对字段 13 个与 Config 一致 ✅，但属脆弱交付。
- **修复**：至少补一个校验脚本（比对 `Config` 键集与 `FIELD_KEYS`）。

### 🟡 P3 杂项

| # | 问题 | 说明 |
|---|---|---|
| P3-1 | `lib/client.js` 末尾 `//# sourceMappingURL=client.js.map` 指向不存在的 map | 仓库无该文件，浏览器控制台 404 噪音；删引用或补 map |
| P3-2 | `resolveOptions` 允许 `method` 为任意字符串，非 POST 一律降级 GET | 设置卡只有 GET/POST 二选，但 host 层未校验；低风险 |
| P3-3 | `decodeEntities` 的 named 表缺失 `&copy;` 等常见实体 | 未知实体原样保留，不崩；可接受 |

## 四、行为模拟

- `withTimeout`：上游 signal 提前 abort → controller 立即 abort（reason 透传）；超时 abort 带 timeout message；cleanup 清 timer + 移除监听 ✅
- `buildUrl`：GET 无 `{query}` 自动补 `q=`；POST 不补；`{apiKey}` 嵌入 URL 时 `keyAlreadyEmbedded` 防重复 Authorization ✅
- `mapResults`：按 url 去重、非法协议过滤、HTML 标签剥离、实体解码、字段多级回退 ✅
- `available()`：空 url / 非 http(s) 模板 / timeoutMs<=0 → false，不发网络请求 ✅

## 五、处置

无 P0/P1。P2-1（测试入库）建议交付前补齐；P3 项顺手修。修复后按停止线规则开新一轮复核。


---

# 第 7 轮：dsh 0.1.7-rc.1 适配轮（2026-09-26）

> 触发：用户要求「为 dsh-web-search-custom 做新版 dsh 适配，可参考 dsh-prompt-injector」。
> 宿主实测版本：**0.1.7-rc.1**（`C:\Users\Doctor\AppData\Roaming\npm\node_modules\@deepseek-ai\dsh`）。
> 上一轮基线 0.1.5-rc.1。交付版本 **0.3.0**。

完整契约比对与改动清单见 [DSH-0.1.7-ADAPTATION.md](DSH-0.1.7-ADAPTATION.md)，本节只记审计口径的结论。

## 0. 先证改动面（而不是先改代码）

逐条读宿主真实源码后，改动面结论是**有真实代码改动**（与上一轮 prompt-injector「代码零改动」相反）：
0.1.7 换掉了整套设置模型，本插件 host 接线与 client 设置卡两半都踩在破坏面上，
而搜索 provider 逻辑（`ctx.web.registerSearchProvider` / provider 形状 / 结果映射）零漂移。

## 1. 发现并修复的缺陷

### 🔴 P1-1 settings 模型重做：host 半接线整体失效（新版引入）

- **事实**：`dsh-settings/lib/index.js` 与 `lib/types/schema.js` 实测 —— `installSection` 在整个
  0.1.7 依赖树内 **0 命中**；`describe()` 的入口过滤条件是
  `volatileForm(schema(entry.fiber.runtime.Config))`。未导出 `Config` = 宿主看不到该命名空间。
- **影响**：命名空间不可见 → client 半 `whileServed` 永不注册 → **插件页没有配置入口，且宿主零报错**（静默失效）。
- **修复**：`Config` 保持导出并 15 字段全 `.volatile()`；删除 `installSection` 接线；加
  `settings.configure({ auto: false }, ctx.fiber)` 关闭宿主自动生成的页面。
- **守护**：`entry.test.mjs` 断言 `Config` 每字段 `meta.volatile === true` + 源码级防回退断言；
  `host-integration.test.mjs` 用**真实** `volatileForm` / `isVolatilePath` 复现 `describe()` 与 `write()` 的判据。

### 🔴 P1-2 client 半三处 API 消失（新版引入）

- **事实**：`settingsScope` 与 `settings.plugin.item` 在 0.1.7 全树 **0 命中**；
  `plugins.item`（插件页 list 槽位）取代之；`slots.inject(key, callback)` 的实现是
  `ctx.effect(callback, ...)`（`dsh-client-ui-renderer/lib/client.js:1369`）——0.1.5 的 generator 形态
  `function* () { yield register(...) }` 会被当普通回调调用，`register` 永不执行。
- **影响**：设置卡彻底不出现（无报错、无 UI），且旧形态属**静默**失效。
- **修复**：改 `configForms.get(NS)` + `configForms.whileServed([NS], ...)` 门控 +
  `plugins.item` 注册（`id: NS` / `order: 50` / `label` thunk）+ 箭头回调返回 disposer。
- **守护**：`entry.test.mjs` 静态断言旧 API 一个都不许复活（按调用形状判，先剥注释）；
  `client-smoke.mjs` 桩里 `slots.inject` **当场断言 callback 返回 disposer**（generator 立刻炸）；
  `host-integration.test.mjs` 对 renderer / plugin-manager 的真实 client bundle 做源码级断言。

### 🟠 P2-1 兼容断言：旧区间在新版 host 上的判定会被说反（新版引入）

- **事实**：`evaluatePluginCompatibility` 用 `semver.satisfies(..., { includePrerelease: true })`
  （`dsh-app-boot/lib/index.js:300`）——**在这道闸下，旧单区间 `>=0.1.2-alpha.3 <0.2.0`
  在 0.1.7-rc.1 下也会通过**；真正拦住它的是 pnpm 的严格 semver。
- **影响**：只按一种判定写断言/文档，会把「是否已适配」说反。
- **修复**：两种判定分别断言——preflight 通过 + 严格 semver 拒绝，并保留 `0.1.8 / 0.2.0` 越界反证。
- **守护**：`host-integration.test.mjs` 调**真实** `evaluatePluginCompatibility` 与宿主真实 `semver`；
  `entry.test.mjs` 的 15 行判定表与真实 `semver` 逐行交叉验证。

### 🟠 P2-2 `schemastery` 区间过宽（新版引入）

- **事实**：`.volatile()` 是 3.18.4 新增 API —— 本地 3.18.2 的 `lib/` 里 `volatile` **0 命中**，
  3.18.4 源码里存在（宿主与官方插件都声明 `~3.18.4`）。
- **影响**：旧 peer `^3.18.2` 允许 3.18.2/3.18.3 装进来，`Config` 顶层求值即
  `TypeError: ...volatile is not a function` → 插件整包 park。
- **修复**：peer 收紧 `~3.18.4`，devDeps 真升级到 3.18.4；`entry.test.mjs` 断言区间排掉 3.18.2。

### 🟡 P3-1 只读部署下客户端仍发起写入（**存量缺陷**，非新版引入）

- **事实**：官方 `SettingsFormModel.save()` 有 `writable` 守卫，本仓手写表单漏了。
- **影响**：只读部署里一次点击 → 一次注定被拒的写；卡片不崩，但行为与官方不一致。
- **修复**：`CardForm.save()` 加同款守卫；`client-smoke.mjs` 断言「只读 + 草稿 → save() 不写 scope」。

### 🟡 P3-2 测试桩失真（**存量**）

- **事实**：client-smoke 的 scope 桩 `unset` 只删 resolved 值、不还原 base 层，与真实
  `unset = 移除用户层覆盖、回落 composition 层` 语义不符；另一处按渲染顺序盲取「重置」按钮属隐式耦合。
- **修复**：桩改为正确回落 base；按钮通过 `label.htmlFor → 字段名` 归属（真实结构），不再依赖顺序。

## 2. 测试基线（本轮，全绿）

```
pnpm test  →  node --test tests/*.test.mjs     # 53 tests / 53 pass / 0 fail（含 10 个真宿主对象用例）
              node tests/client-smoke.mjs      # 24 项全部通过
```

新增/重写的守护（均已跑反证）：

| 用例 | 反证方式 |
|---|---|
| `Config` 全字段 `.volatile()` | 去掉任一 `.volatile()` → 断言变红 |
| 旧 API 静态防回退 | 把 `whileServed` 改回直接 `slots.inject` → 变红 |
| `slots.inject` 返回 disposer | 桩里把 callback 换成 generator → 当场炸 |
| volatile 活引用 | provider 改回读 apply 快照 → 真实 `updateVolatile` 后断言变红 |
| 命名空间可枚举 | `Config` 不导出 → `volatileForm` 返回 undefined → 变红 |
| 兼容闸 | peer 改回单区间 → 越界反证与严格 semver 断言变红 |

## 3. 隔离实例真机 E2E

**本轮未做**：它必须先重启用户正在使用的 dsh 实例（0.1.5 那轮用独立 `DSH_HOME` + 独立端口
的做法仍适用，流程写在 DSH-0.1.7-ADAPTATION.md 第 5 节）。按重启红线纪律不自行越过——待用户点头后执行。

## 4. 诚实缺口

- 真机两态（`describe()`/`mutate()` 全链路、卡片在插件页的真实渲染）**未验证**；已证的是
  「真实 schema 助手判据 + 真实 volatile 协议 + 真实 client bundle 源码 + 真实兼容闸」四层。
- 未做浏览器自动化（与上一轮同样的限制）。
- `pnpm install` 会带进 71 MB 的 `@deepseek-ai/libreoffice-kit-win32-x64`（`dsh` devDep 的传递
  依赖，dev-only，不进发布物）；发布物仍零 `dependencies`、零安装脚本。
