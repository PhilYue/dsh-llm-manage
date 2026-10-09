/**
 * dsh-llm-manage — browser half.
 *
 * Three contributions over the Host half's `/api/llm-manage` route:
 *
 * - a management panel appended to the provider card its settings namespace
 *   owns, which is where a route's models are already configured;
 * - a model picker registered at priority -1 over `conversation.input.model`,
 *   so favorites and pins come first and a reason is visible on every unusable
 *   row (the shipped picker registers at priority 0 and is shadowed only while
 *   `selector.mode` stays `managed`);
 * - a banner in the composer dock that says a model was switched and why,
 *   because an automatic switch nobody notices is worse than no switch.
 *
 * No Harness Client package is imported: React comes from the module table and
 * every style below uses only `--dsw-alias-*` theme tokens, so a renamed token
 * degrades appearance instead of breaking the render.
 *
 * @module dsh-llm-manage/client
 */

window.__ModuleLoader__.load({
  id: 'dsh-llm-manage',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useRef, useCallback, useMemo, useSyncExternalStore } = React

    /** The Host route this half talks to. */
    const ROUTE = '/api/llm-manage'

    /** Dictionary, so both supported locales read naturally. */
    const DICT = {
      en: {
        panelTitle: 'Models',
        panelHint: 'Pins and favorites sort to the top of the model picker; hidden models leave it.',
        loading: 'Reading models…',
        retry: 'Retry',
        refresh: 'Re-check gateway',
        deepProbe: 'Deep-probe all',
        deepProbeTitle: 'Sends one minimal request per model. This gateway meters the whole API key, so a full sweep can rate-limit you.',
        showAll: 'Show all',
        showFewer: 'Show fewer',
        pin: 'Pin',
        unpin: 'Unpin',
        favorite: 'Favorite',
        unfavorite: 'Unfavorite',
        hide: 'Hide',
        unhide: 'Unhide',
        probe: 'Probe',
        probing: 'Probing…',
        total: 'listed',
        usable: 'usable',
        problems: 'flagged',
        pinned: 'pinned',
        pickerTitle: 'Model',
        search: 'Search models',
        noModels: 'No models matched.',
        unavailable: 'unavailable',
        alsoOn: 'also on',
        selected: 'current',
        fallbackTitle: 'Model switched automatically',
        fallbackBody: 'reported an exhausted quota, so this turn continues on',
        dismiss: 'Dismiss',
        diagnostics: 'Diagnostics',
        sourceDirectory: 'gateway directory',
        sourceProbe: 'deep probe',
        sourcePassive: 'observed request',
        never: 'never checked',
      },
      zh: {
        panelTitle: '模型管理',
        panelHint: '置顶与收藏会排在选择器最前；已隐藏的模型不会出现在选择器里。',
        loading: '读取模型中…',
        retry: '重试',
        refresh: '重新检查网关',
        deepProbe: '深探全部',
        deepProbeTitle: '对每个模型发一次最小请求。该网关按 API Key 整体限流，全量探测可能把你自己限流。',
        showAll: '展开全部',
        showFewer: '收起',
        pin: '置顶',
        unpin: '取消置顶',
        favorite: '收藏',
        unfavorite: '取消收藏',
        hide: '隐藏',
        unhide: '取消隐藏',
        probe: '探活',
        probing: '探测中…',
        total: '个模型',
        usable: '可用',
        problems: '异常',
        pinned: '已置顶',
        pickerTitle: '模型',
        search: '搜索模型',
        noModels: '没有匹配的模型。',
        unavailable: '不可用',
        alsoOn: '同时来自',
        selected: '当前',
        fallbackTitle: '已自动切换模型',
        fallbackBody: '额度已用尽，本轮改用',
        dismiss: '知道了',
        diagnostics: '诊断',
        sourceDirectory: '网关目录',
        sourceProbe: '深度探活',
        sourcePassive: '真实请求',
        never: '未检查',
      },
    }

    const LANG = (typeof navigator !== 'undefined' && navigator.language ? navigator.language : 'en')
      .toLowerCase()
      .startsWith('zh') ? 'zh' : 'en'

    /**
     * Translate one key for the active browser locale.
     * @param {string} key - dictionary key.
     * @returns {string} the copy.
     */
    function t(key) {
      return DICT[LANG][key] ?? DICT.en[key] ?? key
    }

    /** Human label and tone for one health status. */
    const STATUS = {
      ok: { tone: 'ok', en: 'usable', zh: '可用' },
      unknown: { tone: 'idle', en: 'not checked', zh: '未检查' },
      retired: { tone: 'bad', en: 'retired at the gateway', zh: '网关已下架' },
      protocol: { tone: 'bad', en: 'wrong protocol for this route', zh: '协议不匹配' },
      quota: { tone: 'warn', en: 'quota exhausted', zh: '额度已用尽' },
      rate_limited: { tone: 'warn', en: 'API key rate limited', zh: 'API Key 被限流' },
      error: { tone: 'bad', en: 'failed', zh: '请求失败' },
    }

    /**
     * One status row's label.
     * @param {string} status - health status.
     * @returns {string} the label.
     */
    function statusLabel(status) {
      const entry = STATUS[status] ?? STATUS.error
      return LANG === 'zh' ? entry.zh : entry.en
    }

    /**
     * One status row's tone class suffix.
     * @param {string} status - health status.
     * @returns {string} `ok`, `warn`, `bad`, or `idle`.
     */
    function statusTone(status) {
      return (STATUS[status] ?? STATUS.error).tone
    }

    /**
     * Whether a row should be listed as a problem.
     * @param {string} status - health status.
     * @returns {boolean} true when the model cannot be used.
     */
    function isProblem(status) {
      return status === 'retired' || status === 'protocol' || status === 'quota' || status === 'error'
    }

    /**
     * One source's label.
     * @param {string} source - 'directory' | 'probe' | 'passive' | other.
     * @returns {string} the label.
     */
    function sourceLabel(source) {
      if (source === 'directory') return t('sourceDirectory')
      if (source === 'probe') return t('sourceProbe')
      if (source === 'passive') return t('sourcePassive')
      return t('never')
    }

    /**
     * Relative time for a timestamp.
     * @param {number} at - epoch milliseconds, 0 when never.
     * @returns {string} a short age.
     */
    function ageOf(at) {
      if (!at) return t('never')
      const seconds = Math.max(0, Math.round((Date.now() - at) / 1000))
      if (seconds < 60) return `${seconds}s`
      if (seconds < 3600) return `${Math.round(seconds / 60)}m`
      return `${Math.round(seconds / 3600)}h`
    }

    /**
     * Inline 16×16 stroke icons.
     *
     * Drawn here rather than loaded: the Client half imports no Harness package
     * and no icon font, so an icon can never fail to resolve. `currentColor`
     * keeps every glyph on the surrounding theme token.
     */
    const ICON_PATHS = {
      // A location pin reads as "pin to top" without a label.
      pin: ['M8 1.6a2.4 2.4 0 0 1 2.4 2.4c0 1.7-1.2 2.6-1.7 3.4h-1.4C6.8 6.6 5.6 5.7 5.6 4A2.4 2.4 0 0 1 8 1.6Z', 'M8 7.4v6.9'],
      star: ['M8 1.9l1.85 3.8 4.15.6-3.02 2.95.72 4.15L8 11.45 4.3 13.4l.72-4.15L2 6.3l4.15-.6Z'],
      eye: ['M1.4 8S3.9 3.9 8 3.9 14.6 8 14.6 8 12.1 12.1 8 12.1 1.4 8 1.4 8Z', 'M8 6.35a1.65 1.65 0 1 0 0 3.3 1.65 1.65 0 0 0 0-3.3Z'],
      eyeOff: ['M6.2 4.1A6.7 6.7 0 0 1 8 3.9c4.1 0 6.6 4.1 6.6 4.1a12 12 0 0 1-2.2 2.6M3.9 5A12 12 0 0 0 1.4 8S3.9 12.1 8 12.1c.7 0 1.4-.1 1.9-.3', 'M2.4 2.4l11.2 11.2'],
      pulse: ['M1.4 8h2.9l1.9-4.1 3 8.2 1.9-4.1h2.9'],
      refresh: ['M13.4 8a5.4 5.4 0 1 1-1.6-3.8', 'M13.6 2v3.3h-3.3'],
      zap: ['M9.2 1.5 3.4 9.1h3.3l-.9 5.4L12.6 7H9.4Z'],
      spinner: ['M8 1.6a6.4 6.4 0 1 0 6.4 6.4'],
    }

    /**
     * One inline icon.
     * @param {object} props - `name`, optional `spin`, optional `filled`.
     * @returns {object} the svg element.
     */
    function Icon(props) {
      const paths = ICON_PATHS[props.name] ?? ICON_PATHS.pulse
      return h('svg', {
        className: `llmm-icon${props.spin === true ? ' llmm-spin' : ''}`,
        viewBox: '0 0 16 16',
        width: 14,
        height: 14,
        'aria-hidden': 'true',
        focusable: 'false',
        fill: props.filled === true ? 'currentColor' : 'none',
        stroke: 'currentColor',
        strokeWidth: 1.5,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
      }, paths.map((d, index) => h('path', { key: index, d })))
    }

    /**
     * An icon-only button whose label appears on hover and on keyboard focus.
     *
     * Icon-only keeps four actions per row narrow enough to sit beside the model
     * name instead of wrapping it; the tooltip carries the label that the text
     * button used to spell out. `aria-label` keeps it readable to a screen
     * reader, which is why no native `title` is set — two tooltips at different
     * delays would overlap.
     *
     * @param {object} props - `icon`, `label`, `on`, `tip`, optional `active`, `danger`, `pending`, `filled`, `disabled`.
     * @returns {object} the button element.
     */
    function IconButton(props) {
      const busy = props.pending === true
      return h('button', {
        type: 'button',
        className: `llmm-ibtn${props.active === true ? ' llmm-on' : ''}${props.danger === true ? ' llmm-danger' : ''}${busy ? ' llmm-busy' : ''}`,
        disabled: props.disabled === true || busy,
        'aria-label': props.label,
        'aria-pressed': props.active === true ? 'true' : undefined,
        onClick: busy ? undefined : props.on,
        onMouseEnter: (event) => props.tip.show(props.label, event.currentTarget),
        onFocus: (event) => props.tip.show(props.label, event.currentTarget),
        onMouseLeave: props.tip.hide,
        onBlur: props.tip.hide,
      }, h(Icon, { name: busy ? 'spinner' : props.icon, spin: busy, filled: props.filled }))
    }

    /** Stylesheet text shared by all three contributions, built from theme tokens only. */
    const CSS = `
.llmm-root{font-size:12px;color:var(--dsw-alias-label-primary)}
.llmm-panel{margin-top:8px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:10px;background:var(--dsw-alias-bg-layer-2)}
.llmm-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.llmm-title{font-weight:600}
.llmm-hint{color:var(--dsw-alias-label-secondary);margin:6px 0 8px;line-height:1.5}
.llmm-counts{display:flex;gap:10px;flex-wrap:wrap;color:var(--dsw-alias-label-secondary);margin-bottom:6px}
.llmm-count b{color:var(--dsw-alias-label-primary)}
.llmm-actions{display:flex;gap:6px;flex-wrap:wrap;margin-left:auto}
.llmm-btn{font:inherit;padding:3px 8px;border-radius:6px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);cursor:pointer;transition:border-color .12s ease,background .12s ease,color .12s ease,transform .08s ease}
.llmm-btn:hover{border-color:var(--dsw-alias-border-l2)}
.llmm-btn[disabled]{opacity:.5;cursor:default}
.llmm-btn.llmm-on{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary)}
.llmm-btn.llmm-danger{color:var(--dsw-alias-state-error-primary)}
/* Icon buttons: a fixed 26px square keeps four row actions narrow enough to sit
   beside the model name, and stops the row reflowing when a label changes. */
.llmm-ibtn{display:inline-flex;align-items:center;justify-content:center;width:26px;height:24px;padding:0;border-radius:6px;border:1px solid transparent;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;transition:background .12s ease,border-color .12s ease,color .12s ease,transform .08s ease}
.llmm-ibtn:hover{border-color:var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary)}
.llmm-ibtn:active{transform:scale(.92)}
.llmm-ibtn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.llmm-ibtn[disabled]{opacity:.5;cursor:default;transform:none}
.llmm-ibtn.llmm-on{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary)}
.llmm-ibtn.llmm-danger:hover{color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary)}
.llmm-icon{display:block;flex:none}
.llmm-spin{animation:llmm-rotate .9s linear infinite}
@keyframes llmm-rotate{to{transform:rotate(360deg)}}
/* The hover label. Fixed positioning matters: the row list is a scroll
   container, so an in-flow tooltip would be clipped at its edges. */
.llmm-tip{position:fixed;z-index:80;transform:translate(-50%,-100%);pointer-events:none;padding:3px 8px;border-radius:6px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-overlay);color:var(--dsw-alias-label-primary);font-size:11px;line-height:1.5;white-space:nowrap;box-shadow:0 4px 14px rgba(0,0,0,.16);animation:llmm-tip-in .1s ease-out}
@keyframes llmm-tip-in{from{opacity:0;transform:translate(-50%,-90%)}to{opacity:1;transform:translate(-50%,-100%)}}
.llmm-rows{display:flex;flex-direction:column;gap:4px;max-height:340px;overflow:auto;margin-top:6px}
.llmm-row{display:flex;align-items:center;gap:8px;padding:4px 6px;border-radius:6px;border:1px solid transparent}
.llmm-row:hover{background:var(--dsw-alias-bg-layer-1);border-color:var(--dsw-alias-border-l1)}
.llmm-row.llmm-hidden{opacity:.55}
.llmm-dot{width:8px;height:8px;border-radius:50%;flex:none;background:var(--dsw-alias-state-idle-primary)}
.llmm-dot.ok{background:var(--dsw-alias-state-success-primary)}
.llmm-dot.warn{background:var(--dsw-alias-state-warn-primary)}
.llmm-dot.bad{background:var(--dsw-alias-state-error-primary)}
.llmm-name{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.llmm-why{color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;min-width:60px}
.llmm-rowacts{display:flex;gap:2px;margin-left:auto;opacity:.6;transition:opacity .12s ease}
.llmm-row:hover .llmm-rowacts,.llmm-row:focus-within .llmm-rowacts{opacity:1}
.llmm-chip{font-size:11px;padding:1px 6px;border-radius:999px;border:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary);flex:none}
.llmm-err{color:var(--dsw-alias-state-error-primary);margin-top:6px}
.llmm-trigger{display:flex;align-items:center;gap:6px;max-width:220px;font:inherit;padding:4px 8px;border-radius:8px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);cursor:pointer}
.llmm-trigger:hover{border-color:var(--dsw-alias-border-l2)}
.llmm-trigger.llmm-locked{opacity:.55;cursor:default}
.llmm-trigger-label{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.llmm-menu{position:fixed;z-index:60;width:min(520px,92vw);max-height:min(440px,70vh);display:flex;flex-direction:column;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-overlay);box-shadow:0 12px 32px rgba(0,0,0,.18);overflow:hidden;font-size:12px;color:var(--dsw-alias-label-primary)}
.llmm-menu-head{padding:8px;border-bottom:1px solid var(--dsw-alias-border-l1);display:flex;gap:8px;align-items:center}
.llmm-input{font:inherit;flex:1;padding:5px 8px;border-radius:6px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary)}
.llmm-menu-body{overflow:auto;padding:4px}
.llmm-group{position:sticky;top:0;background:var(--dsw-alias-bg-overlay);color:var(--dsw-alias-label-secondary);padding:6px 8px 2px;font-weight:600}
.llmm-item{display:flex;align-items:center;gap:8px;width:100%;text-align:left;font:inherit;padding:5px 8px;border-radius:6px;border:1px solid transparent;background:transparent;color:var(--dsw-alias-label-primary);cursor:pointer}
.llmm-item:hover{background:var(--dsw-alias-bg-layer-1)}
.llmm-item.llmm-active{border-color:var(--dsw-alias-brand-primary)}
.llmm-item.llmm-down{opacity:.6}
.llmm-empty{padding:12px;color:var(--dsw-alias-label-secondary);text-align:center}
.llmm-banner{display:flex;align-items:center;gap:8px;margin:4px 0;padding:6px 10px;border-radius:8px;border:1px solid var(--dsw-alias-state-warn-primary);background:var(--dsw-alias-bg-layer-2);font-size:12px;color:var(--dsw-alias-label-primary)}
.llmm-banner b{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
.llmm-banner .llmm-grow{flex:1}
`

    /**
     * Call the Host route.
     * @param {object} body - request body.
     * @returns {Promise<object>} the decoded envelope.
     */
    async function callHost(body) {
      const response = await fetch(ROUTE, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      const data = await response.json().catch(() => null)
      if (data === null || data.ok !== true) {
        throw new Error(data !== null && data.message ? data.message : `llm-manage route answered HTTP ${response.status}`)
      }
      return data
    }

    /**
     * The shared snapshot store: one read per mount, refreshed by any mutation.
     * @returns {{snap: object|null, error: string, busy: boolean, reload: Function, apply: Function, setError: Function, setBusy: Function}} the store.
     */
    function useSnapshot() {
      const [snap, setSnap] = useState(null)
      const [error, setError] = useState('')
      const [busy, setBusy] = useState(false)
      const alive = useRef(true)
      useEffect(() => () => { alive.current = false }, [])
      const reload = useCallback(async (force) => {
        setBusy(true)
        try {
          const data = await callHost({ action: 'snapshot', forceDirectory: force === true })
          if (alive.current) { setSnap(data.value); setError('') }
        } catch (failure) {
          if (alive.current) setError(failure instanceof Error ? failure.message : String(failure))
        } finally {
          if (alive.current) setBusy(false)
        }
      }, [])
      useEffect(() => { reload(false) }, [reload])
      return { snap, error, busy, reload, apply: setSnap, setError, setBusy }
    }

    /** Inline stylesheet element; unmounting removes it with the component. */
    function Style() {
      return h('style', null, CSS)
    }

    /**
     * The provider card's model management area.
     * @param {object} props - owner share: the card's directory row.
     * @returns {object} the panel.
     */
    function Panel(props) {
      const provider = props && props.provider ? props.provider : {}
      const route = typeof provider.provider === 'string' ? provider.provider : typeof provider.id === 'string' ? provider.id : ''
      const { snap, error, busy, reload, apply, setError, setBusy } = useSnapshot()
      const [expanded, setExpanded] = useState(false)
      const [pending, setPending] = useState('')
      const [tip, setTip] = useState(null)

      /**
       * The hover/focus label channel shared by every icon button.
       *
       * Kept at the panel root so the tooltip is a sibling of the scrolling row
       * list, never a child of it. `position: fixed` then places it against the
       * viewport, and the coordinates are clamped so a button near an edge does
       * not push the label off-screen.
       *
       * @returns {{show: Function, hide: Function}} the channel.
       */
      const tipChannel = useMemo(() => ({
        show: (text, node) => {
          if (!node || typeof node.getBoundingClientRect !== 'function') return
          const rect = node.getBoundingClientRect()
          const half = Math.max(40, text.length * 5.5)
          const width = typeof window === 'undefined' ? 0 : window.innerWidth
          const x = Math.min(Math.max(rect.left + rect.width / 2, half), Math.max(half, width - half))
          setTip({ text, x, y: rect.top - 6 })
        },
        hide: () => setTip(null),
      }), [])

      const group = useMemo(
        () => (snap && Array.isArray(snap.groups) ? snap.groups.find(candidate => candidate.route === route) : undefined),
        [snap, route],
      )

      const rows = group ? group.rows : []
      const counts = useMemo(() => ({
        total: rows.length,
        usable: rows.filter(row => row.status === 'ok').length,
        problems: rows.filter(row => isProblem(row.status)).length,
        pinned: rows.filter(row => row.pinned).length,
        favorites: rows.filter(row => row.favorite).length,
      }), [rows])

      // Pinned, then favorites, then flagged rows, then the rest: the panel's
      // first screen is the part that needs a decision.
      const ordered = useMemo(() => rows.slice().sort((left, right) => {
        const score = (row) => (row.pinned ? 0 : row.favorite ? 1 : isProblem(row.status) ? 2 : 3)
        return score(left) - score(right) || left.model.localeCompare(right.model)
      }), [rows])
      const visible = expanded ? ordered : ordered.slice(0, 8)

      /**
       * Run one mutating action and fold its returned snapshot back in.
       * @param {string} key - the row or action being run.
       * @param {object} body - the Host request.
       * @returns {Promise<boolean>} whether the Host accepted the mutation.
       */
      const run = useCallback(async (key, body) => {
        setPending(key)
        try {
          const data = await callHost(body)
          if (data.snapshot !== undefined) apply(data.snapshot)
          setError('')
          return true
        } catch (failure) {
          setError(failure instanceof Error ? failure.message : String(failure))
          return false
        } finally {
          setPending('')
        }
      }, [apply, setError])

      /**
       * Flip one overlay list for one row.
       *
       * The flag is applied locally first so the row answers the click in the
       * same frame, then the Host's authoritative snapshot replaces it. A failed
       * request restores the pre-click snapshot, so an optimistic flip can never
       * leave the panel claiming a state the Host did not accept.
       *
       * @param {object} row - the row.
       * @param {string} list - 'pins' | 'favorites' | 'hidden'.
       * @param {boolean} on - desired membership.
       * @returns {Promise<void>} fulfillment once the UI updated.
       */
      const toggle = useCallback((row, list, on) => {
        const field = list === 'hidden' ? 'hidden' : list === 'pins' ? 'pinned' : 'favorite'
        const before = snap
        if (snap && Array.isArray(snap.groups)) {
          apply({
            ...snap,
            groups: snap.groups.map(candidate => (candidate.route !== row.route ? candidate : {
              ...candidate,
              rows: candidate.rows.map(entry => (entry.model !== row.model ? entry : { ...entry, [field]: on })),
            })),
          })
        }
        return run(`${list}:${row.model}`, {
          action: 'toggle', route: row.route, model: row.model, list, on,
        }).then((accepted) => { if (accepted !== true && before !== null) apply(before) })
      }, [run, snap, apply])

      /**
       * Deep-probe every currently listed model on this route, throttled by the Host.
       * @returns {Promise<void>} fulfillment once the UI updated.
       */
      const probeAll = useCallback(async () => {
        const targets = rows
          .filter(row => row.hidden !== true)
          .map(row => ({ route: row.route, model: row.model }))
        if (targets.length === 0) return
        setBusy(true)
        try {
          const data = await callHost({ action: 'probeBatch', targets })
          if (data.snapshot !== undefined) apply(data.snapshot)
          setError('')
        } catch (failure) {
          setError(failure instanceof Error ? failure.message : String(failure))
        } finally {
          setBusy(false)
        }
      }, [rows, apply, setError, setBusy])

      if (route === '') return null

      return h(React.Fragment, null,
        h(Style),
        h('div', { className: 'llmm-root llmm-panel' },
          h('div', { className: 'llmm-head' },
            h('span', { className: 'llmm-title' }, t('panelTitle')),
            group ? h('span', { className: 'llmm-chip' }, `${counts.total} ${t('total')}`) : null,
            h('div', { className: 'llmm-actions' },
              h(IconButton, {
                icon: 'refresh', label: t('refresh'), disabled: busy, tip: tipChannel,
                on: () => reload(true),
              }),
              h(IconButton, {
                icon: 'zap', label: t('deepProbe'), disabled: busy || rows.length === 0, tip: tipChannel,
                on: () => {
                  if (typeof confirm === 'function' && !confirm(t('deepProbeTitle'))) return
                  probeAll()
                },
              }),
            ),
          ),
          h('div', { className: 'llmm-hint' }, t('panelHint')),
          group
            ? h('div', { className: 'llmm-counts' },
              h('span', { className: 'llmm-count' }, `${t('usable')} `, h('b', null, String(counts.usable))),
              h('span', { className: 'llmm-count' }, `${t('problems')} `, h('b', null, String(counts.problems))),
              h('span', { className: 'llmm-count' }, `${t('pinned')} `, h('b', null, String(counts.pinned))),
            )
            : null,
          busy && snap === null ? h('div', { className: 'llmm-hint' }, t('loading')) : null,
          error !== ''
            ? h('div', { className: 'llmm-err' }, error, ' ', h('button', { type: 'button', className: 'llmm-btn', onClick: () => reload(false) }, t('retry')))
            : null,
          h('div', { className: 'llmm-rows' },
            visible.map(row => h('div', {
              key: row.model,
              className: `llmm-row${row.hidden ? ' llmm-hidden' : ''}`,
            },
              h('span', { className: `llmm-dot ${statusTone(row.status)}`, title: statusLabel(row.status) }),
              h('span', { className: 'llmm-name', title: row.model }, row.model),
              isProblem(row.status)
                ? h('span', { className: 'llmm-chip' }, statusLabel(row.status))
                : null,
              h('span', { className: 'llmm-why', title: `${sourceLabel(row.source)} · ${ageOf(row.at)}${row.reason ? ` · ${row.reason}` : ''}` },
                row.reason !== '' ? `${sourceLabel(row.source)} · ${ageOf(row.at)} · ${row.reason}` : `${statusLabel(row.status)} · ${sourceLabel(row.source)}`,
              ),
              row.alsoOn && row.alsoOn.length > 0
                ? h('span', { className: 'llmm-chip', title: `${t('alsoOn')}: ${row.alsoOn.join(', ')}` }, `${t('alsoOn')} ${row.alsoOn.length}`)
                : null,
              h('div', { className: 'llmm-rowacts' },
                h(IconButton, {
                  icon: 'pin', label: row.pinned ? t('unpin') : t('pin'), active: row.pinned,
                  pending: pending === `pins:${row.model}`, tip: tipChannel,
                  on: () => toggle(row, 'pins', !row.pinned),
                }),
                h(IconButton, {
                  icon: 'star', label: row.favorite ? t('unfavorite') : t('favorite'), active: row.favorite,
                  filled: row.favorite, pending: pending === `favorites:${row.model}`, tip: tipChannel,
                  on: () => toggle(row, 'favorites', !row.favorite),
                }),
                h(IconButton, {
                  icon: row.hidden ? 'eyeOff' : 'eye', label: row.hidden ? t('unhide') : t('hide'), active: row.hidden,
                  pending: pending === `hidden:${row.model}`, tip: tipChannel,
                  on: () => toggle(row, 'hidden', !row.hidden),
                }),
                h(IconButton, {
                  icon: 'pulse', label: pending === `probe:${row.model}` ? t('probing') : t('probe'),
                  danger: isProblem(row.status), pending: pending === `probe:${row.model}`, tip: tipChannel,
                  on: () => run(`probe:${row.model}`, { action: 'probe', route: row.route, model: row.model }),
                }),
              ),
            )),
            rows.length === 0 && !busy ? h('div', { className: 'llmm-empty' }, t('noModels')) : null,
          ),
          ordered.length > 8
            ? h('button', {
              type: 'button', className: 'llmm-btn',
              style: { marginTop: '6px' },
              onClick: () => setExpanded(value => !value),
            }, expanded ? t('showFewer') : `${t('showAll')} (${ordered.length})`)
            : null,
          snap && snap.directory
            ? h('div', { className: 'llmm-hint' }, snap.directory
              .filter(entry => entry.route === route)
              .map(entry => entry.ok
                ? `${t('sourceDirectory')}: ${entry.count} @ ${ageOf(entry.at)}`
                : `${t('sourceDirectory')}: ${entry.error}`)
              .join(' · '))
            : null,
          // Rendered at the panel root, outside the scrolling row list, so no
          // ancestor can clip it.
          tip ? h('div', { className: 'llmm-tip', style: { left: `${tip.x}px`, top: `${tip.y}px` }, role: 'tooltip' }, tip.text) : null,
        ),
      )
    }

    /**
     * The composer model picker: favorites and pins first, with each unusable
     * row carrying its reason and skipped by selection.
     *
     * It receives the same injected face the shipped picker does, because the
     * composer's `conversation.input.model` seat is `single`: whoever renders
     * must supply the directory store and the select verb, or the composer loses
     * its model control entirely.
     *
     * @param {object} props - owner share plus this registration's inject face.
     * @returns {object} the trigger and, while open, the menu.
     */
    function Picker(props) {
      const { available, directory, load, select, locked } = props
      const state = useSyncExternalStore(
        React.useCallback(fn => (directory ? directory.subscribe(fn) : () => {}), [directory]),
        React.useCallback(() => (directory ? directory.getSnapshot() : null), [directory]),
      )
      const [snap, setSnap] = useState(null)
      const [open, setOpen] = useState(false)
      const [query, setQuery] = useState('')
      const [position, setPosition] = useState(null)
      const [failure, setFailure] = useState('')
      const triggerRef = useRef(null)
      const menuRef = useRef(null)

      useEffect(() => { if (available) load() }, [available, load])

      useEffect(() => {
        let alive = true
        callHost({ action: 'snapshot' })
          .then((data) => { if (alive) setSnap(data.value) })
          .catch(() => { /* the picker still works without the overlay */ })
        return () => { alive = false }
      }, [])

      const place = useCallback(() => {
        const node = triggerRef.current
        if (node === null) return
        const rect = node.getBoundingClientRect()
        const width = Math.min(520, Math.max(280, window.innerWidth - 24))
        const height = Math.min(440, Math.max(200, window.innerHeight * 0.7))
        const left = Math.min(Math.max(8, rect.left), Math.max(8, window.innerWidth - width - 8))
        const above = rect.top - height - 8 >= 8
        setPosition({
          left: `${left}px`,
          width: `${width}px`,
          maxHeight: `${height}px`,
          ...(above ? { bottom: `${Math.max(8, window.innerHeight - rect.top + 8)}px` } : { top: `${rect.bottom + 8}px` }),
        })
      }, [])

      useEffect(() => {
        if (!open) return undefined
        place()
        const onDown = (event) => {
          if (menuRef.current !== null && menuRef.current.contains(event.target)) return
          if (triggerRef.current !== null && triggerRef.current.contains(event.target)) return
          setOpen(false)
        }
        const onKey = (event) => { if (event.key === 'Escape') setOpen(false) }
        const onMove = () => place()
        document.addEventListener('mousedown', onDown)
        document.addEventListener('keydown', onKey)
        window.addEventListener('resize', onMove)
        window.addEventListener('scroll', onMove, true)
        return () => {
          document.removeEventListener('mousedown', onDown)
          document.removeEventListener('keydown', onKey)
          window.removeEventListener('resize', onMove)
          window.removeEventListener('scroll', onMove, true)
        }
      }, [open, place])

      const current = state ? state.current : null
      const overlay = useMemo(() => {
        const map = new Map()
        if (snap === null) return map
        for (const group of snap.groups) for (const row of group.rows) map.set(`${row.route}/${row.model}`, row)
        return map
      }, [snap])

      // Prefer the Host's merged view, since only it knows the overlay and
      // health. When the route is unavailable, fall back to the shipped
      // catalog's own groups so this shadowed seat still offers every model:
      // shadowing must never be the reason a model cannot be selected.
      const groups = useMemo(() => {
        const needle = query.trim().toLowerCase()
        const source = snap !== null
          ? snap.groups.map(group => ({
            route: group.route,
            name: group.name,
            rows: group.rows
              .filter(row => !row.hidden)
              .map(row => ({ route: row.route, model: row.model })),
          }))
          : (state && Array.isArray(state.groups) ? state.groups : []).map(group => ({
            route: group.id,
            name: group.name,
            rows: group.models.map(model => ({ route: group.id, model: model.id })),
          }))
        return source
          .map(group => ({
            ...group,
            rows: group.rows.filter(row => needle === '' || row.model.toLowerCase().includes(needle)),
          }))
          .filter(group => group.rows.length > 0)
      }, [snap, state, query])

      const choose = useCallback(async (row) => {
        setFailure('')
        const reuseEffort = current !== null && current.provider === row.route && current.model === row.model
          ? (state && state.retainedEffort !== undefined ? state.retainedEffort : undefined)
          : undefined
        const result = await select({
          provider: row.route,
          model: row.model,
          ...(reuseEffort === undefined ? {} : { reasoningEffort: reuseEffort }),
        })
        // `select` resolves a RemoteResult; a carrier failure is a value here,
        // not a rejection, so it must be read explicitly.
        if (result && result.ok === false) {
          const error = result.error
          setFailure(error && error.message ? error.message : JSON.stringify(error))
          return
        }
        callHost({ action: 'use', route: row.route, model: row.model }).catch(() => {})
        setOpen(false)
      }, [select, current, state])

      if (available !== true) return null

      const triggerLabel = current === null
        ? t('pickerTitle')
        : `${current.model}${current.provider === '' ? '' : ` · ${current.provider}`}`

      return h(React.Fragment, null,
        h(Style),
        h('div', { className: 'llmm-root', style: { display: 'inline-flex' } },
          h('button', {
            ref: triggerRef,
            type: 'button',
            className: `llmm-trigger${locked ? ' llmm-locked' : ''}`,
            disabled: locked,
            title: triggerLabel,
            onClick: () => setOpen(value => !value),
          },
            h('span', { className: 'llmm-trigger-label' }, triggerLabel),
            h('span', { 'aria-hidden': true }, '▾'),
          ),
        ),
        open && position !== null
          ? h('div', { className: 'llmm-menu', style: position, ref: menuRef, role: 'dialog', 'aria-label': t('pickerTitle') },
            h('div', { className: 'llmm-menu-head' },
              h('input', {
                className: 'llmm-input',
                placeholder: t('search'),
                value: query,
                autoFocus: true,
                onChange: event => setQuery(event.target.value),
              }),
            ),
            h('div', { className: 'llmm-menu-body' },
              groups.length === 0 ? h('div', { className: 'llmm-empty' }, t('noModels')) : null,
              groups.map(group => h('div', { key: group.route },
                h('div', { className: 'llmm-group' }, group.name || group.route),
                group.rows.map((row) => {
                  const overlayRow = overlay.get(`${row.route}/${row.model}`)
                  const status = overlayRow ? overlayRow.status : 'unknown'
                  const down = isProblem(status)
                  const active = current !== null && current.provider === row.route && current.model === row.model
                  return h('button', {
                    key: `${row.route}/${row.model}`,
                    type: 'button',
                    className: `llmm-item${active ? ' llmm-active' : ''}${down ? ' llmm-down' : ''}`,
                    title: overlayRow && overlayRow.reason ? overlayRow.reason : statusLabel(status),
                    onClick: () => { choose(row) },
                  },
                    h('span', { className: `llmm-dot ${statusTone(status)}` }),
                    h('span', { className: 'llmm-name' }, row.model),
                    down ? h('span', { className: 'llmm-chip' }, statusLabel(status)) : null,
                    active ? h('span', { className: 'llmm-chip' }, t('selected')) : null,
                  )
                }),
              )),
            ),
            failure !== '' ? h('div', { className: 'llmm-err', style: { padding: '8px' } }, failure) : null,
          )
          : null,
      )
    }

    /**
     * The composer banner that reports an automatic model switch.
     * @param {object} props - slot props, including the session id when supplied.
     * @returns {object|null} the banner, or nothing when no switch happened.
     */
    function FallbackBanner(props) {
      const sessionId = typeof props?.sessionId === 'string' ? props.sessionId : ''
      const [note, setNote] = useState(null)
      const [hiddenAt, setHiddenAt] = useState(0)

      useEffect(() => {
        if (sessionId === '') return undefined
        let alive = true
        const tick = () => {
          callHost({ action: 'fallbackLog', sessionId })
            .then((data) => { if (alive) setNote(data.value ?? null) })
            .catch(() => { /* the banner is advisory only */ })
        }
        tick()
        const timer = setInterval(tick, 5000)
        return () => { alive = false; clearInterval(timer) }
      }, [sessionId])

      if (note === null || note === undefined) return null
      if (note.at <= hiddenAt) return null
      if (Date.now() - note.at > 5 * 60 * 1000) return null

      const from = note.from ? `${note.from.route}/${note.from.model}` : ''
      const to = note.to ? `${note.to.route}/${note.to.model}` : ''
      return h(React.Fragment, null,
        h(Style),
        h('div', { className: 'llmm-root llmm-banner', role: 'status' },
          h('span', null, '⚠'),
          h('span', null, `${t('fallbackTitle')}: `, h('b', null, from)),
          h('span', { className: 'llmm-grow' }, ` ${t('fallbackBody')} `, h('b', null, to), note.detail ? ` (${note.detail})` : ''),
          h('button', { type: 'button', className: 'llmm-btn', onClick: () => setHiddenAt(note.at) }, t('dismiss')),
        ),
      )
    }

    return {
      inject: ['slots', 'modelDirectories', 'sessions'],
      apply(ctx) {
        // The panel rides the provider card its settings namespace owns, which
        // is where this route's models are already configured.
        ctx.slots.inject('settings.models.provider-card', () => ctx.slots.register({
          name: 'settings.models.provider-card',
          key: 'llm-pi-ai',
          id: 'llm-manage-panel',
          order: 10,
        }, Panel))

        // The banner sits in the composer dock and reports only switches that
        // happened in this session.
        ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
          name: 'conversation.input.dock',
          id: 'llm-manage-fallback',
          order: 5,
        }, FallbackBanner))

        // Shadow the shipped picker at priority -1 (lowest renders) so pins and
        // favorites come first. The seat is `single`, so this registration must
        // supply the business face the shipped one does: the same directory
        // store and the same select verb, taken from the same services.
        ctx.slots.inject('conversation.input.model', () => {
          const models = ctx.modelDirectories
          const sessions = ctx.sessions
          return ctx.slots.register({
            name: 'conversation.input.model',
            id: 'llm-manage-picker',
            priority: -1,
            inject: (sessionId) => {
              const directory = models.directoryFor(sessionId)
              // Agents addressed through a subagent cannot select their own
              // model; the shipped picker withdraws for them too.
              const available = sessions.subagentAddress(sessionId) === undefined
              return {
                available,
                directory: directory.store,
                load: () => {
                  if (available) directory.load().catch(() => { /* surfaced on the store */ })
                },
                select: (selection) => available
                  ? directory.select(selection)
                  : Promise.resolve(undefined),
              }
            },
          }, Picker)
        })
      },
    }
  },
})
