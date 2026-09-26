/**
 * client-smoke.mjs —— lib/client.js（浏览器半）结构加载测试。
 *
 * 构造最小 window.__ModuleLoader__ + require 桩加载 client bundle，跑 apply，验证
 * dsh 0.1.7-rc.1 契约（旧 settingsScope / settings.plugin.item 已移除）：
 *   1. bundle id 与包名一致（dsh-client-modules 契约）；exports.inject 为短服务名
 *   2. locale 词典注册（zh/en 键集合一致，覆盖全部 label/hint/UI 文案）
 *   3. configForms.get(ns) 绑定，ns = web-search-custom
 *   4. configForms.whileServed 门控：命名空间未被服务时不注册（停用即摘除）
 *   5. plugins.item 槽位注册（id/order/label thunk/locale/inject 载荷）
 *      + slots.inject 回调必须是「返回 disposer 的普通函数」（generator 形态已废弃）
 *   6. 双视图：view === "summary" 返回一行文案；page 视图返回框架 SettingsForm 表单
 *   7. 表单保存链路：改字段 → 保存落 user 层；重置 → unset；数字字段落 number
 *   8. 只读态：全部输入禁用、行级重置禁用；且只读时 save() 不发起写入
 *
 * 运行：node tests/client-smoke.mjs
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const PASS = []
const ok = (label) => { PASS.push(label); console.log('  ✓ ' + label) }

// ---- 最小 React / JSX 桩（jsx 与 jsxs 同构：children 一律从 props.children 取）----
function makeElement(type, props) {
  const p = props || {}
  const raw = p.children === undefined || p.children === null ? [] : p.children
  const children = (Array.isArray(raw) ? raw.flat(Infinity) : [raw]).filter((c) => c !== null && c !== undefined && c !== false)
  return { type, props: p, children }
}
const jsxStub = (type, props) => makeElement(type, props)
const reactStub = {
  useSyncExternalStore: (subscribe, getSnapshot) => { subscribe(() => {}); return getSnapshot() },
}

// ---- 官方表单原语桩（逐行对齐 @deepseek-ai/dsh-client-ui-primitives 的
//      settings-form 实现：SettingsForm 的只读提示/保存按钮禁用条件、SettingsValueField
//      的覆盖胶囊与重置按钮。桩失真 = 测试白跑，故按源码 1:1 复刻关键分支）----
function SettingsForm(props) {
  const { state, labels } = props
  if (!state.available) return jsxStub('p', { className: 'form-unavailable', role: 'status', children: labels.unavailable })
  const blocked = !state.dirty || state.invalid || state.saving
  return jsxStub('div', { className: 'form', children: [
    !state.writable ? jsxStub('p', { className: 'form-readOnly', role: 'status', children: labels.readOnly }) : null,
    props.children,
    jsxStub('div', { className: 'form-footer', children: [
      state.failed ? jsxStub('p', { className: 'form-failed', role: 'status', children: labels.saveFailed }) : null,
      jsxStub('button', { type: 'button', className: 'form-save', disabled: blocked, onClick: props.onSave, children: state.saving ? labels.saving : labels.save }),
    ] }),
  ] })
}
function SettingsValueField(props) {
  const hasMessage = props.invalid === true || Boolean(props.hint)
  return jsxStub('div', { className: 'field', children: [
    jsxStub('div', { className: 'field-head', children: [
      jsxStub('label', { className: 'field-label', htmlFor: props.id, children: props.label }),
      props.overridden ? jsxStub('span', { className: 'field-badges', children: [
        jsxStub('span', { className: 'field-badge', children: props.overriddenLabel }),
        jsxStub('button', { type: 'button', className: 'field-reset', disabled: props.disabled, onClick: props.onReset, children: props.resetLabel }),
      ] }) : null,
    ] }),
    jsxStub('input', {
      id: props.id,
      className: 'field-input',
      type: 'text',
      ...(props.numeric === true ? { inputMode: 'numeric' } : {}),
      ...(props.invalid ? { 'aria-invalid': true } : {}),
      value: props.text,
      placeholder: props.placeholder ?? '',
      disabled: props.disabled,
      onChange: (event) => { props.onEdit(event.target.value) },
    }),
    hasMessage ? jsxStub('p', { className: props.invalid ? 'field-invalid' : 'field-hint', children: props.invalid ? props.invalidLabel : props.hint }) : null,
  ] })
}
const primitivesStub = { SettingsForm, SettingsValueField }

let bundleFactory = null
let bundleId = null
globalThis.window = {
  __ModuleLoader__: {
    load({ id, factory }) { bundleId = id; bundleFactory = factory },
  },
}

const requireStub = (specifier) => {
  if (specifier === 'react') return reactStub
  if (specifier === 'react/jsx-runtime') return { jsx: jsxStub, jsxs: jsxStub }
  if (specifier === '@deepseek-ai/dsh-client-ui-primitives') return primitivesStub
  throw new Error('unexpected require: ' + specifier)
}

new Function('code', 'return eval(code)')(readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8'))

console.log('== bundle 加载 ==')
assert.equal(bundleId, 'dsh-web-search-custom', 'bundle id 必须等于包名'); ok('bundle id = dsh-web-search-custom')
assert.ok(bundleFactory, 'factory 存在')

const exportsRef = bundleFactory(requireStub)
assert.deepEqual([...exportsRef.inject], ['slots', 'locale', 'configForms'])
ok('exports.inject = [slots, locale, configForms]（短服务名，0.1.7 契约）')

// ---- 桩环境：configForms + locale + slots ----
const NS = 'web-search-custom'
const localeDicts = {}
let boundNamespace = null
const scopeListeners = new Set()
const DEFAULT_VALUE = {
  api: 'auto',
  url: 'https://api.anysearch.com/v1/search',
  maxResults: 10,
  apiKey: '', method: 'GET', body: '{"query":"{query}"}', headers: '{}',
  authHeader: 'Authorization', authScheme: 'Bearer', timeoutMs: 30000,
  resultsPath: 'results', urlField: 'url', titleField: 'title', snippetField: 'content', publishedField: 'publishedDate',
}
const scopeState = { status: 'ready', writable: true, value: { ...DEFAULT_VALUE }, user: {}, base: { ...DEFAULT_VALUE }, revision: 1, mode: 'host' }
const scopeStub = {
  getSnapshot: () => scopeState,
  subscribe(fn) { scopeListeners.add(fn); return () => scopeListeners.delete(fn) },
  set: async (key, value) => {
    scopeState.user[key] = value
    scopeState.value = Object.assign({}, scopeState.value, { [key]: value })
    scopeListeners.forEach((fn) => fn())
    return true
  },
  unset: async (key) => {
    // unset = 从 user 层移除，resolved value 回落到 base（composition 层）
    delete scopeState.user[key]
    const next = Object.assign({}, scopeState.value)
    if (Object.prototype.hasOwnProperty.call(scopeState.base, key)) next[key] = scopeState.base[key]
    else delete next[key]
    scopeState.value = next
    scopeListeners.forEach((fn) => fn())
    return true
  },
}

// configForms 桩：get(ns) 返回 ConfigFormController 同形对象；whileServed 只在
// 命名空间已被服务时调用 register（返回 disposer），且返回自己的 disposer。
const servedNamespaces = new Set()
const whileServedCalls = []
let gateDisposer = null
let whileServedDisposer = null
const configFormsStub = {
  get(ns) { boundNamespace = ns; return scopeStub },
  whileServed(namespaces, register) {
    whileServedCalls.push([...namespaces])
    const served = namespaces.filter((ns) => servedNamespaces.has(ns))
    if (served.length > 0) gateDisposer = register(new Set(namespaces))
    whileServedDisposer = () => { if (gateDisposer) { gateDisposer(); gateDisposer = null } }
    return whileServedDisposer
  },
}

let slotEntry = null
let injectCallbacks = 0
const slotsStub = {
  inject(slot, callback) {
    injectCallbacks += 1
    const disposer = callback()
    // 0.1.7 契约：callback 必须「返回 disposer」；generator 形态会在这里当场暴露
    assert.equal(typeof disposer, 'function', 'slots.inject callback must return a disposer (generator form is gone)')
    return disposer
  },
  register(def, component) {
    slotEntry = { def, component }
    return () => { slotEntry = null }
  },
}
const ctxStub = {
  fiber: { name: 'dsh-web-search-custom' },
  effect(fn) { const d = fn(); return typeof d === 'function' ? d : () => {} },
  locale: {
    register(ns, dict) { localeDicts[ns] = dict },
    bind(ns) { return (key) => (localeDicts[ns] && localeDicts[ns].zh[key]) ?? key },
  },
  configForms: configFormsStub,
  slots: slotsStub,
}

console.log('== whileServed 门控 ==')
exportsRef.apply(ctxStub)
assert.deepEqual(whileServedCalls[0], [NS], '必须按本命名空间门控')
assert.equal(slotEntry, null, '命名空间未被服务时不得注册槽位条目')
assert.equal(injectCallbacks, 0, '未被服务时不得触碰 slots.inject')
ok('未服务 → 不注册（插件停用/未加载即无痕）')

assert.equal(boundNamespace, NS, 'configForms.get 绑定 namespace = ' + NS)
ok('configForms.get(' + NS + ') 绑定')

servedNamespaces.add(NS)
exportsRef.apply(ctxStub)   // 重新 apply（门控打开）
assert.equal(slotEntry === null, false, '服务后必须注册槽位条目')
ok('宿主开始服务 → 槽位条目注册（callback 返回 disposer）')

console.log('== locale ==')
const zh = localeDicts[NS].zh
const en = localeDicts[NS].en
assert.ok(zh && en, 'zh/en 词典存在')
for (const key of Object.keys(zh)) {
  assert.ok(Object.prototype.hasOwnProperty.call(en, key), 'en 应含 zh 全部键: ' + key)
}
assert.equal(Object.keys(en).length, Object.keys(zh).length, 'zh/en 键数量一致')
ok('zh/en 键集合一致 (' + Object.keys(zh).length + ' 键)')
for (const key of ['card.title', 'card.description', 'save', 'saving', 'saveFailed', 'unavailable', 'readOnly', 'overridden', 'reset', 'invalid']) {
  assert.ok(zh[key], 'zh 翻译键缺失: ' + key)
}
ok('卡片 UI 翻译键齐全（含 SettingsForm 的框架文案）')

console.log('== slot ==')
assert.equal(slotEntry.def.name, 'plugins.item', 'slot 名（0.1.7 插件页）')
assert.equal(slotEntry.def.id, NS, 'id 必须 = 宿主行 id（详情页按 id 匹配）')
assert.equal(slotEntry.def.order, 50)
assert.equal(slotEntry.def.locale, NS)
assert.equal(typeof slotEntry.def.label, 'function', 'label 必须是 thunk（随 locale 现读）')
assert.equal(slotEntry.def.label(), zh['card.title'])
const injected = slotEntry.def.inject()
assert.ok(injected.hooks && injected.hooks.customSearch, 'hooks.customSearch 提供')
assert.equal(typeof injected.edit, 'function')
assert.equal(typeof injected.resetField, 'function')
assert.equal(typeof injected.save, 'function')
assert.equal(typeof injected.discard, 'function')
ok('plugins.item 注册契约完整 (id/order/label thunk/hooks.useCustomSearch + edit/resetField/save/discard)')

// ---- 渲染辅助：框架把 hooks 键转成 use<Name> hook、actions 原样展开 ----
const Card = slotEntry.component
const t = (key) => zh[key] ?? key
const cardProps = (view) => ({
  ...injected,
  useCustomSearch: (selector) => selector(injected.hooks.customSearch.getSnapshot()),
  view,
  t,
})
const snap = () => injected.hooks.customSearch.getSnapshot()

const FIELD_ID_PREFIX = 'plugin-config-web-search-custom-'
/** 在子树里找第一个 <label htmlFor>，即该字段的 id。 */
function findLabelId(node) {
  if (node === null || node === undefined || typeof node !== 'object') return undefined
  if (Array.isArray(node)) {
    for (const child of node) { const found = findLabelId(child); if (found) return found }
    return undefined
  }
  if (node.type === 'label') return node.props?.htmlFor
  for (const child of node.children || []) { const found = findLabelId(child); if (found) return found }
  return undefined
}
function collect(root) {
  const texts = []
  const inputs = []
  const buttons = []
  // 行级控件按真实结构归属：SettingsValueField 渲染 div.field 包住 label + input + 行级按钮，
  // 字段名从 label.htmlFor 反推（不依赖渲染顺序，也不给桩发明假属性）
  const walk = (node, field) => {
    if (node === null || node === undefined || node === false) return
    if (typeof node === 'string' || typeof node === 'number') { texts.push(String(node)); return }
    if (Array.isArray(node)) { node.forEach((child) => walk(child, field)); return }
    if (typeof node.type === 'function') { walk(node.type(node.props), field); return }
    let next = field
    if (String(node.props?.className) === 'field') {
      // label 嵌在 div.field-head 里，递归找（不依赖具体层级）
      const id = findLabelId(node)
      next = String(id || '').replace(FIELD_ID_PREFIX, '')
    }
    if (node.type === 'input') inputs.push(node)
    if (node.type === 'button') buttons.push({ element: node, field: next })
    if (typeof node.props?.value === 'string' && node.props.value !== '') texts.push(node.props.value)
    ;(node.children || []).forEach((child) => walk(child, next))
  }
  walk(root, '')
  return { texts, inputs, buttons }
}
const buttonsByClass = (buttons, suffix) => buttons.filter((b) => String(b.element.props.className).endsWith(suffix))

console.log('== 双视图 ==')
const summary = Card(cardProps('summary'))
assert.equal(typeof summary, 'string', 'summary 视图必须只返回一行文案（框架画卡壳）')
assert.equal(summary, zh['card.description'])
ok('view="summary" → 一行描述（不重复画卡壳）')

const page = collect(Card(cardProps('page')))
const pageText = page.texts.join(' ')
for (const needle of [
  '接口档位（api）', '搜索 URL', 'API Key（留空 = 免 key 匿名档）', '结果条数上限', '请求方法（仅 generic）',
  'POST body 模板', '额外请求头（JSON）', '鉴权请求头名（仅 generic）', '鉴权 scheme（仅 generic）',
  '超时（毫秒）', '结果数组路径（仅 generic）', 'URL 字段', '标题字段', '摘要字段', '发布日期字段',
  '保存',
]) {
  assert.ok(pageText.includes(needle), 'page 视图文案应含: ' + needle)
}
assert.equal(page.inputs.length, 15, '15 个输入框，实际 ' + page.inputs.length)
const saveButtons = buttonsByClass(page.buttons, 'form-save')
assert.equal(saveButtons.length, 1, 'SettingsForm 提供唯一保存按钮（无 discard 按钮）')
ok('view="page" → 框架 SettingsForm：15 字段 + 保存按钮')

console.log('== 表单保存链路 ==')
const state = snap()
assert.equal(state.dirty, false, '初始不脏')
assert.equal(state.writable, true, '可写')
assert.equal(state.available, true, '可用')
assert.equal(saveButtons[0].element.props.disabled, true, '未改动时保存按钮置灰（blocked = !dirty || invalid || saving）')
assert.equal(Object.keys(state).filter((k) => typeof state[k] === 'object' && state[k] !== null).length, 15, '15 个字段快照')
injected.edit('url', 'http://127.0.0.1:9999/search?format=json&q={query}')
assert.equal(snap().dirty, true, '编辑后脏')
await injected.save()
assert.equal(scopeState.user.url, 'http://127.0.0.1:9999/search?format=json&q={query}', '保存落到 user 层')
assert.equal(snap().dirty, false, '保存后不脏')
ok('编辑 → 保存 → user 层落值')

injected.edit('api', 'anysearch')
injected.edit('apiKey', 'sk-live-1')
await injected.save()
assert.equal(scopeState.user.api, 'anysearch', 'api 档位落到 user 层')
assert.equal(scopeState.user.apiKey, 'sk-live-1', 'apiKey 落到 user 层')
ok('api / apiKey（带 key 走鉴权档）落值')

injected.edit('apiKey', '')
await injected.save()
ok('apiKey 清空 = 免 key 匿名档（客户端原样落盘，语义由 host 判定）')
injected.edit('apiKey', 'sk-live-1')
await injected.save()

injected.edit('maxResults', '5')
await injected.save()
assert.equal(scopeState.user.maxResults, 5, 'maxResults 以 number 落盘')
ok('maxResults 数字类型正确 (number)')

injected.edit('timeoutMs', '45000')
await injected.save()
assert.equal(scopeState.user.timeoutMs, 45000, '数字字段以 number 落盘（不是字符串）')
ok('数字字段类型正确 (number)')

injected.resetField('url')
assert.equal(snap().dirty, true, '重置后脏')
await injected.save()
assert.equal(Object.prototype.hasOwnProperty.call(scopeState.user, 'url'), false, '重置 = 从 user 层移除（回落默认）')
ok('重置 → unset 回落到默认值')

injected.edit('method', 'BANANA')
await injected.save()
// 字段是自由文本框：客户端原样落盘，枚举归一化由 host resolveOptions 兜底
// （见 entry.test.mjs「method 归一化」用例）。这里只固化「原样落盘」这条契约。
assert.equal(scopeState.user.method, 'BANANA', '客户端按输入原样落盘，不做隐式改写')
ok('method 字段原样落盘（host 侧归一化为 GET，跨层约定）')
injected.edit('method', 'GET')
await injected.save()

injected.edit('maxResults', 'not-a-number')
assert.equal(snap().invalid, true, '非法数字 → invalid（保存被拒）')
const invalidPage = collect(Card(cardProps('page')))
assert.equal(buttonsByClass(invalidPage.buttons, 'form-save')[0].element.props.disabled, true, 'invalid 时保存按钮必须置灰')
assert.ok(invalidPage.texts.includes('请输入有效值'), 'invalid 提示文案应出现')
ok('非法输入 → invalid + 保存置灰 + 提示文案')
await injected.discard()

console.log('== 只读态 ==')
scopeState.writable = false
scopeListeners.forEach((fn) => fn())   // scope 变更后必须通知订阅者，卡片才重算快照
const readOnlyPage = collect(Card(cardProps('page')))
assert.ok(readOnlyPage.texts.join(' ').includes('该设置为只读'), '只读提示应出现')
assert.equal(readOnlyPage.inputs.length, 15, '只读态仍渲染 15 个输入框')
assert.ok(readOnlyPage.inputs.every((input) => input.props.disabled === true), '只读态下全部输入必须禁用')
assert.equal(buttonsByClass(readOnlyPage.buttons, 'form-save')[0].element.props.disabled, true, '无待提交改动时保存按钮置灰')
ok('只读态：' + readOnlyPage.inputs.length + ' 个输入框全部 disabled')

// 只读 + 有草稿：客户端不得发起写入（官方 SettingsFormModel.save 同款守卫）
injected.edit('url', 'http://readonly-should-not-write/')
const beforeReadOnly = scopeState.user.url
await injected.save()
assert.equal(scopeState.user.url, beforeReadOnly, '只读部署下 save() 不得写入 scope')
ok('只读 + 草稿 → save() 不发起写入')
await injected.discard()

// 回到可写态并制造 dirty：动作按钮必须可用（不得恒禁用——交互层盲区守护）
scopeState.writable = true
scopeListeners.forEach((fn) => fn())
injected.edit('url', 'http://127.0.0.1:19999/search?format=json&q={queryRaw}')
const writablePage = collect(Card(cardProps('page')))
const writableSave = buttonsByClass(writablePage.buttons, 'form-save')[0]
assert.equal(writableSave.element.props.disabled, false, '可写 + dirty 时保存必须可用')
const writableResets = buttonsByClass(writablePage.buttons, 'field-reset')
const overriddenCount = Object.keys(scopeState.user).length
// 「已覆盖」= user 层有该键；此外当前暂存的一次 set 也会乐观显示徽标（保存前的预览）
assert.equal(writableResets.length, overriddenCount + 1, '每个已覆盖字段 + 暂存字段各一个重置按钮')
assert.ok(writableResets.length > 0, '本用例应至少有一个已覆盖字段')
assert.ok(writableResets.every((b) => b.element.props.disabled === false), '可写态下重置按钮必须可用')
ok('可写态 + dirty：保存与 ' + writableResets.length + ' 个行级重置按钮均可用（非恒禁用）')

// 行级重置：点击暂存一次 clear，保存后该字段从 user 层移除（回落默认层）。
// 目标字段直接从按钮 id 反推，避免依赖按钮顺序。
const resetFieldName = String(writableResets[0].field)
assert.notEqual(resetFieldName, '', '行级重置按钮必须能归属到具体字段')
assert.equal(Object.prototype.hasOwnProperty.call(scopeState.user, resetFieldName), true, '重置前该字段在 user 层')
writableResets[0].element.props.onClick()
assert.equal(snap().dirty, true, '行级重置后应变为待保存')
await injected.save()
assert.equal(Object.prototype.hasOwnProperty.call(scopeState.user, resetFieldName), false,
  '保存后 ' + resetFieldName + ' 回落默认层')
ok('行级重置按钮 → clear → 保存后 ' + resetFieldName + ' 回落默认层')
await injected.discard()

console.log('== 命名空间未服务（status !== ready）==')
scopeState.status = 'idle'
scopeListeners.forEach((fn) => fn())
const unavailablePage = collect(Card(cardProps('page')))
assert.equal(unavailablePage.inputs.length, 0, '不可用时不渲染输入框')
assert.ok(unavailablePage.texts.includes(zh['unavailable']), 'unavailable 文案应出现')
ok('status !== ready → 明确告知不可用，而不是渲染无效字段')
scopeState.status = 'ready'
scopeListeners.forEach((fn) => fn())

console.log('== 卸载清理 ==')
assert.ok(scopeListeners.size > 0, 'scope 订阅已建立')
assert.equal(typeof whileServedDisposer, 'function', 'whileServed 必须返回 disposer（交给 ctx.effect 回收）')
whileServedDisposer()
assert.equal(slotEntry, null, '注册 disposer 调用后槽位条目被摘除')
ok('configForms.whileServed 的 disposer 摘除槽位条目（停用即无痕）')

console.log('\nclient-smoke: ' + PASS.length + ' 项全部通过')
