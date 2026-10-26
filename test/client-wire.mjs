/**
 * test/client-wire.mjs —— 用假的 window / require / ctx 验证浏览器半侧的「接线」。
 *
 * 它不渲染 React（那需要真 DOM），但能钉住最容易错的东西：
 *   - 模块以 `__ModuleLoader__.load({id, factory})` 自注册，id 与 package.json 一致；
 *   - factory 返回 { apply, inject }；
 *   - apply 不抛，并把四个槽位按正确名字注册上去。
 *
 * 用法：node test/client-wire.mjs
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'
import vm from 'node:vm'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const source = readFileSync(join(root, 'client.js'), 'utf8')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

let loaded = null
const registered = []
const injected = []
let effectCount = 0

// ---- 假 React ------------------------------------------------------------
const React = {
  createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
  Fragment: Symbol('Fragment'),
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  useEffect: () => {},
  useLayoutEffect: () => {},
  useMemo: (fn) => fn(),
  useCallback: (fn) => fn,
  useRef: (initial) => ({ current: initial }),
  useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
  useReducer: (_reducer, initial) => [initial, () => {}],
}

const fakeRequire = (name) => {
  if (name === 'react') return React
  if (name === 'react/jsx-runtime') return { jsx: React.createElement, jsxs: React.createElement, Fragment: React.Fragment }
  throw new Error('未提供的模块: ' + name)
}

// ---- 假 window / document -------------------------------------------------
const styleTags = []
const documentStub = {
  documentElement: {
    attributes: new Map(),
    setAttribute(name, value) { this.attributes.set(name, value) },
    removeAttribute(name) { this.attributes.delete(name) },
    hasAttribute(name) { return this.attributes.has(name) },
  },
  head: { appendChild: (node) => styleTags.push(node) },
  createElement: (tag) => ({ tag, dataset: {}, textContent: '', setAttribute() {} }),
  querySelector: () => null,
  body: {},
}

const windowStub = {
  __ModuleLoader__: {
    load(entry) {
      loaded = entry
    },
  },
  addEventListener() {},
  removeEventListener() {},
  location: { search: '' },
  requestAnimationFrame: (fn) => setTimeout(fn, 0),
  cancelAnimationFrame: () => {},
  setInterval: () => 0,
  clearInterval: () => {},
}

const sandbox = {
  window: windowStub,
  document: documentStub,
  fetch: async () => ({ ok: true, status: 200, json: async () => ({ ok: true, configured: false, lockedSessions: [], vaults: [] }) }),
  console,
  setTimeout,
  clearTimeout,
  setInterval: () => 0,
  clearInterval: () => {},
  URLSearchParams,
  ResizeObserver: class { observe() {} disconnect() {} },
  requestAnimationFrame: (fn) => setTimeout(fn, 0),
  cancelAnimationFrame: () => {},
}
sandbox.globalThis = sandbox
sandbox.self = sandbox

const context = vm.createContext(sandbox)
vm.runInContext(source, context, { filename: 'client.js' })

let failures = 0
const check = (label, fn) => {
  try { fn(); console.log('  ✔ ' + label) } catch (error) {
    failures += 1
    console.error('  ✘ ' + label + '\n    ' + (error?.stack || error))
  }
}

console.log('\n[自注册]')
check('调用了 __ModuleLoader__.load', () => assert.ok(loaded, '没有调用 load'))
check('id 与 package.json 的 name 一致', () => assert.equal(loaded.id, pkg.name))
check('id 是 dsh-chatlock', () => assert.equal(loaded.id, 'dsh-chatlock'))

console.log('\n[插件契约]')
let plugin = null
check('factory 返回 {apply, inject}', () => {
  plugin = loaded.factory(fakeRequire)
  assert.equal(typeof plugin.apply, 'function')
  assert.ok(Array.isArray(plugin.inject))
  assert.ok(plugin.inject.includes('slots'))
})

console.log('\n[apply 接线]')
const ctx = {
  effect(fn, label) {
    effectCount += 1
    const dispose = fn()
    return typeof dispose === 'function' ? dispose : () => {}
  },
  slots: {
    inject(name, factory) {
      injected.push(name)
      return factory()
    },
    register(options, Component) {
      registered.push({ options, Component })
      return () => {}
    },
  },
  get: () => undefined,
}

check('apply 不抛异常', () => {
  plugin.apply(ctx)
})

check('挂了 4 个槽位', () => {
  assert.equal(registered.length + injected.filter((name, index) => injected.indexOf(name) === index).length >= 4, true)
})

const names = registered.map((row) => row.options?.name)
check('注册了 shell.overlay', () => assert.ok(names.includes('shell.overlay'), names.join(',')))
check('注册了侧栏上锁按钮', () => assert.ok(names.includes('sidebar.workspaces.session.row.action'), names.join(',')))
check('注册了侧栏锁标', () => assert.ok(names.includes('sidebar.session.row.leading'), names.join(',')))
check('注册了设置页', () => assert.ok(names.includes('settings.section'), names.join(',')))

check('每个注册都带 id', () => {
  for (const row of registered) assert.ok(row.options?.id, '缺少 id: ' + JSON.stringify(row.options))
})

check('设置页有 label', () => {
  const section = registered.find((row) => row.options?.name === 'settings.section')
  assert.equal(typeof section.options.label, 'function')
  assert.equal(section.options.label(), '聊天锁')
})

check('所有注册项都拿到了组件函数', () => {
  for (const row of registered) assert.equal(typeof row.Component, 'function')
})

check('注入到了 CSS', () => assert.ok(styleTags.length >= 1, '没有插入 <style>'))

console.log('\n[组件可渲染性（浅层）]')
check('shell.overlay 组件能同步渲染出 LockGate，且未锁定时返回 null', () => {
  const gate = registered.find((row) => row.options?.name === 'shell.overlay')
  const outer = gate.Component({})
  assert.equal(typeof outer?.type, 'function')
  const inner = outer.type({ ctx })
  assert.equal(inner, null, '未配置密码时不该拦任何会话')
})

console.log(failures === 0 ? '\n全部通过 ✅\n' : `\n失败 ${failures} 项 ❌\n`)
process.exit(failures === 0 ? 0 : 1)
