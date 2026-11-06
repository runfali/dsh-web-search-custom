# dsh 0.2.2-rc.1 适配调研（本仓 0.2.2 适配轮）

日期：2026-11-06
对象：本机桌面端 `D:\DeepSeek Harness\`（`resources/app.asar/dsh/package.json` = `0.2.2-rc.1`）
本仓适配基线：0.2.1-rc.2 轮（提交 `d8be4ac`）

> 取证方式：解包 `resources/app.asar` 里的宿主包树 → 逐条比对本插件实际消费的契约 →
> 用宿主**自带的** `evaluatePluginCompatibility` 对真实 manifest 跑判定闸。

## 一、结论速览

| 面 | 结论 |
|---|---|
| 兼容区间 | **必须新增 0.2.2 clause**（唯一必改项） ⚠️ |
| schemastery peer | **必须改析取**（宿主 3.19.0，0.2.1 线是 3.18.4） ⚠️ |
| `ctx.web` 服务与 provider 注册 | 未变 ✅ |
| `settings.configure()` / volatileForm | 未变 ✅ |
| client `slots` / `configForms` / `locale` | 未变 ✅ |
| `dsh.client.inject` 四个包名 | 均真实存在且为 web client 包 ✅ |
| `src/` 与 `lib/client.js` | **零改动** ✅ |

## 二、契约取证（0.2.2-rc.1 宿主源码，行号为本版）

- `dsh-web/lib/index.js:41` `var WebRuntime = class extends Service`，`:57` `super(ctx, "web")`
  → 服务名仍是 `web`，本仓 `inject = ['web']` 不变。
- `:69` `registerSearchProvider(provider)`，`:82-89` `registerProvider(store, provider)`
  （以 `provider.id` 为键、`:84` 走 `ctx.effect` 返回 disposer）；`:99` `search(request, signal)`
  仍由 seam 侧 `capSources(...)` 截断；`:110` `searchReady(llmProvider)`、`:114`
  `selectSearchProvider()` 语义未变。
- `:48-51` `static Config = z.object({ searchProvider: z.string().volatile(), fetchProvider: ... })`
  → 两个字段**仍是 `.volatile()`**，测试夹具必须继续传 `createVolatile()` 活引用。
- `dsh-settings/lib/index.js:330` `super(ownerContext, "settings")`（变量名与 0.2.1 的 `ctx` 不同，
  别按变量名写死）；`:370` `configure(presentation, owner = this.ctx.fiber)` → 本仓
  `sctx.settings.configure({ auto: false }, ctx.fiber)` 的第二个实参语义不变。
- client 侧：`dsh-client-ui-renderer/lib/client.js:1348` `super(ctx, "slots")`、`:1368`
  `inject(key, callback)`；`dsh-client-ui-settings/lib/client.js:926` `settingsSchema`、`:1270`
  `configForms`、`:1294` `get(entryId)`、`:1315` `whileServed(namespaces, register)`；
  `dsh-client-locale/lib/client.js:1675` `register(ns, localeOrDicts, dict)`、`:1702` `bind(ns)`。
  → `lib/client.js` 的 `inject = ["slots", "locale", "configForms"]` 三件套全部成立。
- 宿主自带 `@deepseek-ai/schemastery` = **3.19.0**，而 `dsh-settings@0.2.2-rc.1` 的 peer 正是
  `~3.19.0`；本仓原 peer 写 `~3.18.4`，装机会被 pnpm 拉一份 3.18.4 当夹具。

## 三、判定闸（0.2.2-rc.1 形状，未变）

`dsh-app-boot/lib/index.js:1097-1116` `unmetRequirements()`：**顶层** `engines.dsh` 存在则它单独
判定、peers 被忽略；否则逐条 peer（只看 `@deepseek-ai/dsh` 与 `@deepseek-ai/dsh-*`）。
`:1094` `satisfies(rt, range)` = `semver.satisfies(rt, range, { includePrerelease: true })`；
`:1129` `evaluatePluginCompatibility(manifest, exemptions, runtimeVersion)`，返回 `undefined` = PASS；
`:1089` `getDshRuntimeVersion()`。

本仓把区间写在**嵌套的** `dsh.engines.dsh` → 不属于 `fields.engines`，实际仍由 peers 决定。
两者必须逐字一致（`tests/entry.test.mjs` 已守护）。

## 四、真闸实测

`node D:/DSH/_tools/gate-manifest-022.mjs package.json 0.2.2-rc.1` → **PASS**
`node D:/DSH/_tools/gate-manifest-022.mjs package.json 0.3.0`   → **REJECT**
（返回体 `requirements` 同时列出 `@deepseek-ai/dsh` 与 `@deepseek-ai/dsh-settings`，
证明闸真的读了这两条 peer，不是空转。）

严格 vs 宿主闸的老结论在本轮同样成立：旧五段区间在 `includePrerelease` 下**本来就放行**
`0.2.2-rc.1`，被拒的是 pnpm 严格模式 —— 故 0.2.2 段修的是**安装期**，不是加载闸。

## 五、改动清单

1. `package.json`
   - `dsh.engines.dsh` 与两个 dsh-* peer 三串各追加 `|| >=0.2.2-alpha.0 <0.3.0`（逐字一致）；
   - `@deepseek-ai/schemastery` peer 改 `~3.18.4 || ~3.19.0`（0.2.1 线宿主 3.18.4、0.2.2 线 3.19.0，
     两者都含 `.volatile()`）；
   - devDependencies：`dsh` / `dsh-client-ui-primitives` / `dsh-settings` → `0.2.2-rc.1`，
     并把 `@deepseek-ai/schemastery` **显式 pin 到 3.19.0**（不 pin 时 pnpm 会按旧 peer 装回
     3.18.4 当夹具，整套测试静默跑在旧版本上）；
   - `files` 增加 `docs/DSH-0.2.2-ADAPTATION.md`。
   - **版本号保持本仓自有编号 `0.3.0`**（不跟宿主发布号，同 0.2.0 / 0.2.1 两轮决策）。
2. `pnpm-workspace.yaml`：`minimumReleaseAgeExclude` 278 条版本串由 `0.2.1-rc.2` 刷新为 `0.2.2-rc.1`。
3. `tests/entry.test.mjs`：判定表把 `0.2.2-rc.1` 从「分叉行」移入放行区并补 `0.2.2-alpha.0` /
   `0.2.2` 两行；新增「旧五段区间在严格模式下覆盖不了 `0.2.2-rc.1`」反证；
   schemastery 断言改为按 `||` 逐段展开后校验（3.18.2 拒、3.18.4 与 3.19.0 均放行）。
4. `tests/host-integration.test.mjs`：真闸断言补 `0.2.2-rc.1` / `0.2.2`；新增旧五段区间
   在真闸下仍放行的语义澄清，以及严格模式覆盖 / 旧五段不覆盖的双向断言。
5. `README.md` / `README.zh-CN.md`：区间串、「已验证宿主」与新增 0.2.2 小节。

**`src/index.js` 与 `lib/client.js` 未改一行。**

## 六、验证证据

| 检查 | 结果 |
|---|---|
| `node --test tests/*.test.mjs` | **56 pass / 0 fail / 0 skipped**（基线 55 + 本轮新增 1 条反证） |
| `node tests/client-smoke.mjs` | 24 项全通过 |
| `pnpm peers check` | No peer dependency issues found |
| 真闸 @0.2.2-rc.1 | PASS |
| 真闸 @0.3.0（负例） | REJECT |

夹具漂移只有三处，且全是本轮改动自身引起的（两条判定表断言 + 一条 schemastery 断言），
没有一处是宿主侧契约变化 —— 这正是 `src/` 可以零改动的证据。

## 七、诚实缺口

本插件当前**不在** `~/.dsh/profiles/{desktop,web}/package.json` 的 dependencies 或 bundles 里
（desktop 的 `node_modules` 下留有一个指向本仓的 junction），所以本轮**没有做重启验收**：
门卫加载链上没有任何一环真的会挂载它。适配在「仓 + 真实判定闸 + 宿主源码契约」三层已闭环，
但「装上后在 0.2.2-rc.1 里跑起来」这一步等真要挂载时再验。
