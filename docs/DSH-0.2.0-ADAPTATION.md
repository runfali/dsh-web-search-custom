# dsh 0.2.0-rc.1 适配调研（本仓 0.2.0 适配轮）

日期：2026-09-29
对象：本机桌面端 `D:\DeepSeek Harness\`（`DeepSeek Harness.exe` `FileVersion 0.2.0-rc.1`）
本仓适配基线：dsh 0.1.7-rc.1

> 调研方式：0.2.0-rc.1 是二进制安装版，没有源码 diff 可读。本轮走
> 「解包 `resources/app.asar` → 调用宿主真实判定函数 → 真机闸实测」三步取证。

## 一、结论速览

| 面 | 结论 |
|---|---|
| 兼容闸判定口径 | **未变**（仍只认 peerDependencies） ⚠️ |
| 兼容区间 | **必须新增 0.2.0 clause**（唯一必改项） ⚠️ |
| 搜索选择语义（唯一可用 / 未注册 / 不可用） | 未变 ✅ |
| volatile 活引用 + `projectForm` 还原 | 未变 ✅ |
| `dsh.client.inject` 四个包名 | 均真实存在且为 web client 包 ✅ |
| 已移除的 `settingsScope` / `settings.plugin.item` | 未复活 ✅ |

## 二、失效证据（真机启动闸 stderr，修复前）

```
dsh: skipping profile bundle "dsh-web-search-custom": Error: Plugin dsh-web-search-custom@0.3.0
is incompatible with dsh 0.2.0-rc.1: peerDependencies {"@deepseek-ai/dsh":">=0.1.2-alpha.3
<0.1.8 || ...", "@deepseek-ai/dsh-settings":">=0.1.2-alpha.3 <0.1.8 || ..."}.
```

## 三、重要订正：`dsh.engines.dsh` 是死声明

全树 grep 确认 0.2.0-rc.1 里**没有任何 `dsh.engines` 的消费者**。判定函数
（`dsh-app-boot/lib/index.js:286-313`）**只遍历 `peerDependencies` 里
`@deepseek-ai/dsh` / `@deepseek-ai/dsh-*` 的条目**（`:294`），判据是
`semver.satisfies(runtime, range, { includePrerelease: true })`（`:300`）。

→ **peer 决定插件生死；`engines` 只影响 pnpm 安装期。** 两者必须逐字一致。
本仓 2 个 dsh-* peer 与 `engines` 现已由测试守护逐字一致。

## 四、两种 semver 模式（本轮实测订正）

| | 规则 | 谁在用 |
|---|---|---|
| 严格模式（默认） | 纯比较器 **AND** 预发布可见性规则 | `pnpm install` |
| 宿主闸模式 | **纯比较器**，可见性规则被绕过 | `dsh-app-boot:300`（决定加载） |

`includePrerelease: true` 绕过了「预发布只被同元组预发布区间满足」这条规则，于是
**上界自身的预发布也被放行**：`<0.1.8` 放行 `0.1.8-rc.1`、`<0.3.0` 放行 `0.3.0-alpha.0`；
但两者的**正式版**都被拒。

> **本仓此前已正确记录这一现象**（`tests/host-integration.test.mjs` 的注释：
> "preflight uses includePrerelease:true, so the legacy range passes THIS gate too"），
> 本轮把它扩到 0.2.0 线并同步更新了断言。

**上一轮的一处断言被有意翻转**：`host-integration.test.mjs` 原先断言
`evaluatePluginCompatibility(pkg, {}, '0.2.0')` **必须被拒**——那是「0.2.0 未验证就先拦住」
的临时状态。本轮已真机验证 → 翻转为放行；越界反证改用真正未验证的 `0.3.0`。

## 五、改动清单

1. `package.json`：**版本号保持 `0.3.0`**（本仓走自有编号，不跟宿主发布号）；
   `dsh.engines.dsh` 与 2 个 dsh-* peer 各追加 `|| >=0.2.0-alpha.0 <0.3.0`；
   devDeps 从 `0.1.7-rc.1` 升到 `0.2.0-rc.1`。
2. `tests/entry.test.mjs`：
   - 判定表扩到 18 行，`0.2.0` 由 `false` 翻转为 `true`（有意翻转）；
   - 新增旧三段区间的 0.2.0 反证；
   - 新增「peer 区间必须与 `dsh.engines.dsh` 逐字一致」断言；
   - 补注释说明该表建模的是**严格模式**（上界预发布列为 false，与宿主闸不同）。
3. `tests/host-integration.test.mjs`：兼容闸断言按要求改写
   （0.2.0-rc.1 与 0.2.0 放行；`0.3.0` 拒绝；旧区间在 0.1.7-rc.1 与 0.2.0-rc.1 下
   在宿主闸放行、在严格模式拒绝——两种模式都验，缺一会把结论说反）。
4. `pnpm-workspace.yaml` / `README.md` / `README.zh-CN.md`：区间与白名单更新。

**未改**：`src/*`（搜索选择、AnySearch/SearXNG 取数、设置卡）、`lib/client.js`、
`cordis.patch.yml` —— 运行期契约无漂移。

## 六、测试与验证

- `node --test tests/*.test.mjs`：**54 例全绿**。
- `tests/host-integration.test.mjs`：**10 组通过**（用**真实 dsh 0.2.0-rc.1 包**驱动）：
  真实 Cordis + WebRuntime 全链路、真实 volatile 提交后立刻读到新值、
  真实 `describe()` 枚举到本命名空间、`projectForm` 还原、真实 primitives 导出核验、
  以及**真实兼容闸**接受 0.2.0 线并拒绝 0.3.0。
- `tests/client-smoke.mjs`：24 项通过。
- 测试现运行在 **0.2.0-rc.1 真实开发依赖**下。

## 七、诚实缺口

1. **真实外部搜索端点未做端到端**（AnySearch/Tavily 需网络与配额）。测试覆盖了
   病态载荷降级、超时 abort、调用方取消等健壮性路径，未覆盖真实远端响应。
2. 判定表中「上界预发布」的行为是推导 + 宿主真实 semver 实测得出，未安装历史宿主真机验证。
