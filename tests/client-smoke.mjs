/**
 * client-smoke.mjs —— lib/client.js（浏览器半）结构加载测试。
 *
 * 构造最小 window.__ModuleLoader__ + require 桩加载 client bundle，跑 apply，验证：
 *   1. bundle id 与包名一致（dsh-client-modules 契约），exports.inject 为短服务名
 *   2. locale 词典注册（zh/en 键集合一致，覆盖全部 label/hint/UI 文案）
 *   3. settingsScope 绑定 namespace = web-search-custom
 *   4. settings.plugin.item 槽位注册（key/locale/inject 载荷 hooks + actions）
 *   5. 卡片渲染：展开态含全部 13 个字段行与保存/放弃按钮
 *   6. 表单保存链路：改字段 → 保存落 user 层；重置 → unset
 *   7. 只读态：全部输入禁用（客户端交互层盲区守护）
 *
 * 运行：node tests/client-smoke.mjs
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const PASS = []
const ok = (label) => { PASS.push(label); console.log('  ✓ ' + label) }

function makeElement(type, props, ...children) {
  return { type, props: props || {}, children: children.flat().filter((c) => c !== null && c !== undefined) }
}
let renderDepth = 0
function renderTree(node) {
  if (node === null || node === undefined || typeof node === 'string' || typeof node === 'number') return
  if (typeof node.type === 'function') {
    renderDepth += 1
    if (renderDepth > 50) throw new Error('component tree too deep — likely infinite recursion')
    const children = node.type(node.props)
    renderTree(children)
    renderDepth -= 1
    return
  }
  for (const child of node.children || []) renderTree(child)
}
const reactStub = {
  useState: (init) => [typeof init === 'boolean' ? true : (typeof init === 'function' ? init() : init), () => {}],
  useSyncExternalStore: (subscribe, getSnapshot) => { subscribe(() => {}); return getSnapshot() },
}
const jsxStub = (type, props) => {
  const pc = props && props.children
  const children = pc === undefined || pc === null ? [] : (Array.isArray(pc) ? pc : [pc])
  return makeElement(type, props, ...children)
}
const primitivesStub = new Proxy({}, { get: () => function Icon() {} })

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
assert.deepEqual([...exportsRef.inject], ['slots', 'locale', 'settingsScope', 'connection', 'remote'])
ok('exports.inject = [slots, locale, settingsScope, connection, remote]（短服务名）')

// ---- 桩环境：settingsScope + locale + slots ----
const NS = 'web-search-custom'
const localeDicts = {}
let boundNamespace = null
const scopeListeners = new Set()
const DEFAULT_VALUE = {
  url: 'http://127.0.0.1:8080/search?format=json&q={query}',
  apiKey: '', method: 'GET', body: '{"query":"{query}"}', headers: '{}',
  authHeader: 'Authorization', authScheme: 'Bearer', timeoutMs: 30000,
  resultsPath: 'results', urlField: 'url', titleField: 'title', snippetField: 'content', publishedField: 'publishedDate',
}
const scopeState = { status: 'ready', writable: true, value: { ...DEFAULT_VALUE }, user: {} }
const scopeStub = {
  bind({ namespace }) { boundNamespace = namespace; return scopeStub },
  getSnapshot: () => scopeState,
  subscribe(fn) { scopeListeners.add(fn); return () => scopeListeners.delete(fn) },
  set: async (key, value) => {
    scopeState.user[key] = value
    scopeState.value = Object.assign({}, scopeState.value, { [key]: value })
    scopeListeners.forEach((fn) => fn())
    return true
  },
  unset: async (key) => {
    delete scopeState.user[key]
    const next = Object.assign({}, scopeState.value)
    delete next[key]
    scopeState.value = next
    scopeListeners.forEach((fn) => fn())
    return true
  },
}
let slotEntry = null
const slotsStub = {
  inject(slot, factory) {
    const iterator = factory()
    for (const reg of iterator) slotEntry = { slot, reg }
  },
  register(def, component) { return { def, component } },
}
const ctxStub = {
  effect(fn) { return fn() },
  locale: { register(ns, dict) { localeDicts[ns] = dict } },
  settingsScope: scopeStub,
  slots: slotsStub,
}

exportsRef.apply(ctxStub)

console.log('== locale ==')
const zh = localeDicts[NS].zh
const en = localeDicts[NS].en
assert.ok(zh && en, 'zh/en 词典存在')
for (const key of Object.keys(zh)) {
  assert.ok(Object.prototype.hasOwnProperty.call(en, key), 'en 应含 zh 全部键: ' + key)
}
assert.equal(Object.keys(en).length, Object.keys(zh).length, 'zh/en 键数量一致')
ok('zh/en 键集合一致 (' + Object.keys(zh).length + ' 键)')
for (const key of ['card.title', 'card.description', 'save', 'discard', 'unsaved', 'readOnly', 'saveFailed', 'overridden', 'reset', 'invalid', 'expand', 'collapse']) {
  assert.ok(zh[key], 'zh 翻译键缺失: ' + key)
}
ok('卡片 UI 翻译键齐全')

console.log('== settingsScope ==')
assert.equal(boundNamespace, NS, 'namespace 必须 = ' + NS)
ok('namespace = ' + NS)

console.log('== slot ==')
assert.equal(slotEntry.slot, 'settings.plugin.item', 'slot 名')
const injected = slotEntry.reg
assert.equal(injected.def.name, 'settings.plugin.item')
assert.equal(injected.def.key, NS)
assert.equal(injected.def.locale, NS)
const payload = injected.def.inject()
assert.ok(payload.hooks && payload.hooks.customSearch, 'hooks.customSearch 提供')
assert.equal(typeof payload.edit, 'function')
assert.equal(typeof payload.resetField, 'function')
assert.equal(typeof payload.save, 'function')
assert.equal(typeof payload.discard, 'function')
ok('slot 注册契约完整 (hooks.useCustomSearch + edit/resetField/save/discard)')

// ---- 渲染辅助 ----
const snap = () => payload.hooks.customSearch.getSnapshot()
const Card = injected.component
const render = (t) => {
  const cards = []
  const walk = (node) => {
    if (node === null || node === undefined || typeof node !== 'object') return
    if (node.type === 'li') { cards.push(node); return }
    if (typeof node.type === 'function') { walk(node.type(node.props)); return }
    for (const child of node.children || []) walk(child)
  }
  walk(jsxStub(Card, { t: t || ((k) => zh[k] || k), useCustomSearch: (selector) => selector(snap()) }))
  return cards
}
function collectText(node, out = []) {
  if (node === null || node === undefined) return out
  if (typeof node === 'string') { out.push(node); return out }
  if (node.props && typeof node.props.value === 'string' && node.props.value !== '') out.push(node.props.value)
  if (typeof node.type === 'function') { collectText(node.type(node.props), out); return out }
  for (const child of node.children || []) collectText(child, out)
  return out
}

console.log('== 卡片渲染 ==')
const cards = render()
assert.equal(cards.length, 1, '应渲染一张 li 卡片')
const texts = collectText(cards[0]).join(' ')
for (const needle of ['自定义搜索（web-search-custom）', '搜索 URL', 'API Key（可留空）', '请求方法', 'POST body 模板', '额外请求头（JSON）', '鉴权请求头名', '鉴权 scheme', '超时（毫秒）', '结果数组路径', 'URL 字段', '标题字段', '摘要字段', '发布日期字段', '保存', '放弃']) {
  assert.ok(texts.includes(needle), '渲染文案应含: ' + needle)
}
ok('卡片渲染包含全部 13 个字段与保存/放弃按钮')

console.log('== 表单保存链路 ==')
const state = snap()
assert.equal(state.dirty, false, '初始不脏')
assert.equal(state.writable, true, '可写')
assert.equal(state.available, true, '可用')
assert.equal(Object.keys(state).filter((k) => typeof state[k] === 'object' && state[k] !== null).length, 13, '13 个字段快照')
payload.edit('url', 'http://127.0.0.1:9999/search?format=json&q={query}')
assert.equal(snap().dirty, true, '编辑后脏')
await payload.save()
assert.equal(scopeState.user.url, 'http://127.0.0.1:9999/search?format=json&q={query}', '保存落到 user 层')
assert.equal(snap().dirty, false, '保存后不脏')
ok('编辑 → 保存 → user 层落值')

payload.edit('timeoutMs', '45000')
await payload.save()
assert.equal(scopeState.user.timeoutMs, 45000, '数字字段以 number 落盘（不是字符串）')
ok('数字字段类型正确 (number)')

payload.resetField('url')
assert.equal(snap().dirty, true, '重置后脏')
await payload.save()
assert.equal(Object.prototype.hasOwnProperty.call(scopeState.user, 'url'), false, '重置 = 从 user 层移除（回落默认）')
ok('重置 → unset 回落到默认值')

payload.edit('method', 'BANANA')
await payload.save()
// 字段是自由文本框：客户端原样落盘，枚举归一化由 host resolveOptions 兜底
// （见 entry.test.mjs「method 归一化」用例）。这里只固化「原样落盘」这条契约。
assert.equal(scopeState.user.method, 'BANANA', '客户端按输入原样落盘，不做隐式改写')
ok('method 字段原样落盘（host 侧归一化为 GET，跨层约定）')
payload.edit('method', 'GET')
await payload.save()

console.log('== 只读态 ==')
scopeState.writable = false
scopeListeners.forEach((fn) => fn())   // scope 变更后必须通知订阅者，卡片才重算快照
const readOnlyCards = render()
const readOnlyTexts = collectText(readOnlyCards[0]).join(' ')
assert.ok(readOnlyTexts.includes('该设置为只读'), '只读提示应出现')
const inputs = []
const findInputs = (node) => {
  if (node === null || node === undefined || typeof node !== 'object') return
  if (node.type === 'input') { inputs.push(node); return }
  if (typeof node.type === 'function') { findInputs(node.type(node.props)); return }
  for (const child of node.children || []) findInputs(child)
}
findInputs(readOnlyCards[0])
assert.ok(inputs.length >= 13, '应渲染 >=13 个输入框，实际 ' + inputs.length)
assert.ok(inputs.every((input) => input.props.disabled === true), '只读态下全部输入必须禁用')
ok('只读态：' + inputs.length + ' 个输入框全部 disabled')

/** 收集树里的按钮，按 class 后缀区分「保存/放弃」与「展开/收起」。 */
function collectButtons(node, out = []) {
  if (node === null || node === undefined || typeof node !== 'object') return out
  if (node.type === 'button') { out.push(node); return out }
  if (typeof node.type === 'function') { collectButtons(node.type(node.props), out); return out }
  for (const child of node.children || []) collectButtons(child, out)
  return out
}
const pickAction = (buttons) => buttons.filter((b) => /_(save|discard)$/.test(String(b.props.className)))
const readOnlyActions = pickAction(collectButtons(readOnlyCards[0]))
assert.equal(readOnlyActions.length, 2, '应有保存 + 放弃两个动作按钮')
assert.ok(readOnlyActions.every((b) => b.props.disabled === true), '只读态下保存/放弃按钮必须禁用')
// 「重置」行级按钮同样必须禁用（行级开关盲区）
const readOnlyResets = collectButtons(readOnlyCards[0]).filter((b) => /_reset$/.test(String(b.props.className)))
const overriddenCount = Object.keys(scopeState.user).length
assert.equal(readOnlyResets.length, overriddenCount, '每个「已覆盖」字段各一个重置按钮')
assert.ok(readOnlyResets.length > 0, '本用例应至少有一个已覆盖字段')
assert.ok(readOnlyResets.every((b) => b.props.disabled === true), '只读态下行级重置按钮必须全部禁用')
ok('只读态：保存/放弃 + ' + readOnlyResets.length + ' 个行级重置按钮全部 disabled')

// 回到可写态并制造 dirty：动作按钮必须可用（不得恒禁用——交互层盲区守护）
scopeState.writable = true
scopeListeners.forEach((fn) => fn())
payload.edit('url', 'http://127.0.0.1:9999/search?format=json&q={query}')
const writableCards = render()
const writableActions = pickAction(collectButtons(writableCards[0]))
assert.equal(writableActions.length, 2)
assert.ok(writableActions.every((b) => b.props.disabled === false), '可写 + dirty 时保存/放弃必须可用')
const writableResets = collectButtons(writableCards[0]).filter((b) => /_reset$/.test(String(b.props.className)))
assert.ok(writableResets.every((b) => b.props.disabled === false), '可写态下重置按钮必须可用')
ok('可写态 + dirty：保存/放弃与 13 个重置按钮均可用（非恒禁用）')
await payload.discard()

console.log('\nclient-smoke: ' + PASS.length + ' 项全部通过')
