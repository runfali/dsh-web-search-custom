# dsh-web-search-custom 审计报告

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
