# dsh 0.1.7-rc.1 适配说明（dsh-web-search-custom）

对象：本机全局 `@deepseek-ai/dsh@0.1.7-rc.1`（Windows 宿主，profile `web`）。
本仓上一轮适配基线：0.1.5-rc.1（审计记录见仓库内 `docs/AUDIT.md` 的适配轮；该文件属内部文档，不随 npm 包发布）。
本轮交付版本：**0.3.0**。

> 结论先行：本轮**有真实代码改动**（不是纯声明面）。0.1.7 换掉了整套设置模型，
> 本插件的 host 接线与 client 设置卡两半都必须重写；搜索 provider 逻辑本身零漂移。
> 全部结论均在宿主**真实源码**上逐条核对（不是文档转述），并有真宿主对象测试兜底。

## 1. 契约比对（逐条，附核对坐标）

| 契约点 | 0.1.5-rc.1 | 0.1.7-rc.1（实测） | 本插件影响 |
|---|---|---|---|
| 设置命名空间注册 | `settings.installSection(owner, ns, schema, entry, hooks)` | **已移除**。`describe()` 直接枚举「active 且含 volatile 字段的 Config」的入口，`ns = cordis 行 id` | **硬破坏**，host 半重写 |
| 可热编辑字段 | 整段 schema 即 scope | 字段必须 `.volatile()`；volatile-only 变更经 loader `_commitVolatile` 原地提交（不重启 fiber） | **硬破坏**，15 个字段全部加 `.volatile()` |
| apply 收到的值 | 普通值 | volatile 字段是 `{get()}` **活引用**（cosmokit `createVolatile` 协议） | 需解引用；provider 每次现读 |
| 展示策略 | installSection 即卡片 | 自带卡片的插件应注册 `settings.configure({ auto: false }, fiber)` | 新增接线 |
| 浏览器 settings 通道 | `settingsScope.bind({ namespace })` | **已移除** → `configForms.get(ns)`（ConfigFormController） | **硬破坏**，client 半重写 |
| 设置卡槽位 | `settings.plugin.item`（设置页，keyed） | **已移除** → `plugins.item`（插件页，list，`id` = 行 id，`label` thunk，`order`） | **硬破坏**，client 半重写 |
| 注册时机 | 直接注册 | `configForms.whileServed([ns], register)` 门控：宿主开始服务该 ns 才注册，停服自动摘除 | 新增门控 |
| `slots.inject` 回调形态 | generator（`function* () { yield register(...) }`） | **「返回 disposer 的普通函数」**（renderer 把 callback 交给 `ctx.effect`） | **硬破坏**，已改箭头形态 |
| 卡片渲染视图 | 单一 | 同一个槽位按 `view: 'summary' \| 'page'` 两种渲染（列表卡描述区 / 详情页配置区） | 卡片改双视图分支 |
| 官方表单原语 | 各自实现 | `@deepseek-ai/dsh-client-ui-primitives` 导出 `SettingsForm` / `SettingsValueField`（官方 provider 卡在用） | 改为复用官方组件，删掉自带 CSS 卡壳 |
| 兼容校验 | 仅安装期 | `peerDependencies` 的 dsh 条目在安装 preflight 与启动 preflight 被消费（`includePrerelease: true`） | 补 `@deepseek-ai/dsh` peer |
| `ctx.web.registerSearchProvider` | 同 | 同（`dsh-web/lib/index.js:67`，重复 id 抛 `WEB_DUPLICATE_PROVIDER`） | **零漂移** |
| provider 形状 `{id, available(), search(request, signal)}` | 同 | 同（返回值仍被 seam `capSources` 兜底截断） | **零漂移** |

核对坐标（宿主安装目录 `@deepseek-ai/dsh/node_modules/@deepseek-ai/`）：
`dsh-settings/lib/types/schema.js`（`volatileForm` / `isVolatilePath` / `projectForm` / `plainConfig`）、
`dsh-settings/lib/index.js`（`describe` 的过滤条件、`configure`、`write` 的路径校验）、
`dsh-client-ui-settings/lib/client.js`（`ConfigFormController` / `whileServed`）、
`dsh-client-ui-renderer/lib/client.js`（`inject(key, callback)` → `ctx.effect(callback)`）、
`dsh-client-ui-plugin-manager/lib/client.js`（`plugins.item` 与 `view` 两种渲染）、
`dsh-client-ui-primitives/lib/index.js`（`SettingsForm` / `SettingsValueField` / `SettingsFormModel`）、
`dsh-config-editor/lib/index.js`（`edit()` 写回 profile patch）、
`dsh-app-boot/lib/index.js`（`evaluatePluginCompatibility`）。

## 2. 改动清单

1. **`src/index.js`（host 半）**
   - 删除 `settings.installSection` 接线；`Config` 保持从模块导出（这正是 0.1.7 的命名空间来源）。
   - `Config` 的 15 个字段全部加 `.volatile()`——设置卡要能改整段配置。
   - 新增 `readField()` / `readConfig()`：volatile 引用 `.get()`、普通值透传，新旧宿主形状兼容；
     `resolveOptions()` 先解引用再取值，provider 每次调用现读（设置卡保存即生效，无需重启）。
   - `ctx.inject(['settings'], (sctx) => sctx.effect(() => sctx.settings.configure({ auto: false }, ctx.fiber)))`
     —— 自带设置卡，关闭宿主按 schema 自动生成的页面。
2. **`lib/client.js`（浏览器半）**
   - `settingsScope.bind({namespace})` → `ctx.configForms.get(NS)`（快照/读写 API 同形，多出 `base/revision/mode`）。
   - 设置卡从 `settings.plugin.item`（keyed）迁到 `plugins.item`：`id: NS`、`order: 50`、
     `label: () => t('card.title')`（thunk，随 locale 现读）、`locale: NS`、`inject()` 载荷不变。
   - `slots.inject` 回调改「返回 disposer 的普通函数」；注册包进
     `ctx.effect(() => ctx.configForms.whileServed([NS], () => ctx.slots.inject(...)))`。
   - 卡片改**双视图**：`view === 'summary'` 返回一行描述（列表卡/详情页副标题由框架画），
     `page` 视图返回官方 `SettingsForm`，字段用 `SettingsValueField` 渲染（不再自带卡壳与 CSS）。
   - 新增只读守卫：`writable === false` 时 `save()` 不发起写入（与官方 `SettingsFormModel.save` 对齐）。
   - `inject` 短服务名：`["slots", "locale", "configForms"]`；`package.json` 的 `dsh.client.inject`
     声明四个**包名**（locale / renderer / settings / plugin-manager），保证这些 client bundle 先行加载。
3. **`package.json`**：版本 `0.3.0`；`dsh.engines.dsh` 与三个 dsh peer 用同一析取区间
   （`>=0.1.2-alpha.3 <0.1.8 || >=0.1.5-alpha.1 <0.1.6 || >=0.1.7-alpha.0 <0.1.8`）；
   `schemastery` 收紧为 `~3.18.4`（`.volatile()` 是 3.18.4 新增 API，3.18.2 没有）；
   新增 `@deepseek-ai/dsh` peer（兼容闸会读它）；devDeps 升到 `@deepseek-ai/dsh@0.1.7-rc.1`
   \+ `@deepseek-ai/dsh-settings@0.1.7-rc.1`（后者必须显式钉版本，否则会被 dsh 的旧 dep 牵连降到 0.1.5-rc.1）。
4. **`pnpm-workspace.yaml`**：`allowBuilds` 五个原生包显式落 `false`（pnpm 12 的
   `ERR_PNPM_IGNORED_BUILDS` 要求显式选择）；`minimumReleaseAgeExclude` 刷到 0.1.7-rc.1 那批。
5. **测试**：`entry.test.mjs`（命名空间来源 / volatile 活引用 / 判定表 15 行 / 词典键一致性 /
   已移除 API 的静态防回退）、`entry-smoke.test.mjs`（configure 接线）、`client-smoke.mjs`（重写：
   门控、disposer 契约、双视图、只读写入拒绝）、`anysearch.test.mjs`（Config 解引用）、
   `host-integration.test.mjs`（重写：**真宿主对象**驱动，见下）。
6. **文档**：双语 README 的环境要求/设置入口/测试表更新；本文件新增。

## 3. 真宿主对象测试（不是自造桩）

运行 `pnpm run test:host`（也含在 `pnpm test` 里）。依赖解析顺序：插件 devDeps（与宿主同版副本）
→ `@deepseek-ai/dsh` 包内的依赖树 → POSIX 全局安装目录；解析不到时**显式 skip 并打印原因**（不假绿）。

| 用例 | 用的是哪个真实对象 |
|---|---|
| 真实 Cordis + WebRuntime 全链路 | `@deepseek-ai/cordis` 的 `Context`、`@deepseek-ai/dsh-web` 的 `WebRuntime` |
| volatile 活引用 | `@deepseek-ai/cosmokit` 的 `createVolatile` / `updateVolatile`（复现宿主 `_commitVolatile` 提交语义） |
| 命名空间枚举判据 | `dsh-settings` 真实 `volatileForm` / `isVolatilePath`（`describe()` 与 `write()` 的过滤条件） |
| 设置卡看到的字段值 | `dsh-settings` 真实 `projectForm` / `plainConfig` |
| client 半契约 | 直接读宿主 client bundle 源码：`primitives` 的 `export {...}` 列表、renderer 的 `inject(key, callback)`、plugin-manager 的 `plugins.item` 双视图渲染 |
| 兼容闸 | `dsh-app-boot` 真实 `evaluatePluginCompatibility` + 宿主真实 `semver` |

## 4. 诚实缺口（未做/做不到的部分）

- 上述宿主对象测试**不启动完整 app-boot**（实时 Loader + ConfigEditor + SettingsService 需要真实
  profile 与全部宿主 bundle）。因此 `settings.describe()` / `mutate()` 的全链路只做到「用真实 schema
  助手复现其判据」这一层；端到端落在真机（本轮**尚未在真机 profile 上验证**，见第 5 节）。
- 浏览器侧的真机渲染（`__DSH_BOOT__` 下发、卡片在插件页的实际外观）同理只在桩 + 源码级断言层面
  验证过，未做真机浏览器核验。
- 本轮未跑隔离实例 E2E（上一轮 0.1.5 的那套流程见 `docs/EVIDENCE.md`）；升级 devDeps 后
  `pnpm test` 全绿（53 个 node:test 用例 + 24 项 client-smoke），但「真机装进 profile」这一步
  需要重启用户正在使用的 dsh 实例——**未经确认不做**。

## 5. 真机验证（待批准后再做的标准流程）

> ⛔ 重启 dsh 会打断用户正在使用的会话。以下步骤需要用户明确点头，或由用户亲自执行。

1. 备份 profile 补丁：`copy %APPDATA%\..\.dsh\profiles\web\cordis.patch.yml` 到临时位置。
2. 挂载：把 `- insert:` 块（`id: web-search-custom` / `name: dsh-web-search-custom` / 15 个 config 键）
   追加进 `~/.dsh/profiles/web/cordis.patch.yml`，并在
   `~/.dsh/profiles/web/package.json` 的 `dsh.profile.bundles` 里加上 `dsh-web-search-custom`。
3. 确认依赖可见：`pnpm --dir ~/.dsh/profiles/web link D:/DSH/dsh-web-search-custom`（或直接
   `dsh plugin --profile web add D:/DSH/dsh-web-search-custom`，它会替你做第 2、3 步与依赖链接）。
4. 重启 dsh web 实例（**需用户批准**）。
5. 核验三条活体证据：
   - `pluginInventory/list`（经宿主 RPC）出现 `web-search-custom`；
   - 首页 HTML 的 `__DSH_BOOT__.entries` 含 `dsh-web-search-custom`；
   - `curl` 首页后按 combo URL 取 client bundle，`grep -c 'plugins.item'` > 0（下发的是新代码）。
6. 打开 **设置 → 插件**，进入「自定义搜索（web-search-custom）」详情页：应看到 15 个字段 + 保存按钮，
   且**没有**宿主按 schema 自动生成的重复页（`configure({auto:false})` 生效）。
7. 改一个字段保存 → 立刻搜一次 → 确认新值生效（活引用）；再点该字段的「重置」保存 → 回落默认。

## 6. 归属说明

| 缺陷/改动 | 归属 |
|---|---|
| `engines` / `peer` 区间覆盖不了 0.1.7-rc.1 | **新版本引入的声明缺口**（0.1.7 之前本仓压根没声明 0.1.7） |
| `slots.inject` generator 形态失效 | **0.1.7 引入的破坏性变更**（renderer 改把 callback 交给 `ctx.effect`） |
| 客户端只读态仍发起写入 | **存量缺陷**（官方 `SettingsFormModel.save` 早有 `writable` 守卫，本仓手写表单漏了），本轮顺带修 |
| `client-smoke` 的 `unset` 桩不还原 base 层 | 测试桩失真（存量），本轮修 |
