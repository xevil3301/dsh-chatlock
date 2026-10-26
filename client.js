/**
 * dsh-chatlock —— 浏览器半侧
 * ============================================================================
 * 一个**自注册脚本**（不是 ESM 模块），dsh 的 client loader 按 `window.__ModuleLoader__.load`
 * 的约定加载它；`exports.apply / exports.inject` 就是 cordis 看到的插件契约。
 *
 * 挂了四个位置：
 *   1. `shell.overlay`                          —— 锁屏遮罩 + 密码弹窗（核心）
 *   2. `sidebar.workspaces.session.row.action`  —— 侧栏悬停时的「上锁」按钮
 *   3. `sidebar.session.row.leading`            —— 已锁会话的小锁图标
 *   4. `settings.section`                       —— 设置 → 聊天锁 整页
 *
 * 纪律：apply 里任何一处挂载失败都只记日志，**绝不向上抛** —— 一个外部插件不该让
 * 整个 Web 壳起不来。
 * ============================================================================
 */
window.__ModuleLoader__.load({
  id: 'dsh-chatlock',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useRef, useState, useSyncExternalStore } = React

    const API = '/api/chatlock'
    const CSS_TAG = 'dsh-chatlock/css'

    // ---------------------------------------------------------------- API --
    const jfetch = async (path, body) => {
      const init = body === undefined
        ? { method: 'GET', credentials: 'same-origin', headers: { accept: 'application/json' } }
        : {
            method: 'POST',
            credentials: 'same-origin',
            headers: { accept: 'application/json', 'content-type': 'application/json' },
            body: JSON.stringify(body || {}),
          }
      const res = await fetch(API + path, init)
      let data = null
      try { data = await res.json() } catch { data = null }
      if (!res.ok) {
        const error = new Error((data && data.error) || `HTTP ${res.status}`)
        error.status = res.status
        error.data = data
        throw error
      }
      return data || {}
    }

    // --------------------------------------------------------------- store --
    const initial = {
      phase: 'loading',
      error: '',
      configured: false,
      policy: { autoLockMinutes: 10, lockOnStart: true, protectVault: true },
      lockedSessions: [],
      lockedMap: {},
      grants: { global: false, sessions: [] },
      vaults: [],
      minPasswordLength: 6,
      version: '',
      lastSync: 0,
    }

    const store = {
      value: initial,
      listeners: new Set(),
      busy: false,
      subscribe(listener) {
        store.listeners.add(listener)
        return () => store.listeners.delete(listener)
      },
      getSnapshot() {
        return store.value
      },
      set(patch) {
        store.value = { ...store.value, ...patch }
        for (const listener of store.listeners) {
          try { listener() } catch { /* 单个订阅者出错不影响其它人 */ }
        }
      },
      applyStatus(data) {
        if (!data || data.ok === false) return
        const lockedMap = {}
        for (const row of data.lockedSessions || []) lockedMap[row.sessionId] = row
        store.set({
          phase: 'ready',
          error: '',
          configured: Boolean(data.configured),
          policy: data.policy || initial.policy,
          lockedSessions: data.lockedSessions || [],
          lockedMap,
          grants: data.grants || initial.grants,
          vaults: data.vaults || [],
          minPasswordLength: data.minPasswordLength || 6,
          version: data.version || '',
          lastSync: Date.now(),
        })
      },
      async refresh() {
        if (store.busy) return
        store.busy = true
        try {
          store.applyStatus(await jfetch('/status'))
        } catch (error) {
          store.set({ phase: store.value.phase === 'loading' ? 'error' : store.value.phase, error: String(error?.message || error) })
        } finally {
          store.busy = false
        }
      },
      /** 有操作就报一声，服务端靠这个判断「是不是该自动锁了」。 */
      touchThrottled() {
        const now = Date.now()
        if (now - (store.lastTouch || 0) < 20_000) return
        store.lastTouch = now
        jfetch('/touch', {}).catch(() => {})
      },
    }

    /** 已配置 + 该会话在锁名单里 + 没被临时放行 = 需要拦。 */
    const isSessionLocked = (value, sessionId) => {
      if (!value.configured || !sessionId) return false
      if (!value.lockedMap[sessionId]) return false
      if (value.grants.global) return false
      if ((value.grants.sessions || []).includes(sessionId)) return false
      return true
    }

    const useStore = () => useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)

    // ----------------------------------------------------------------- CSS --
    const CSS = `
/* 配色只用主题里**真实存在**的 token，而且只用官方成对的那几组。
   2026-10-27 的教训：
     · --dsw-alias-brand-primary 在暗色主题里 = #f9fafb（近白），配死写的 color:#fff 就是白底白字；
     · --dsw-alias-bg-layer-4 在主题里根本不存在（0 次定义），所有 var() 都在吃 fallback。
   现在主按钮用官方那一对：button-primary-fill + label-primary-foreground。 */
[data-cl-mask]{position:fixed;z-index:40;pointer-events:auto;display:flex;align-items:center;justify-content:center;
  background:color-mix(in srgb, var(--dsw-alias-bg-base,#151517) 62%, transparent);
  backdrop-filter:blur(26px) saturate(.7);-webkit-backdrop-filter:blur(26px) saturate(.7);}
[data-cl-dialog]{width:min(380px,calc(100% - 48px));box-sizing:border-box;padding:22px 22px 18px;border-radius:16px;
  display:flex;flex-direction:column;gap:14px;
  background:var(--dsw-alias-bg-layer-1,#232324);
  color:var(--dsw-alias-label-primary,#f9fafb);
  border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.12));
  box-shadow:0 18px 48px rgba(0,0,0,.42);}
[data-cl-dialog] h3{margin:0;font-size:15px;font-weight:600;line-height:22px;display:flex;align-items:center;gap:8px;
  color:var(--dsw-alias-label-primary,#f9fafb);}
[data-cl-dialog] p{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary,#979da6);}
[data-cl-input]{width:100%;box-sizing:border-box;padding:9px 11px;border-radius:9px;font-size:13px;font-family:inherit;
  background:var(--dsw-alias-bg-layer-2,#2c2c2e);
  color:var(--dsw-alias-label-primary,#f9fafb);
  border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.12));}
[data-cl-input]::placeholder{color:var(--dsw-alias-label-tertiary,#979da6);}
[data-cl-input]:focus{outline:none;border-color:var(--dsw-alias-brand-primary,#4c8dff);
  box-shadow:0 0 0 2px var(--dsw-alias-interactive-bg-hover-accent,rgba(76,141,255,.22));}
[data-cl-row]{display:flex;gap:8px;align-items:center;flex-wrap:wrap;}
[data-cl-btn]{padding:8px 13px;border-radius:9px;font-size:12.5px;cursor:pointer;font-family:inherit;white-space:nowrap;
  border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.12));
  background:var(--dsw-alias-bg-layer-3,#353638);
  color:var(--dsw-alias-label-primary,#f9fafb);}
[data-cl-btn]:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.08));}
[data-cl-btn][data-primary]{background:var(--dsw-alias-button-primary-fill,#0f1115);
  border-color:transparent;color:var(--dsw-alias-label-primary-foreground,#ffffff);font-weight:600;}
[data-cl-btn][data-primary]:hover{background:var(--dsw-alias-button-primary-hover,#3c3c3d);}
[data-cl-btn][data-danger]{background:transparent;color:#f87171;border-color:rgba(248,113,113,.45);}
[data-cl-btn][data-danger]:hover{background:var(--dsw-alias-interactive-bg-hover-danger,rgba(239,68,68,.08));}
[data-cl-btn][disabled]{opacity:.45;cursor:default;}
[data-cl-err]{font-size:11.5px;line-height:17px;color:#f87171;min-height:17px;}
[data-cl-ok]{font-size:11.5px;line-height:17px;color:#34d399;min-height:17px;}
[data-cl-glyph]{display:inline-flex;align-items:center;justify-content:center;width:16px;height:16px;flex:none;
  color:var(--dsw-alias-label-tertiary,#979da6);}
[data-cl-glyph][data-on]{color:#fbbf24;}
[data-cl-page]{display:flex;flex-direction:column;gap:18px;padding:2px 2px 12px;max-width:660px;}
[data-cl-card]{display:flex;flex-direction:column;gap:10px;padding:14px 15px;border-radius:12px;
  background:var(--dsw-alias-bg-layer-2,#2c2c2e);
  border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.1));}
[data-cl-card] h4{margin:0;font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary,#f9fafb);}
[data-cl-note]{font-size:11.5px;line-height:17px;color:var(--dsw-alias-label-tertiary,#979da6);}
[data-cl-list]{display:flex;flex-direction:column;gap:8px;}
[data-cl-item]{display:flex;gap:10px;align-items:center;padding:8px 10px;border-radius:9px;font-size:12.5px;
  background:var(--dsw-alias-bg-layer-3,#353638);
  color:var(--dsw-alias-label-primary,#f9fafb);}
[data-cl-item] [data-cl-grow]{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
[data-cl-tag]{font-size:10.5px;padding:1px 7px;border-radius:999px;border:1px solid currentColor;opacity:.9;}
[data-cl-tag][data-locked]{color:#fbbf24;}
[data-cl-tag][data-open]{color:#34d399;}
html[data-dsh-chatlock="locked"] [data-conversation-content]{filter:blur(16px) saturate(.72);pointer-events:none;user-select:none;}
html[data-dsh-chatlock="locked"] [data-chat-flow]{filter:blur(16px) saturate(.72);}
[data-cl-hint]{font-size:11px;color:var(--dsw-alias-label-tertiary,#979da6);}
`

    const ensureCss = () => {
      if (typeof document === 'undefined') return
      if (document.querySelector(`style[data-cl-css="${CSS_TAG}"]`)) return
      const style = document.createElement('style')
      style.dataset.clCss = CSS_TAG
      style.textContent = CSS
      document.head.appendChild(style)
    }

    // --------------------------------------------------------------- icons --
    const IconLock = (props) => h('svg', {
      viewBox: '0 0 16 16', width: 14, height: 14, fill: 'none', 'aria-hidden': true, style: { display: 'block' },
      ...props,
    },
    h('path', {
      d: 'M4.5 7V5.4a3.5 3.5 0 1 1 7 0V7',
      stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round',
    }),
    h('rect', { x: 3, y: 7, width: 10, height: 6.2, rx: 1.6, stroke: 'currentColor', strokeWidth: 1.4 }))

    // ------------------------------------------------------------ geometry --
    /**
     * 量出会话区域的位置，让遮罩只盖住它（侧栏仍然可用，能在别的会话之间切换）。
     * 布局变化没有统一事件（折叠侧栏、拖宽度都不一样），所以用一个低频轮询兜底。
     */
    function useConversationRect() {
      const [rect, setRect] = useState(null)
      useEffect(() => {
        if (typeof document === 'undefined') return
        let raf = 0
        let last = ''
        const measure = () => {
          const el = document.querySelector('[data-conversation-region]') || document.querySelector('[data-conversation-content]')
          if (!el) {
            if (last !== '') { last = ''; setRect(null) }
            return
          }
          const r = el.getBoundingClientRect()
          const next = { left: Math.round(r.left), top: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) }
          const key = `${next.left}:${next.top}:${next.width}:${next.height}`
          if (key === last) return
          last = key
          setRect(next)
        }
        const schedule = () => {
          if (raf) return
          raf = requestAnimationFrame(() => { raf = 0; measure() })
        }
        schedule()
        const observer = new ResizeObserver(schedule)
        try { observer.observe(document.body) } catch { /* 老浏览器 */ }
        window.addEventListener('resize', schedule)
        const timer = setInterval(measure, 1200)
        return () => {
          observer.disconnect()
          window.removeEventListener('resize', schedule)
          clearInterval(timer)
          if (raf) cancelAnimationFrame(raf)
        }
      }, [])
      return rect
    }

    // ---------------------------------------------------------------- lock --
    /**
     * 核心：锁屏遮罩 + 密码弹窗。
     * 它同时负责把 `<html data-dsh-chatlock="locked">` 打上/撤掉 —— 样式层靠这个属性
     * 去模糊会话正文（遮罩本身只是第一层观感，模糊才是挡住内容的那一层）。
     */
    function LockGate({ ctx }) {
      const value = useStore()
      const rect = useConversationRect()
      const [password, setPassword] = useState('')
      const [error, setError] = useState('')
      const [busy, setBusy] = useState(false)
      const inputRef = useRef(null)

      const sessionId = useCurrentSessionId(ctx)
      const locked = isSessionLocked(value, sessionId)

      useEffect(() => {
        if (typeof document === 'undefined') return
        const root = document.documentElement
        if (locked) root.setAttribute('data-dsh-chatlock', 'locked')
        else root.removeAttribute('data-dsh-chatlock')
        return () => {
          if (!isSessionLocked(store.getSnapshot(), sessionId)) root.removeAttribute('data-dsh-chatlock')
        }
      }, [locked, sessionId])

      useEffect(() => {
        if (!locked) { setPassword(''); setError(''); return }
        const timer = setTimeout(() => { try { inputRef.current?.focus() } catch { /* 无焦点 */ } }, 30)
        return () => clearTimeout(timer)
      }, [locked, sessionId])

      const title = value.lockedMap[sessionId]?.title || ''

      // 每次「从解锁变成锁定」上报一次：宿主那边据此确认遮罩真的渲染过（含量到的几何）。
      const reportedFor = useRef('')
      useEffect(() => {
        if (!locked || !sessionId) return
        if (reportedFor.current === sessionId) return
        reportedFor.current = sessionId
        const content = typeof document !== 'undefined' ? document.querySelector('[data-conversation-content]') : null
        const filter = content && typeof getComputedStyle === 'function' ? getComputedStyle(content).filter : ''
        jfetch('/gate-shown', {
          sessionId,
          mask: rect ? { w: rect.width, h: rect.height } : null,
          contentFound: Boolean(content),
          contentFilter: String(filter || '').slice(0, 40),
        }).catch(() => {})
      }, [locked, sessionId, rect])

      const submit = useCallback(async (alsoRemoveLock) => {
        if (!sessionId) return
        setBusy(true)
        setError('')
        try {
          await jfetch('/verify', { password, sessionId })
          if (alsoRemoveLock) await jfetch('/unlock-session', { password, sessionId })
          setPassword('')
          await store.refresh()
        } catch (err) {
          setError(String(err?.message || err))
        } finally {
          setBusy(false)
        }
      }, [password, sessionId])

      if (!locked) return null

      const style = rect
        ? { left: rect.left + 'px', top: rect.top + 'px', width: rect.width + 'px', height: rect.height + 'px' }
        : { inset: '0' }

      return h('div', { 'data-cl-mask': '', style, role: 'dialog', 'aria-modal': 'true', 'aria-label': '会话已锁定' },
        h('form', {
          'data-cl-dialog': '',
          onSubmit: (event) => { event.preventDefault(); submit(false) },
          onKeyDown: (event) => { if (event.key === 'Escape') event.preventDefault() },
        },
        h('h3', null, h('span', { 'data-cl-glyph': '', 'data-on': '' }, h(IconLock)), '这个会话已锁定'),
        h('p', null, title ? `「${title}」需要密码才能查看。` : '需要密码才能查看这个会话。'),
        h('input', {
          'data-cl-input': '',
          ref: inputRef,
          type: 'password',
          autoComplete: 'off',
          placeholder: '输入聊天锁密码',
          value: password,
          onChange: (event) => setPassword(event.target.value),
          'aria-label': '聊天锁密码',
        }),
        h('div', { 'data-cl-err': '' }, error),
        h('div', { 'data-cl-row': '' },
          h('button', { 'data-cl-btn': '', 'data-primary': '', type: 'submit', disabled: busy || password.length === 0 },
            busy ? '校验中…' : '解锁'),
          h('button', {
            'data-cl-btn': '',
            type: 'button',
            disabled: busy || password.length === 0,
            title: '这次输的密码同时用于永久解除这个会话的锁',
            onClick: () => submit(true),
          }, '解锁并解除锁定'),
        ),
        h('div', { 'data-cl-hint': '' }, `自动锁定：${value.policy.autoLockMinutes > 0 ? value.policy.autoLockMinutes + ' 分钟无操作' : '关闭'}`)),
      )
    }

    // ------------------------------------------------------- current session --
    /** 从 ctx 上取 ui-session 的 main-view binding source（拿不到返回 null）。 */
    function resolveSessionSource(ctx) {
      try {
        const svc = ctx.get('uiSession')
        const current = svc && svc.current
        if (current && typeof current.subscribe === 'function' && typeof current.getSnapshot === 'function') return current
      } catch { /* 服务还没起来 */ }
      return null
    }

    /**
     * 取「当前打开的会话 id」。
     *
     * 优先问 ui-session 服务；拿不到就每隔 400ms 再问一次（客户端包的 inject 顺序
     * 已经保证 ui-session 先加载，这里只是兜底）。始终拿不到就返回 ''，
     * 也就是**不拦** —— 宁可少拦，也不能因为服务缺位把没锁的会话挡住。
     */
    function useCurrentSessionId(ctx) {
      const [source, setSource] = useState(() => resolveSessionSource(ctx))

      useEffect(() => {
        if (source) return undefined
        const timer = setInterval(() => {
          const next = resolveSessionSource(ctx)
          if (next) {
            clearInterval(timer)
            setSource(next)
          }
        }, 400)
        return () => clearInterval(timer)
      }, [source, ctx])

      const binding = useSyncExternalStore(
        source ? source.subscribe : NOOP_SUBSCRIBE,
        source ? source.getSnapshot : EMPTY_SNAPSHOT,
        source ? source.getSnapshot : EMPTY_SNAPSHOT,
      )
      return binding && typeof binding.key === 'string' ? binding.key : ''
    }

    const NOOP_SUBSCRIBE = () => () => {}
    const EMPTY_SNAPSHOT = () => ''

    // ------------------------------------------------------- sidebar action --
    /** 侧栏悬停时出现的小锁：只负责「上锁」，不负责解锁（解锁必须输密码）。 */
    function SidebarLockAction({ sessionId, displayTitle, ctx }) {
      const value = useStore()
      const [busy, setBusy] = useState(false)
      if (!value.configured || !sessionId) return null
      if (value.lockedMap[sessionId]) return null

      const lock = async (event) => {
        event.stopPropagation()
        event.preventDefault()
        if (busy) return
        setBusy(true)
        try {
          await jfetch('/lock', { sessionId, title: typeof displayTitle === 'string' ? displayTitle : '' })
          await store.refresh()
        } catch { /* 锁失败就别打扰用户 */ } finally { setBusy(false) }
      }

      return h('button', {
        type: 'button',
        title: '锁定这个会话（下次打开要密码）',
        'aria-label': '锁定这个会话',
        disabled: busy,
        onClick: lock,
        style: {
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          width: 22, height: 22, padding: 0, border: 0, borderRadius: 6,
          background: 'transparent', color: 'inherit', cursor: 'pointer', opacity: busy ? 0.4 : 0.75,
        },
        onPointerEnter: (event) => { event.currentTarget.style.background = 'var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.18))' },
        onPointerLeave: (event) => { event.currentTarget.style.background = 'transparent' },
      }, h(IconLock))
    }

    // ------------------------------------------------------- sidebar leading --
    /** 会话行前面那格：锁着的显示小锁（运行中的会话这一格会被状态点占用，属正常）。 */
    function SidebarLockGlyph({ sessionId }) {
      const value = useStore()
      if (!value.configured || !sessionId) return null
      if (!value.lockedMap[sessionId]) return null
      return h('span', {
        'data-cl-glyph': '', 'data-on': '',
        title: '这个会话已锁定',
        style: { width: '100%', justifyContent: 'center' },
      }, h(IconLock))
    }

    // ----------------------------------------------------------- settings page --
    function SettingsPage({ ctx }) {
      const value = useStore()
      const [pw, setPw] = useState('')
      const [pw2, setPw2] = useState('')
      const [msg, setMsg] = useState({ kind: '', text: '' })
      const [busy, setBusy] = useState('')
      const [vaultPath, setVaultPath] = useState('')
      const [vaultLabel, setVaultLabel] = useState('')
      const [minutes, setMinutes] = useState(String(value.policy.autoLockMinutes))
      const [vaultMinutes, setVaultMinutes] = useState(String(value.policy.vaultAutoLockMinutes ?? 15))
      const [confirmClear, setConfirmClear] = useState('')

      useEffect(() => { setMinutes(String(value.policy.autoLockMinutes)) }, [value.policy.autoLockMinutes])
      useEffect(() => { setVaultMinutes(String(value.policy.vaultAutoLockMinutes ?? 15)) }, [value.policy.vaultAutoLockMinutes])

      const say = (kind, text) => setMsg({ kind, text })

      /** 统一跑一个会改状态的动作：抓错误、刷新状态、给一句话反馈。 */
      const run = async (label, fn, okText) => {
        setBusy(label)
        setMsg({ kind: '', text: '' })
        try {
          const result = await fn()
          await store.refresh()
          if (result && result.result && result.result.skipped && result.result.skipped.length > 0) {
            const skipped = result.result.skipped
            say('err', `${okText}，但有 ${skipped.length} 项被跳过：${skipped.slice(0, 3).map((s) => s.rel + ' (' + s.why + ')').join('；')}`)
          } else {
            say('ok', okText)
          }
          return result
        } catch (error) {
          say('err', String(error?.message || error))
          return null
        } finally {
          setBusy('')
        }
      }

      const section = (title, children, note) => h('div', { 'data-cl-card': '' },
        h('h4', null, title),
        note ? h('div', { 'data-cl-note': '' }, note) : null,
        ...children)

      if (value.phase === 'loading') {
        return h('div', { 'data-cl-page': '' }, h('div', { 'data-cl-note': '' }, '正在读取聊天锁状态…'))
      }

      const configured = value.configured
      const feedback = msg.text
        ? h('div', { [msg.kind === 'err' ? 'data-cl-err' : 'data-cl-ok']: '' }, msg.text)
        : null

      /**
       * 口令栏空着时，这一页所有「会改状态」的按钮都是灰的 ——
       * 必须把原因写在按钮旁边，否则就变成「为什么点不动 / 为什么锁不了」（2026-10-27 的实际反馈）。
       */
      const needPw = configured && pw.length === 0
      const pwHint = needPw
        ? h('div', { 'data-cl-hint': '' }, '↑ 先在「本页操作口令」里填入当前密码，这个区域的按钮才会亮。')
        : null

      return h('div', { 'data-cl-page': '' },

        // 概览
        h('div', { 'data-cl-card': '' },
          h('h4', null, '聊天锁'),
          h('div', { 'data-cl-note': '' },
            configured
              ? `已启用 · 版本 ${value.version || '—'} · 已锁会话 ${value.lockedSessions.length} 个 · 保险箱 ${value.vaults.length} 个`
              : '尚未设置密码。设置之后，锁定的会话在打开时会要求输入密码。'),
          feedback),

        // 本页操作口令（共享）：整页只在这里输一次
        configured
          ? h('div', { 'data-cl-card': '' },
              h('h4', null, '本页操作口令'),
              h('div', { 'data-cl-note': '' },
                '改密码、解除会话锁、保险箱加密/解密、清除锁 —— 这些操作每次都要验一次密码。'
                + '它只活在这个页面里，不保存、刷新即清空。'),
              h('input', {
                'data-cl-input': '', type: 'password', autoComplete: 'current-password',
                placeholder: '当前密码', value: pw, onChange: (e) => setPw(e.target.value),
              }))
          : null,

        // 口令
        !configured
          ? section('设置密码', [
              h('input', {
                'data-cl-input': '', type: 'password', autoComplete: 'new-password',
                placeholder: `新密码（至少 ${value.minPasswordLength} 位）`,
                value: pw, onChange: (e) => setPw(e.target.value),
              }),
              h('input', {
                'data-cl-input': '', type: 'password', autoComplete: 'new-password',
                placeholder: '再输一次',
                value: pw2, onChange: (e) => setPw2(e.target.value),
              }),
              h('div', { 'data-cl-row': '' },
                h('button', {
                  'data-cl-btn': '', 'data-primary': '',
                  disabled: busy === 'setup' || pw.length < value.minPasswordLength || pw !== pw2,
                  onClick: () => run('setup', async () => {
                    const result = await jfetch('/setup', { password: pw })
                    setPw(''); setPw2('')
                    return result
                  }, '密码已设置。现在可以在会话列表里给单个会话上锁了。'),
                }, busy === 'setup' ? '设置中…' : '设置密码'),
                pw && pw2 && pw !== pw2 ? h('span', { 'data-cl-hint': '' }, '两次输入不一致') : null),
            ], '密码只以 scrypt 派生值的形式保存，明文不落盘。忘记密码无法找回，只能清除全部锁。')
          : section('修改密码', [
              h('input', {
                'data-cl-input': '', type: 'password', autoComplete: 'new-password',
                placeholder: `新密码（至少 ${value.minPasswordLength} 位）`,
                value: pw2, onChange: (e) => setPw2(e.target.value),
              }),
              h('div', { 'data-cl-row': '' },
                h('button', {
                  'data-cl-btn': '',
                  disabled: busy === 'password' || pw.length === 0 || pw2.length < value.minPasswordLength,
                  onClick: () => run('password', async () => {
                    const result = await jfetch('/password', { currentPassword: pw, newPassword: pw2 })
                    setPw(''); setPw2('')
                    return result
                  }, '密码已修改，所有临时解锁都已撤销。'),
                }, busy === 'password' ? '修改中…' : '修改密码'),
                pw2 && pw2.length < value.minPasswordLength
                  ? h('span', { 'data-cl-hint': '' }, `至少 ${value.minPasswordLength} 位`)
                  : null),
              pwHint,
            ], '「当前密码」取自上方的「本页操作口令」，这里只填新密码。改完会撤销全部临时解锁。')

        ,

        // 策略
        section('自动锁定', [
          h('div', { 'data-cl-row': '' },
            h('span', { 'data-cl-note': '' }, '无操作'),
            h('input', {
              'data-cl-input': '', type: 'number', min: 0, max: 1440, value: minutes,
              style: { width: '88px', textAlign: 'center' },
              onChange: (e) => setMinutes(e.target.value),
            }),
            h('span', { 'data-cl-note': '' }, '分钟后重新上锁（0 = 不自动锁）'),
            h('button', {
              'data-cl-btn': '',
              disabled: busy === 'policy' || pw.length === 0,
              onClick: () => run('policy', () => jfetch('/policy', {
                password: pw, autoLockMinutes: Number(minutes),
              }), '自动锁定时间已保存。'),
            }, '保存')),
          h('label', { 'data-cl-row': '', style: { cursor: 'pointer', fontSize: '12.5px' } },
            h('input', {
              type: 'checkbox', checked: value.policy.lockOnStart,
              disabled: busy === 'policy' || pw.length === 0,
              onChange: (e) => run('policy', () => jfetch('/policy', { password: pw, lockOnStart: e.target.checked }), '已保存。'),
            }),
            h('span', null, 'DSH 启动后默认处于锁定状态（临时解锁只存在内存里，重启即失效）')),
          h('div', { 'data-cl-row': '' },
            h('span', { 'data-cl-note': '' }, '保险箱解锁后'),
            h('input', {
              'data-cl-input': '', type: 'number', min: 0, max: 1440, value: vaultMinutes,
              style: { width: '88px', textAlign: 'center' },
              onChange: (e) => setVaultMinutes(e.target.value),
            }),
            h('span', { 'data-cl-note': '' }, '分钟无操作自动加密回去（0 = 关）'),
            h('button', {
              'data-cl-btn': '',
              disabled: busy === 'policy' || pw.length === 0,
              onClick: () => run('policy', () => jfetch('/policy', {
                password: pw, vaultAutoLockMinutes: Number(vaultMinutes),
              }), '保险箱自动上锁时间已保存。'),
            }, '保存')),
          pwHint,
        ], '改这个值也要密码。0 表示不自动锁。'),

        // 已锁会话
        section('已锁定的会话', [
          value.lockedSessions.length === 0
            ? h('div', { 'data-cl-note': '' }, '还没有锁定的会话。把鼠标移到侧栏的会话上，点小锁即可上锁。')
            : h('div', { 'data-cl-list': '' }, ...value.lockedSessions.map((row) => h('div', { 'data-cl-item': '', key: row.sessionId },
                h('span', { 'data-cl-glyph': '', 'data-on': '' }, h(IconLock)),
                h('span', { 'data-cl-grow': '', title: row.sessionId },
                  row.title || row.sessionId.slice(0, 18)),
                h('button', {
                  'data-cl-btn': '',
                  disabled: busy === 'unlock:' + row.sessionId || pw.length === 0,
                  onClick: () => run('unlock:' + row.sessionId, () => jfetch('/unlock-session', {
                    password: pw, sessionId: row.sessionId,
                  }), '已解除这一条的锁。'),
                }, '解除'),
              ))),
          pwHint,
        ], '解除锁定需要密码。只想临时看一眼的话，直接在会话界面输密码解锁即可。'),

        // 保险箱
        section('保险箱（目录加密）', [
          h('div', { 'data-cl-note': '' },
            '登记一个目录后，可以把它整体加密：锁定后磁盘上只剩密文，DSH 自己的文件工具也读不到。'
            + '只在目录「没被任何会话占用」时上锁，否则正在写的文件会变成密文。'
            + '别把 dsh 自己的家目录（~/.dsh）或正在跑会话的工作区登记进来 —— 那会把插件自己一起锁掉。'),
          h('div', { 'data-cl-row': '' },
            h('input', {
              'data-cl-input': '', placeholder: '要保护的目录绝对路径，例如 D:\\私密资料',
              value: vaultPath, onChange: (e) => setVaultPath(e.target.value),
              style: { flex: '1 1 240px', minWidth: '200px' },
            }),
            h('input', {
              'data-cl-input': '', placeholder: '标签（可空）',
              value: vaultLabel, onChange: (e) => setVaultLabel(e.target.value),
              style: { width: '140px' },
            }),
            h('button', {
              'data-cl-btn': '',
              disabled: busy === 'vaultAdd' || pw.length === 0 || vaultPath.trim() === '',
              onClick: () => {
                const candidate = vaultPath.trim()
                // 盘符根：锁上去等于锁整台机器，先挡一道（服务端还有一道）。
                if (/^[A-Za-z]:[\\/]?$/.test(candidate)) {
                  say('err', `不要把整个盘符登记成保险箱：${candidate}`)
                  return
                }
                run('vaultAdd', async () => {
                  const result = await jfetch('/vault/add', { password: pw, path: candidate, label: vaultLabel.trim() })
                  setVaultPath(''); setVaultLabel('')
                  return result
                }, '已登记保险箱。')
              },
            }, '登记')),
          vaultPath.trim() === ''
            ? h('div', { 'data-cl-hint': '' }, '还没填目录路径 —— 填一个绝对路径，「登记」才会亮。')
            : null,

          value.vaults.length > 0
            ? h('div', { 'data-cl-list': '' }, ...value.vaults.map((vault) => h('div', { 'data-cl-item': '', key: vault.id },
                h('span', { 'data-cl-grow': '', title: vault.path }, vault.label || vault.path),
                h('span', {
                  'data-cl-tag': '', [vault.locked ? 'data-locked' : 'data-open']: '',
                  title: vault.locked
                    ? '磁盘上只有密文'
                    : (vault.keyLive ? '本次已解锁，密钥在内存里 —— 磁盘上现在是明文' : '磁盘上是明文'),
                }, vault.locked ? `已锁 ${vault.files} 项` : (vault.keyLive ? '明文 · 本次已解锁' : '明文')),
                h('button', {
                  'data-cl-btn': '',
                  disabled: busy === 'vaultLock:' + vault.id || pw.length === 0,
                  onClick: () => run('vaultLock:' + vault.id, () => jfetch('/vault/lock', { password: pw, id: vault.id }),
                    vault.locked ? '这个保险箱已经锁着。' : '已加密。现在磁盘上只有密文。'),
                }, vault.locked ? '重新加密' : '加密并锁定'),
                h('button', {
                  'data-cl-btn': '',
                  disabled: busy === 'vaultUnlock:' + vault.id || pw.length === 0,
                  onClick: () => run('vaultUnlock:' + vault.id, () => jfetch('/vault/unlock', { password: pw, id: vault.id }),
                    '已解密还原。'),
                }, '解锁还原'),
                h('button', {
                  'data-cl-btn': '', 'data-danger': '',
                  disabled: busy === 'vaultRemove:' + vault.id || pw.length === 0,
                  onClick: () => run('vaultRemove:' + vault.id, () => jfetch('/vault/remove', { password: pw, id: vault.id }),
                    '已移出登记（文件保持现状）。'),
                }, '移出'),
              )))
            : h('div', { 'data-cl-note': '' }, '还没有登记任何保险箱。'),
          value.vaults.some((vault) => vault.keyLive)
            ? h('div', { 'data-cl-row': '' },
                h('button', {
                  'data-cl-btn': '', 'data-primary': '',
                  disabled: busy === 'lockAll',
                  onClick: () => run('lockAll', async () => {
                    const result = await jfetch('/vault/lock-all', {})
                    if (Array.isArray(result.failed) && result.failed.length > 0) {
                      throw new Error(`${result.failed.length} 个上锁失败：${result.failed[0].error}`)
                    }
                    return result
                  }, '已把解锁中的保险箱全部加密回去。'),
                }, busy === 'lockAll' ? '加密中…' : '立即锁全部保险箱'),
                h('span', { 'data-cl-hint': '' }, '用内存里的密钥，不用再输密码'))
            : null,
          pwHint,
          feedback,
        ], '路径要是**绝对路径**（例如 D:\\私密资料，不要写 ~ 或相对路径）。加密/解密都要密码。'),

        // 危险区
        section('危险操作', [
          h('div', { 'data-cl-row': '' },
            h('button', {
              'data-cl-btn': '',
              disabled: busy === 'relock',
              onClick: () => run('relock', () => jfetch('/relock', {}), '已撤销全部临时解锁。'),
            }, '立即重新上锁'),
            h('button', {
              'data-cl-btn': '', 'data-danger': '',
              disabled: busy === 'clear' || pw.length === 0 || confirmClear !== 'CLEAR',
              onClick: () => run('clear', async () => {
                const result = await jfetch('/clear', { password: pw })
                setConfirmClear('')
                return result
              }, '已清除密码与全部锁。'),
            }, '清除密码与全部锁'),
            h('input', {
              'data-cl-input': '', placeholder: '输入 CLEAR 确认', value: confirmClear,
              onChange: (e) => setConfirmClear(e.target.value), style: { width: '170px' },
            })),
          pwHint,
        ], '清除后所有会话不再需要密码，保险箱记录也会被移除（已加密的目录必须先解锁）。'),
      )
    }

    // --------------------------------------------------------------- plugin --
    const inject = ['slots']

    function apply(ctx) {
      try {
        applyInner(ctx)
        // 页内自检：宿主拿这条记录确认「浏览器那半边真的执行了、槽位注册了」。
        jfetch('/client-hello', {
          ok: true,
          region: Boolean(document.querySelector('[data-conversation-region]')),
          content: Boolean(document.querySelector('[data-conversation-content]')),
          overlay: Boolean(document.querySelector('[data-shell-overlay]')),
          slots: 4,
        }).catch(() => {})
      } catch (error) {
        try { console.warn('[chatlock] apply 失败：', error) } catch { /* 无 console */ }
        jfetch('/client-hello', {
          ok: false,
          error: String(error?.message || error).slice(0, 300),
        }).catch(() => {})
      }
    }

    function applyInner(ctx) {
      ensureCss()
      const safe = (label, fn) => {
        try {
          return fn()
        } catch (error) {
          try { console.warn('[chatlock] ' + label + ' 挂载失败：', error) } catch { /* 无 console */ }
          return null
        }
      }

      // 状态轮询：一次启动，随插件 fiber 一起销毁。
      ctx.effect(() => {
        store.refresh()
        const timer = setInterval(() => { store.refresh() }, 5000)
        const onActivity = () => {
          if (store.getSnapshot().configured) store.touchThrottled()
        }
        for (const event of ['pointerdown', 'keydown']) window.addEventListener(event, onActivity, { passive: true })
        return () => {
          clearInterval(timer)
          for (const event of ['pointerdown', 'keydown']) window.removeEventListener(event, onActivity)
        }
      }, 'chatlock: 状态轮询')

      ctx.effect(() => ctx.slots.inject('shell.overlay', () => ctx.slots.register({
        name: 'shell.overlay',
        id: 'chatlock-gate',
        order: 900,
        inject: () => ({}),
      }, () => h(LockGate, { ctx }))), 'chatlock: 锁屏遮罩')

      ctx.effect(() => ctx.slots.inject('sidebar.workspaces.session.row.action', () => ctx.slots.register({
        name: 'sidebar.workspaces.session.row.action',
        id: 'chatlock-row-lock',
        inject: () => ({}),
      }, (props) => h(SidebarLockAction, { sessionId: props?.sessionId, displayTitle: props?.displayTitle, ctx }))),
        'chatlock: 侧栏上锁按钮')

      ctx.effect(() => ctx.slots.inject('sidebar.session.row.leading', () => ctx.slots.register({
        name: 'sidebar.session.row.leading',
        id: 'chatlock-row-glyph',
        inject: () => ({}),
      }, (props) => h(SidebarLockGlyph, { sessionId: props?.sessionId }))),
        'chatlock: 侧栏锁标')

      safe('settings section', () => ctx.effect(() => ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'chatlock',
        order: 42,
        label: () => '聊天锁',
        inject: () => ({}),
      }, () => h(SettingsPage, { ctx }))), 'chatlock: 设置页'))
    }

    const plugin = { apply, inject }
    return plugin
  },
})
