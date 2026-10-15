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
    // The picker card must leave this React subtree's DOM ancestry to be placed
    // freely: the composer row it lives in declares `container-type: inline-size`,
    // which implies `contain: layout` and therefore makes that row the containing
    // block for `position: fixed` descendants. In-tree, the card is confined to
    // the composer's stacking context, so the right sidebar column paints over it
    // and no z-index can win — a huge z-index was measured losing. Portalling to
    // <body> restores the viewport as the containing block, which is what the
    // placement maths below already assumes, and lifts the card above the
    // sidebar's own layers. React keeps these events bubbling through the React
    // tree, so the document-level dismiss and key handlers stay live.
    const { createPortal } = require('react-dom')
    const h = React.createElement
    const { useState, useEffect, useRef, useCallback, useMemo, useSyncExternalStore } = React

    /** The Host route this half talks to. */
    const ROUTE = '/api/llm-manage'

    /**
     * How many frequently used models the picker lifts into their own section.
     *
     * Capped deliberately: the section is a shortcut to the models the user
     * actually reaches for, not a second copy of the catalogue, and an uncapped
     * list would push the first real route group off the screen.
     */
    const FREQUENT_LIMIT = 5

    /**
     * Where the row-density choice is remembered.
     *
     * Namespaced by the plugin route so it cannot collide with anything else the
     * app stores, and read defensively: `localStorage` throws in a sandboxed
     * frame, and a stored value that is not one of the two densities (an older
     * build, a hand edit) must fall back rather than render nothing.
     */
    const DENSITY_KEY = 'llm-manage:density'
    const DENSITIES = ['compact', 'comfortable']
    const readDensity = () => {
      try {
        const stored = window.localStorage.getItem(DENSITY_KEY)
        return DENSITIES.includes(stored) ? stored : 'compact'
      } catch { return 'compact' }
    }
    const writeDensity = (value) => {
      try { window.localStorage.setItem(DENSITY_KEY, value) } catch { /* not fatal */ }
    }

    /** Dictionary, so both supported locales read naturally. */
    const DICT = {
      en: {
        panelTitle: 'Models',
        panelHint: 'Pinned and favorite models get their own sections at the top of the model picker; hidden models leave it.',
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
        sectionPinned: 'Pinned',
        sectionFavorites: 'Favorites',
        sectionFrequent: 'Most used',
        level: 'level',
        levelShort: 'Lv',
        usesLabel: 'uses',
        attemptsLabel: 'failed attempts',
        tokensLabel: 'tokens in/out',
        lastUsed: 'last used',
        neverUsed: 'never used',
        trendUp: 'busier this week',
        trendDown: 'quieter this week',
        trendFlat: 'steady this week',
        roster: 'Most used',
        rosterEmpty: 'No model has been used yet. Proficiency appears after the first request.',
        sortLabel: 'Sort',
        sortDefault: 'Default',
        sortLevel: 'By proficiency',
        sortHeat: 'By recent use',
        seededNote: 'counted from your existing session logs',
        resetUsage: 'Clear usage',
        resetUsageTitle: 'Deletes the locally recorded usage counters. This cannot be undone.',
        usageCleared: 'Usage counters cleared.',
        scanHistory: 'Scan history',
        scanHistoryTitle: 'Counts the session logs already on disk, so models you have been using start at their real level instead of level 1. Runs in the background and resumes if it is interrupted.',
        seedWaiting: 'History scan: waiting for the session service.',
        seedRunning: 'History scan: reading your session logs…',
        seedDone: 'History scan: {n} model response(s) counted from {s} session(s).',
        seedEmpty: 'History scan: nothing new to count.',
        seedFailed: 'History scan stopped: {reason}',
        // Order freeze. Toggling a pin no longer moves the row, so the panel says
        // when the order it is showing is no longer the order the sort would
        // produce — otherwise a pin that does not move reads as a pin that failed.
        orderPending: 'A pin changed since this order was set. It updates on collapse/expand, sort or refresh.',
        // Density: the reason is the most informative column and the first to be
        // truncated, so "compact" leads with it instead of trailing it.
        densityLabel: 'Rows',
        densityCompact: 'Compact',
        densityComfortable: 'Comfortable',
        expandRow: 'Show details',
        collapseRow: 'Hide details',
        detailStatus: 'Status',
        detailReason: 'Reason',
        detailSource: 'Checked by',
        detailChecked: 'Checked',
        detailDirectory: 'Gateway directory',
        detailListed: 'listed',
        detailMissing: 'not listed',
        detailLevel: 'Proficiency',
        detailNextLevel: 'next level at',
        detailProgress: 'Progress',
        detailUses: 'Uses',
        detailRecent7: 'Last 7 days',
        detailPrior7: 'Previous 7 days',
        detailHeat: 'Heat',
        detailFirstUsed: 'First used',
        detailLastUsed: 'Last used',
        detailTokens: 'Tokens in/out',
        detailOrigin: 'Counted',
        detailOriginSeeded: 'from session logs',
        detailOriginLive: 'as it happened',
        detailAlsoOn: 'Also on',
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
        panelHint: '置顶与收藏的模型会在选择器顶部单独成组；已隐藏的模型不会出现在选择器里。',
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
        sectionPinned: '置顶',
        sectionFavorites: '收藏',
        sectionFrequent: '常用',
        level: '熟练度',
        levelShort: 'Lv',
        usesLabel: '次调用',
        attemptsLabel: '次失败',
        tokensLabel: '输入/输出 tokens',
        lastUsed: '最近使用',
        neverUsed: '未使用',
        trendUp: '本周更活跃',
        trendDown: '本周转冷',
        trendFlat: '本周持平',
        roster: '主力阵容',
        rosterEmpty: '还没有使用记录。发出第一次请求后就会出现熟练度。',
        sortLabel: '排序',
        sortDefault: '默认',
        sortLevel: '按熟练度',
        sortHeat: '按近期热度',
        seededNote: '来自已有会话日志的统计',
        resetUsage: '清空使用统计',
        resetUsageTitle: '删除本地记录的使用统计，无法撤销。',
        usageCleared: '使用统计已清空。',
        scanHistory: '扫描历史',
        scanHistoryTitle: '统计磁盘上已有的会话日志，让你一直在用的模型从真实等级开始，而不是从 1 级。后台运行，可续跑。',
        seedWaiting: '历史扫描：正在等待会话服务。',
        seedRunning: '历史扫描：正在读取会话日志…',
        seedDone: '历史扫描：从 {s} 个会话中统计到 {n} 次模型响应。',
        seedEmpty: '历史扫描：没有新的可统计内容。',
        seedFailed: '历史扫描中断：{reason}',
        orderPending: '自上次排序后有过置顶/收藏变更。收起/展开、切换排序或刷新后生效。',
        densityLabel: '行密度',
        densityCompact: '紧凑',
        densityComfortable: '舒适',
        expandRow: '展开详情',
        collapseRow: '收起详情',
        detailStatus: '状态',
        detailReason: '原因',
        detailSource: '检查方式',
        detailChecked: '检查时间',
        detailDirectory: '网关目录',
        detailListed: '已列出',
        detailMissing: '未列出',
        detailLevel: '熟练度',
        detailNextLevel: '升级所需调用',
        detailProgress: '升级进度',
        detailUses: '调用次数',
        detailRecent7: '近 7 天',
        detailPrior7: '前 7 天',
        detailHeat: '热度',
        detailFirstUsed: '首次使用',
        detailLastUsed: '最近使用',
        detailTokens: '输入/输出 token',
        detailOrigin: '统计来源',
        detailOriginSeeded: '来自会话日志',
        detailOriginLive: '实时记录',
        detailAlsoOn: '同名模型',
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
.llmm-root{font-size:14px;color:var(--dsw-alias-label-primary)}
/* The panel is a card on the Models settings page, so it takes that page's card
   material verbatim (ui-settings-models ModelsSection.module.css .rowCard):
   0.5px settings stroke, the settings card fill, radius-xl, 12px/14px padding. It
   used to be bg-layer-2 with a 1px border at 8px, which is not a shape that page
   uses anywhere -- the border read twice as heavy as its neighbours. */
.llmm-panel{display:flex;flex-direction:column;gap:12px;margin-top:12px;border:0.5px solid var(--dsw-alias-settings-card-stroke);background:var(--dsw-alias-settings-card-fill);border-radius:var(--dsw-radius-xl);padding:12px 14px}
.llmm-head{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.llmm-title{font-size:14px;line-height:22px;font-weight:500;color:var(--dsw-alias-label-primary)}
.llmm-hint{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}
.llmm-counts{display:flex;gap:10px;flex-wrap:wrap;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}
.llmm-count b{font-weight:500;color:var(--dsw-alias-label-secondary)}
.llmm-actions{display:flex;gap:4px;flex-wrap:wrap;margin-left:auto}
/* The settings page's compact button: 28px tall, radius-sm, 12/18, and a 0.5px
   border so an outlined control is not 2px taller than the filled one beside it. */
.llmm-btn{box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;gap:4px;height:28px;padding:0 10px;border:0.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;line-height:18px;cursor:pointer;transition:background .12s ease,color .12s ease}
.llmm-btn:hover:not([disabled]){background:var(--dsw-alias-interactive-bg-hover)}
.llmm-btn[disabled]{opacity:.4;cursor:default}
/* The active toggle is a filled state, not a tinted outline: brand-primary is the
   near-black label colour in this theme, so text in it on a transparent button
   would be indistinguishable from the inactive one. */
.llmm-btn.llmm-on{background:var(--dsw-alias-interactive-bg-hover);border-color:var(--dsw-alias-border-l4);color:var(--dsw-alias-label-primary);font-weight:500}
.llmm-btn.llmm-danger{color:var(--dsw-alias-state-error-primary)}
.llmm-btn.llmm-danger:hover:not([disabled]){background:var(--dsw-alias-interactive-bg-hover-danger)}
/* Icon buttons: the settings page's 28px square (ModelsSection .iconButton), which
   keeps four row actions narrow enough to sit beside the model name and stops the
   row reflowing when a label changes. */
.llmm-ibtn{box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;padding:0;border:0;border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-tertiary);cursor:pointer;transition:background .12s ease,color .12s ease}
.llmm-ibtn:hover:not([disabled]){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.llmm-ibtn[disabled]{opacity:.4;cursor:default}
.llmm-ibtn.llmm-on{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.llmm-ibtn.llmm-danger:hover:not([disabled]){background:var(--dsw-alias-interactive-bg-hover-danger);color:var(--dsw-alias-state-error-primary)}
.llmm-icon{display:block;flex:none}
.llmm-spin{animation:llmm-rotate .9s linear infinite}
@keyframes llmm-rotate{to{transform:rotate(360deg)}}
/* The hover label. Fixed positioning matters: the row list is a scroll
   container, so an in-flow tooltip would be clipped at its edges. */
.llmm-tip{position:fixed;z-index:80;transform:translate(-50%,-100%);pointer-events:none;padding:3px 7px;border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-tooltip-bg);color:var(--dsw-static-neutral-bluish-00);font-size:13px;line-height:20px;white-space:nowrap;animation:llmm-tip-in .15s ease-out}
@keyframes llmm-tip-in{from{opacity:0;transform:translate(-50%,-90%)}to{opacity:1;transform:translate(-50%,-100%)}}
.llmm-rows{display:flex;flex-direction:column;gap:2px;max-height:340px;overflow:auto;padding:2px 0;--dsh-scrollbar-thumb:var(--dsw-alias-scrollbar-bg-l1);--dsh-scrollbar-thumb-hover:var(--dsw-alias-scrollbar-hover-l1)}
/* Rows are the settings page's candidate rows: radius-md, 6px/8px inset, no border
   until hover, and the hover fill carries the whole state change. The old 1px
   border on every row drew a box around each one at rest. */
.llmm-row{display:flex;align-items:center;gap:8px;padding:6px 8px;border-radius:var(--dsw-radius-md);border:0;background:transparent;cursor:default}
.llmm-row:hover{background:var(--dsw-alias-interactive-bg-hover)}
.llmm-row.llmm-hidden{opacity:.55}
.llmm-dot{box-sizing:border-box;display:inline-block;width:8px;height:8px;border-radius:50%;corner-shape:round;flex:none;background:var(--dsw-alias-state-idle-primary)}
.llmm-dot.ok{background:var(--dsw-alias-state-success-primary)}
.llmm-dot.warn{background:var(--dsw-alias-state-warn-primary)}
.llmm-dot.bad{background:var(--dsw-alias-state-error-primary)}
/* Model ids are identifiers, so they take the app's code face -- the same choice the
   settings page's own candidate list makes (ModelsSection .candidateId). It used to
   hardcode a Menlo/Consolas stack, which ignored whatever the app configures. */
.llmm-name{font-family:var(--ds-font-family-code);font-size:13px;line-height:20px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.llmm-why{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;min-width:60px}
/* The disclosure control. A chevron rather than a hover-only affordance, for the
   same reason the row actions are not hover-only: a control nobody can find is a
   control nobody uses. It stays a real button so the detail block is reachable
   from the keyboard without making the model name a second tab stop. */
.llmm-chevron{flex:none;width:16px;height:16px;padding:0;border:0;border-radius:var(--dsw-radius-xs);background:transparent;color:var(--dsw-alias-label-tertiary);font:inherit;font-size:10px;line-height:16px;text-align:center;cursor:pointer}
.llmm-chevron:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.llmm-chevron:focus-visible{outline:2px solid var(--dsw-focus-ring-color,var(--dsw-alias-brand-primary));outline-offset:1px}
.llmm-chevron.llmm-chevron-open{color:var(--dsw-alias-label-secondary)}
/* The name is a pointer target for the same disclosure; the chevron is its
   keyboard- and screen-reader-visible twin, so this stays a span. */
.llmm-namebtn{cursor:pointer}
.llmm-namebtn:hover{text-decoration:underline}
/* Comfortable density: the reason stops competing with the chips for one line and
   gets a second one, wrapped to two lines before it ellipsises. */
.llmm-row.llmm-loose{flex-wrap:wrap;row-gap:2px}
.llmm-why-line{order:1;flex:0 0 100%;padding-left:34px;white-space:normal;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
/* The expanded detail block. Fields are label/value pairs on one line each, so a
   long reason wraps under its own label instead of pushing the value off-screen. */
.llmm-detail{margin:0 0 4px 34px;padding:6px 8px;border-left:2px solid var(--dsw-alias-border-l3);border-radius:0 var(--dsw-radius-sm) var(--dsw-radius-sm) 0;background:var(--dsw-alias-bg-layer-1,transparent);display:flex;flex-direction:column;gap:3px}
.llmm-field{display:flex;align-items:baseline;gap:8px;font-size:12px;line-height:18px}
.llmm-field-label{flex:none;width:112px;color:var(--dsw-alias-label-tertiary)}
.llmm-field-value{flex:1;min-width:0;color:var(--dsw-alias-label-secondary);word-break:break-word}
.llmm-bar-field{flex:1;min-width:60px;align-self:center}
.llmm-rowacts{display:flex;gap:2px;margin-left:auto;opacity:.6;transition:opacity .12s ease}
/* Quiet at rest, full on hover or keyboard focus. They stay visible rather than
   appearing on hover: pin/favorite are the point of the panel, and a control you can
   only find by hovering is a control most people never find. */
.llmm-row:hover .llmm-rowacts,.llmm-row:focus-within .llmm-rowacts{opacity:1}
/* The annotation chip is the settings page's row tag, not a pill: 0.5px l3 stroke at
   radius-xs, 11/16, secondary tone. A capsule at 999px beside 12px text read as a
   button. */
.llmm-chip{flex:none;padding:1px 6px;border:0.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-xs);color:var(--dsw-alias-label-secondary);font-size:11px;line-height:16px;white-space:nowrap}
.llmm-err{color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:18px;margin-top:6px}
/* The dropdown card. It takes the same material as every other DSH popover
   (ui-primitives Menu.module.css, and the panel modules that copy it): no border,
   elevation-prominent, and the surface painted on a ::before pseudo-element so the
   translucent menu fill and its backdrop blur sit behind the content instead of
   washing it out.
   Why not --dsw-alias-bg-overlay, which the plugin token contract labels
   "Overlay and popover background": measured in the running app it resolves to
   rgb(233,236,242) in light and rgb(97,102,107) in dark. Painted as an opaque card
   that reads as flat grey -- darker than the white composer it drops out of, and
   muddy in dark mode. DSH's own popovers do not use it either; they use the
   translucent --dsw-specific-menu plus backdrop-filter, which over a white page
   resolves to near-white. That is the material this card now matches. */
.llmm-menu{position:fixed;z-index:1100;width:max-content;min-width:min(240px,100vw - 32px);max-width:min(420px,100vw - 32px);max-height:min(360px,calc(100vh - 96px));display:flex;flex-direction:column;padding:4px;isolation:isolate;border:0;border-radius:var(--dsw-radius-lg);overflow:hidden;box-shadow:var(--dsw-elevation-prominent,0 0 0 .5px var(--dsw-alias-border-l1),0 3px 8px rgba(0,0,0,.04),0 0 20px rgba(0,0,0,.05));--dsw-elevation-stroke-color:var(--dsw-alias-border-l1);--dsh-scrollbar-thumb:var(--dsw-alias-scrollbar-bg-l2);--dsh-scrollbar-thumb-hover:var(--dsw-alias-scrollbar-hover-l2);color:var(--dsw-alias-label-primary);font-size:13px}
/* The material sits on a pseudo-element behind the content rather than on the card
   itself: a backdrop-filter on the card would make it a backdrop root and would
   clip nothing useful, and the scrolling list has to stay above the fill. */
.llmm-menu::before{content:'';position:absolute;inset:0;z-index:-1;border-radius:inherit;background:var(--dsw-specific-menu,var(--dsw-alias-bg-layer-2,var(--dsw-alias-bg-overlay)));backdrop-filter:var(--dsw-menu-backdrop-filter,none)}
.llmm-menu-head{flex:none;display:flex;gap:8px;align-items:center;margin:2px 0 3px}
/* DSH's own model picker keeps the search borderless and transparent inside the
   card, and marks focus with the row-level hover fill rather than a ring. */
/* The settings page's text input: 32px, radius-md, inset 10px, a 0.5px l4 stroke on
   bg-layer-1. The panel's search field had its own 1px/6px/bg-base shape, which read as
   a different control from the fields on the same page. */
.llmm-input{box-sizing:border-box;width:100%;height:32px;padding:0 10px;border:0.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:14px;line-height:22px}
.llmm-input::placeholder{color:var(--dsw-alias-label-dimmed)}
.llmm-input:focus{outline:none;border-color:var(--dsw-alias-state-business-primary)}
/* Inside the menu card the search follows the shipped picker instead: borderless and
   transparent, with the hover fill as its focus indication. A bordered field floating
   in a 4px-inset menu reads as a widget parked on the card. */
.llmm-menu .llmm-input{height:auto;padding:5px 7px;border:0 solid transparent;background:transparent}
.llmm-menu .llmm-input:focus{border-color:transparent;background:var(--dsw-alias-interactive-bg-hover)}
/* The composer trigger matches its neighbours in that row -- the shipped picker's
   trigger and the permission select are borderless 28px chips that show a hover fill.
   A 1px-stroked, filled button made the model control the only boxed item there. */
.llmm-trigger{box-sizing:border-box;display:inline-flex;align-items:center;gap:4px;max-width:220px;height:28px;padding:0 4px 0 8px;border:0;border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:13px;line-height:20px;cursor:pointer}
.llmm-trigger:hover:not([disabled]){background:var(--dsw-alias-interactive-bg-hover)}
.llmm-trigger:focus-visible{outline:none;box-shadow:0 0 0 2px var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary))}
.llmm-trigger.llmm-locked{opacity:.55;cursor:default}
.llmm-trigger-label{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.llmm-menu-body{flex:auto;min-height:0;overflow-y:auto;overflow-x:hidden}
/* Section headings take the Menu primitive's heading metrics (MenuGroup.module.css):
   11/16 at weight 500 in tertiary. One deliberate difference: DSH toggles a fill on
   only while the heading is stuck to the top, driving it from an IntersectionObserver;
   this card keeps the fill on always. Always-on is visually identical when the list is
   scrolled (the case the fill exists for) and avoids rows sliding under transparent
   text when it is not. */
.llmm-group{position:sticky;top:0;z-index:1;padding:4px 7px 2px;font-size:11px;line-height:16px;font-weight:500;color:var(--dsw-alias-label-tertiary);background:var(--dsw-alias-menu-group-header-fill,var(--dsw-alias-bg-layer-2))}
/* MenuGroup separates consecutive groups by 3px; same rhythm here. */
.llmm-menu-body > section + section{margin-top:3px}
/* The route is the same kind of annotation as the panel's "also on" chip: extra
   metadata about one model. Reusing .llmm-chip keeps the two surfaces agreeing on
   how that looks instead of inventing a second treatment for it. */
.llmm-route{margin-left:auto}
/* Proficiency is a rank, so it is tinted rather than plain: the colour carries
   the level at a glance while the number stays exact. Each step is a named token
   with a neutral fallback, so a theme that does not define them still renders a
   readable chip instead of an unstyled blob. */
.llmm-lv{font-variant-numeric:tabular-nums;letter-spacing:0.02em}
.llmm-lv-1{color:var(--dsw-alias-label-tertiary)}
.llmm-lv-2{color:var(--dsw-alias-label-secondary)}
.llmm-lv-3{color:var(--dsw-alias-brand-primary)}
.llmm-lv-4{color:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary)}
.llmm-lv-5{color:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary);font-weight:500}
.llmm-lv-6{color:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary);font-weight:600}
.llmm-lv-7{color:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary);font-weight:700}
/* Trend is decoration on top of the number, so it must never be the only signal:
   the title carries the same fact in words. */
.llmm-trend{flex:none;font-size:10px;line-height:16px}
.llmm-trend-up{color:var(--dsw-alias-state-success-primary)}
.llmm-trend-down{color:var(--dsw-alias-label-tertiary)}
/* The roster strip: three equal cards, so the "heroes" read as a set. */
.llmm-roster{display:flex;flex-direction:column;gap:6px}
.llmm-roster-head{font-size:11px;line-height:16px;font-weight:500;color:var(--dsw-alias-label-tertiary)}
.llmm-roster-cards{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:6px}
.llmm-hero{display:flex;flex-direction:column;gap:4px;min-width:0;padding:8px;border:0.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-2)}
.llmm-hero-top{display:flex;align-items:center;gap:4px}
.llmm-hero-name{font-family:var(--ds-font-family-code);font-size:12px;line-height:16px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.llmm-hero-meta{font-size:11px;line-height:14px;color:var(--dsw-alias-label-tertiary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.llmm-bar{height:4px;border-radius:2px;background:var(--dsw-alias-bg-layer-1,var(--dsw-alias-border-l3));overflow:hidden}
.llmm-bar-fill{height:100%;border-radius:2px;background:var(--dsw-alias-brand-primary,var(--dsw-alias-label-secondary));transition:width .2s ease}
/* Sort control: a segmented row of text buttons, matching the panel's own chips. */
.llmm-sort{display:flex;align-items:center;gap:4px;font-size:11px;line-height:16px}
.llmm-sort-label{color:var(--dsw-alias-label-tertiary)}
.llmm-sortbtn{padding:1px 8px;border:0.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-xs);background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;cursor:pointer}
.llmm-sortbtn:hover{background:var(--dsw-alias-interactive-bg-hover)}
.llmm-sortbtn-on{border-color:var(--dsw-alias-brand-primary,var(--dsw-alias-border-l3));color:var(--dsw-alias-brand-primary,var(--dsw-alias-label-primary));font-weight:500}
/* Row metrics come from the shipped model picker's own option
   (ui-model-selection ModelSelect.module.css .option): 34px minimum, 5px/7px padding,
   md radius, 13/18 text. This card replaces that picker, so it should measure the
   same as the thing it replaces. */
.llmm-item{display:flex;align-items:center;gap:6px;box-sizing:border-box;width:auto;min-width:100%;min-height:34px;padding:5px 7px;border:0;border-radius:var(--dsw-radius-md);background:transparent;color:inherit;font:inherit;font-size:13px;line-height:18px;text-align:left;cursor:pointer;outline:none}
.llmm-item:hover{background:var(--dsw-alias-interactive-bg-hover)}
/* Keyboard focus is the same fill the pointer gets: the fill IS the row's focus
   indication, and a default ring on top of it would double the signal. */
.llmm-item:focus-visible{outline:none;background:var(--dsw-alias-interactive-bg-hover)}
.llmm-item.llmm-active{background:var(--dsw-alias-interactive-bg-hover)}
.llmm-item.llmm-down{opacity:.55}
/* The hero row's progress bar is a hairline pinned to the row's bottom edge, so
   it adds no height to the list: the bar answers "how close is the next level"
   without making the menu taller than the shipped picker it replaces. */
.llmm-item{position:relative}
.llmm-item-bar{position:absolute;left:7px;right:7px;bottom:2px;height:2px;border-radius:1px;background:var(--dsw-alias-bg-layer-1,var(--dsw-alias-border-l3));overflow:hidden}
.llmm-item-bar-fill{display:block;height:100%;border-radius:1px;background:var(--dsw-alias-brand-primary,var(--dsw-alias-label-secondary));transition:width .2s ease}
/* The sort control is a footer, not a row: it stays put while the list scrolls. */
.llmm-menu-foot{flex:none;margin:3px 0 0;padding:4px 7px 2px;border-top:0.5px solid var(--dsw-alias-border-l3)}
.llmm-empty{margin:2px 0;padding:12px;border:1px dashed var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-lg);color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;text-align:center}
.llmm-banner{display:flex;align-items:center;gap:8px;padding:6px 10px;border:0.5px solid var(--dsw-alias-state-warn-primary);border-radius:var(--dsw-radius-md);background:color-mix(in srgb, var(--dsw-alias-state-warn-primary) 12%, transparent);color:var(--dsw-alias-state-warn-label);font-size:12px;line-height:18px}
.llmm-banner b{font-family:var(--ds-font-family-code);font-weight:500}
.llmm-banner .llmm-grow{flex:1;min-width:0}
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
      // The order the list is showing, frozen as model keys while the user works
      // in it. `null` means "follow the sort"; see `displayRows` for why toggling
      // a pin does not move a row.
      const [frozenIds, setFrozenIds] = useState(null)
      // Which rows have their detail block open, keyed the same way.
      const [openRows, setOpenRows] = useState(() => new Set())
      const [density, setDensity] = useState(readDensity)

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

      /** How the list is ordered; `default` is the shipped decision-first order. */
      const [sortMode, setSortMode] = useState('default')

      const usageRows = useMemo(
        () => rows.filter(row => row.usage !== null && row.usage !== undefined && row.usage.uses > 0),
        [rows],
      )
      // The roster is the "heroes" strip: the three models this route is actually
      // worked with, most-used first. Ranked by decaying heat rather than the
      // lifetime total, so it reflects current habits instead of the oldest
      // model winning forever.
      const roster = useMemo(
        () => usageRows.slice()
          .sort((left, right) => right.usage.heat - left.usage.heat
            || right.usage.uses - left.usage.uses
            || left.model.localeCompare(right.model))
          .slice(0, 3),
        [usageRows],
      )
      const usageTotals = useMemo(() => usageRows.reduce((sum, row) => ({
        uses: sum.uses + row.usage.uses,
        tokens: sum.tokens + row.usage.inputTokens + row.usage.outputTokens,
        seeded: sum.seeded || row.usage.seeded,
      }), { uses: 0, tokens: 0, seeded: false }), [usageRows])

      // What the one historical pass did, as the Host last reported it: absent
      // until the query service appears, then its summary or its failure reason.
      const seedState = (snap && snap.usage && snap.usage.seed) || null
      const seedLine = useMemo(() => {
        if (seedState === null) return t('seedWaiting')
        if (seedState.ok !== true) return t('seedFailed').replace('{reason}', String(seedState.reason === undefined ? '' : seedState.reason))
        if (seedState.counted > 0) {
          return t('seedDone').replace('{n}', String(seedState.counted)).replace('{s}', String(seedState.scanned))
        }
        return t('seedEmpty')
      }, [seedState, t])

      // Pinned, then favorites, then flagged rows, then the rest: the panel's
      // first screen is the part that needs a decision. The usage orderings are
      // opt-in so the default view stays the one the panel was designed around.
      /** Stable identity for one row, used to freeze and restore an order. */
      const rowKey = (row) => `${row.route}/${row.model}`

      const ordered = useMemo(() => rows.slice().sort((left, right) => {
        const usageOf = (row) => (row.usage === null || row.usage === undefined ? null : row.usage)
        if (sortMode === 'level') {
          const level = (usageOf(right)?.level ?? 0) - (usageOf(left)?.level ?? 0)
          if (level !== 0) return level
          const uses = (usageOf(right)?.uses ?? 0) - (usageOf(left)?.uses ?? 0)
          if (uses !== 0) return uses
        } else if (sortMode === 'heat') {
          const heat = (usageOf(right)?.heat ?? 0) - (usageOf(left)?.heat ?? 0)
          if (heat !== 0) return heat
        }
        const score = (row) => (row.pinned ? 0 : row.favorite ? 1 : isProblem(row.status) ? 2 : 3)
        return score(left) - score(right) || left.model.localeCompare(right.model)
      }), [rows, sortMode])

      /**
       * The rows in the order the list actually shows them.
       *
       * Toggling a pin or a favorite changes a row's state, not its position. The
       * sort puts pinned and favorite rows first, so re-sorting on every toggle
       * made the row jump to the top and took the user's scroll position with it:
       * scroll down to model 40, pin it, and you are looking somewhere else. The
       * order is therefore frozen at the first toggle and recomputed only at the
       * boundaries where the user expects the list to settle — collapsing or
       * expanding it, changing the sort, or refreshing.
       */
      const displayRows = useMemo(() => {
        if (frozenIds === null) return ordered
        const remaining = new Map(ordered.map(row => [rowKey(row), row]))
        const kept = []
        for (const id of frozenIds) {
          const row = remaining.get(id)
          if (row === undefined) continue
          kept.push(row)
          remaining.delete(id)
        }
        // Rows the freeze never saw — a model added to the route, or a first read
        // that arrived after it — keep sort order at the end rather than being
        // dropped from the list.
        return [...kept, ...ordered.filter(row => remaining.has(rowKey(row)))]
      }, [ordered, frozenIds])

      const frozen = frozenIds !== null
      // "The order on screen is no longer the order the sort would produce."
      // Without saying so, a frozen list is indistinguishable from a pin that
      // silently did nothing.
      const orderStale = frozen && (frozenIds.length !== ordered.length
        || frozenIds.some((id, index) => id !== rowKey(ordered[index])))

      const visible = expanded ? displayRows : displayRows.slice(0, 8)

      /**
       * Freeze the order the list is showing, if it is not frozen already.
       *
       * Called before a toggle, never after: the point is to capture the order
       * the user is looking at, so the row they just clicked does not move.
       */
      const freezeOrder = useCallback(() => {
        setFrozenIds(current => (current === null ? displayRows.map(rowKey) : current))
      }, [displayRows])

      /** Release the freeze, so the next render applies the current sort. */
      const releaseOrder = useCallback(() => { setFrozenIds(null) }, [])

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
        // Freeze before the change, so the row answers the click in place instead
        // of jumping to the top of a re-sorted list under the user's cursor.
        freezeOrder()
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
      }, [run, snap, apply, freezeOrder])

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
                on: () => { releaseOrder(); reload(true) },
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
              // Usage is shown only once it exists: a "0 uses" counter on a
              // profile that has never called this route is noise, and the zero
              // would read as a fault rather than as "no data yet".
              usageTotals.uses > 0
                ? h('span', { className: 'llmm-count', title: `${t('tokensLabel')}: ${usageTotals.tokens}${usageTotals.seeded ? ` · ${t('seededNote')}` : ''}` },
                  `${t('usesLabel')} `, h('b', null, String(usageTotals.uses)))
                : null,
            )
            : null,
          roster.length > 0
            ? h('div', { className: 'llmm-roster' },
              h('div', { className: 'llmm-roster-head' }, t('roster')),
              h('div', { className: 'llmm-roster-cards' }, roster.map(row => h('div', {
                key: row.model,
                className: 'llmm-hero',
                title: `${row.model} · ${row.usage.uses} ${t('usesLabel')} · ${row.usage.inputTokens + row.usage.outputTokens} ${t('tokensLabel')}`,
              },
                h('div', { className: 'llmm-hero-top' },
                  h('span', { className: `llmm-chip llmm-lv llmm-lv-${Math.min(row.usage.level, 7)}` },
                    `${t('levelShort')}.${row.usage.level}`),
                  h('span', { className: `llmm-trend llmm-trend-${row.usage.trend}`, title: t(`trend${row.usage.trend === 'up' ? 'Up' : row.usage.trend === 'down' ? 'Down' : 'Flat'}`) },
                    row.usage.trend === 'up' ? '↑' : row.usage.trend === 'down' ? '↓' : '→'),
                ),
                h('div', { className: 'llmm-hero-name' }, row.model),
                // A bar rather than a percentage: the question the card answers is
                // "how far to the next level", which is a distance, not a score.
                h('div', { className: 'llmm-bar' },
                  h('div', { className: 'llmm-bar-fill', style: { width: `${Math.round(row.usage.progress * 100)}%` } }),
                ),
                h('div', { className: 'llmm-hero-meta' },
                  `${row.usage.uses} ${t('usesLabel')} · ${t('lastUsed')} ${ageOf(row.usage.lastAt)}`,
                ),
              ))),
            )
            : null,
          usageRows.length > 0
            ? h('div', { className: 'llmm-sort llmm-sort-modes' },
              h('span', { className: 'llmm-sort-label' }, t('sortLabel')),
              ['default', 'level', 'heat'].map(mode => h('button', {
                key: mode,
                type: 'button',
                className: `llmm-sortbtn${sortMode === mode ? ' llmm-sortbtn-on' : ''}`,
                'aria-pressed': sortMode === mode,
                onClick: () => { releaseOrder(); setSortMode(mode) },
              }, t(mode === 'default' ? 'sortDefault' : mode === 'level' ? 'sortLevel' : 'sortHeat'))),
            )
            : null,
          busy && snap === null ? h('div', { className: 'llmm-hint' }, t('loading')) : null,
          error !== ''
            ? h('div', { className: 'llmm-err' }, error, ' ', h('button', { type: 'button', className: 'llmm-btn', onClick: () => reload(false) }, t('retry')))
            : null,
          // The order on screen can lag the sort while pins are being set (see
          // `displayRows`). Saying so, and saying what applies it, is what keeps
          // the freeze from reading as a broken toggle.
          orderStale ? h('div', { className: 'llmm-hint' }, t('orderPending')) : null,
          h('div', { className: 'llmm-sort llmm-density' },
            h('span', { className: 'llmm-sort-label' }, t('densityLabel')),
            DENSITIES.map(choice => h('button', {
              key: choice,
              type: 'button',
              className: `llmm-sortbtn${density === choice ? ' llmm-sortbtn-on' : ''}`,
              'aria-pressed': density === choice,
              onClick: () => { setDensity(choice); writeDensity(choice) },
            }, t(choice === 'compact' ? 'densityCompact' : 'densityComfortable'))),
          ),
          h('div', { className: `llmm-rows llmm-${density}` },
            visible.map(row => {
              const key = rowKey(row)
              const open = openRows.has(key)
              const usage = row.usage !== null && row.usage !== undefined && row.usage.uses > 0 ? row.usage : null
              const toggleOpen = () => setOpenRows((current) => {
                const next = new Set(current)
                if (next.has(key)) next.delete(key)
                else next.add(key)
                return next
              })
              // The reason leads. It used to trail `source · age`, so the ellipsis
              // in a narrow row ate exactly the part worth reading and kept the
              // part that is already encoded in the status dot and the chip.
              const why = row.reason !== ''
                ? `${row.reason} · ${sourceLabel(row.source)} · ${ageOf(row.at)}`
                : `${statusLabel(row.status)} · ${sourceLabel(row.source)}`
              /** One labelled field of the detail block; absent values render nothing. */
              const field = (label, value) => (value === null || value === undefined || value === '')
                ? null
                : h('div', { className: 'llmm-field' },
                  h('span', { className: 'llmm-field-label' }, label),
                  h('span', { className: 'llmm-field-value' }, value))
              return h(React.Fragment, { key },
                h('div', {
                  className: `llmm-row${row.hidden ? ' llmm-hidden' : ''}${density === 'comfortable' ? ' llmm-loose' : ''}`,
                },
                  h('button', {
                    type: 'button',
                    className: `llmm-chevron${open ? ' llmm-chevron-open' : ''}`,
                    'aria-expanded': open,
                    'aria-label': open ? t('collapseRow') : t('expandRow'),
                    title: open ? t('collapseRow') : t('expandRow'),
                    onClick: toggleOpen,
                  }, open ? '▾' : '▸'),
                  h('span', { className: `llmm-dot ${statusTone(row.status)}`, title: statusLabel(row.status) }),
                  // The name opens the detail block, which is what its own label
                  // would do. It stays a span rather than a second button so the
                  // row does not gain another tab stop on top of the chevron that
                  // already announces the same action and carries `aria-expanded`.
                  h('span', { className: 'llmm-name llmm-namebtn', title: row.model, onClick: toggleOpen }, row.model),
                  isProblem(row.status)
                    ? h('span', { className: 'llmm-chip' }, statusLabel(row.status))
                    : null,
                  // Proficiency, then the recent count: the level is the trophy and
                  // the 7-day number is the current form, so they are shown together
                  // but never merged into one figure.
                  usage !== null
                    ? h('span', {
                      className: `llmm-chip llmm-lv llmm-lv-${Math.min(usage.level, 7)}`,
                      title: `${t('level')} ${usage.level} · ${t('usesLabel')} ${usage.uses}`
                        + (usage.nextAt > 0 ? ` · ${t('level')} ${usage.level + 1} @ ${usage.nextAt}` : '')
                        + ` · ${t('tokensLabel')} ${usage.inputTokens}/${usage.outputTokens}`
                        + (usage.seeded ? ` · ${t('seededNote')}` : ''),
                    }, `${t('levelShort')}.${usage.level}`)
                    : null,
                  usage !== null && usage.recent7 > 0
                    ? h('span', { className: `llmm-trend llmm-trend-${usage.trend}`, title: t(`trend${usage.trend === 'up' ? 'Up' : usage.trend === 'down' ? 'Down' : 'Flat'}`) },
                      `${usage.trend === 'up' ? '↑' : usage.trend === 'down' ? '↓' : '→'}${usage.recent7}`)
                    : null,
                  // Compact keeps one line and lets the reason take the slack;
                  // comfortable gives it a line of its own below (see `.llmm-loose`).
                  density === 'compact'
                    ? h('span', { className: 'llmm-why', title: `${sourceLabel(row.source)} · ${ageOf(row.at)}` }, why)
                    : null,
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
                  density === 'comfortable'
                    ? h('div', { className: 'llmm-why llmm-why-line' }, why)
                    : null,
                ),
                // Everything the row cannot carry inline, in one place, opened on
                // demand. A hover tooltip was the alternative and it is the weaker
                // one: it needs a pointer, cannot be read on a touch screen, and
                // cannot be held open beside a second row to compare.
                open
                  ? h('div', { className: 'llmm-detail' },
                    field(t('detailStatus'), statusLabel(row.status)),
                    field(t('detailReason'), row.reason),
                    field(t('detailSource'), sourceLabel(row.source)),
                    field(t('detailChecked'), row.at > 0 ? ageOf(row.at) : null),
                    field(t('detailDirectory'), row.inDirectory === true ? t('detailListed') : t('detailMissing')),
                    usage !== null
                      ? field(t('detailLevel'), `${t('levelShort')}.${usage.level}`
                        + (usage.nextAt > 0 ? ` · ${t('detailNextLevel')} ${usage.nextAt}` : ''))
                      : null,
                    usage !== null
                      ? h('div', { className: 'llmm-field' },
                        h('span', { className: 'llmm-field-label' }, t('detailProgress')),
                        h('div', { className: 'llmm-bar llmm-bar-field' },
                          h('div', { className: 'llmm-bar-fill', style: { width: `${Math.round((usage.progress ?? 0) * 100)}%` } })))
                      : null,
                    usage !== null ? field(t('detailUses'), String(usage.uses)) : null,
                    usage !== null ? field(t('detailRecent7'), String(usage.recent7)) : null,
                    usage !== null ? field(t('detailPrior7'), String(usage.prior7)) : null,
                    usage !== null && typeof usage.heat === 'number' ? field(t('detailHeat'), usage.heat.toFixed(1)) : null,
                    usage !== null && usage.firstAt > 0 ? field(t('detailFirstUsed'), ageOf(usage.firstAt)) : null,
                    usage !== null && usage.lastAt > 0 ? field(t('detailLastUsed'), ageOf(usage.lastAt)) : null,
                    usage !== null ? field(t('detailTokens'), `${usage.inputTokens} / ${usage.outputTokens}`) : null,
                    usage !== null ? field(t('detailOrigin'), usage.seeded ? t('detailOriginSeeded') : t('detailOriginLive')) : null,
                    row.alsoOn && row.alsoOn.length > 0 ? field(t('detailAlsoOn'), row.alsoOn.join(', ')) : null,
                  )
                  : null,
              )
            }),
            rows.length === 0 && !busy ? h('div', { className: 'llmm-empty' }, t('noModels')) : null,
          ),
          displayRows.length > 8
            ? h('button', {
              type: 'button', className: 'llmm-btn',
              style: { marginTop: '6px' },
              // Collapsing or expanding is one of the boundaries that settles the
              // order, so a frozen list gets to apply its pending pins here.
              onClick: () => { releaseOrder(); setExpanded(value => !value) },
            }, expanded ? t('showFewer') : `${t('showAll')} (${displayRows.length})`)
            : null,
          // The backfill is background work, and on a fresh profile it is the only
          // thing standing between an empty roster and a real one. Saying where the
          // pass stands keeps a slow scan from looking like a dead feature — and a
          // failed pass has to be visible, or it is indistinguishable from "there
          // was nothing to count", which is exactly how this looked when it broke.
          (snap && snap.usage && snap.usage.seedEnabled === false)
            ? null
            : (pending === 'seed-usage' || usageTotals.uses === 0 || (seedState !== null && seedState.ok !== true))
              ? h('div', { className: 'llmm-hint' }, seedLine)
              : null,
          // Reachable even when nothing is counted yet — especially then, because
          // that is exactly when someone wants their existing history folded in.
          h('button', {
            type: 'button',
            className: 'llmm-btn',
            style: { marginTop: '6px' },
            title: t('scanHistoryTitle'),
            disabled: pending === 'seed-usage',
            onClick: () => { run('seed-usage', { action: 'seed-usage', route }) },
          }, t('scanHistory')),
          // Deleting the counters must be reachable without hunting for a file,
          // and it is confirmed because it cannot be undone.
          usageTotals.uses > 0
            ? h('button', {
              type: 'button',
              className: 'llmm-btn',
              style: { marginTop: '6px' },
              disabled: pending === 'reset-usage',
              onClick: () => {
                if (typeof confirm === 'function' && !confirm(t('resetUsageTitle'))) return
                run('reset-usage', { action: 'reset-usage', route })
              },
            }, t('resetUsage'))
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
      // Which order the rows inside each section take. Default leaves every
      // section in the order it was designed around; the two usage orderings are
      // opt-in, exactly like the panel's, so opening the picker does not
      // reshuffle a list the user has muscle memory for.
      const [sortMode, setSortMode] = useState('default')
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
      //
      // Rows keep their overlay flags here instead of being reduced to
      // route+model, because the sections below lift pins and favorites OUT of
      // their route group. The Host ranks only WITHIN a group and orders groups
      // by route name, so with several routes a favorite can sit below every
      // model of every alphabetically-earlier route — which is the scrolling the
      // sections exist to remove.
      const catalogue = useMemo(() => {
        if (snap !== null) {
          return snap.groups.map(group => ({
            route: group.route,
            name: group.name,
            rows: group.rows
              .filter(row => !row.hidden)
              .map(row => ({
                route: row.route,
                model: row.model,
                pinned: row.pinned === true,
                favorite: row.favorite === true,
                // Carried through so the menu can show proficiency and lift the
                // most-used models. Defaulted here rather than at each use site,
                // because the shipped-directory fallback below has no usage at all.
                usage: row.usage ?? null,
              })),
          }))
        }
        const source = state && Array.isArray(state.groups) ? state.groups : []
        // The shipped directory carries no overlay, so nothing can be lifted:
        // without the Host there is no way to know what is pinned or favorited.
        return source.map(group => ({
          route: group.id,
          name: group.name,
          rows: group.models.map(model => ({
            route: group.id, model: model.id, pinned: false, favorite: false, usage: null,
          })),
        }))
      }, [snap, state])

      /**
       * Split the catalogue into the sections the menu renders.
       *
       * Each row is placed exactly once, so nothing is offered twice: a model that
       * is both pinned and favorited appears under Pinned only, matching the Host's
       * own rank order where a pin outranks a favorite.
       *
       * @returns {{ pinned: object[], favorites: object[], groups: object[] }} the
       *   sections, in the order they are rendered.
       */
      const sections = useMemo(() => {
        const needle = query.trim().toLowerCase()
        const matches = (row) => needle === '' || row.model.toLowerCase().includes(needle)
        const pinned = []
        const favorites = []
        const byRoute = new Map()
        for (const group of catalogue) {
          const rows = group.rows.filter(matches)
          byRoute.set(group.route, rows)
          for (const row of rows) {
            if (row.pinned) pinned.push(row)
            else if (row.favorite) favorites.push(row)
          }
        }
        const lifted = new Set([...pinned, ...favorites].map(row => `${row.route}/${row.model}`))
        // Frequently used models, most-used first, so a model the user works with
        // every day rises into view without being pinned by hand. It never
        // duplicates a pin or a favorite, and it is capped: this is a shortcut to
        // the top of the list, not a second copy of the catalogue.
        const frequent = []
        const frequentSeen = new Set()
        for (const group of catalogue) {
          for (const row of group.rows) {
            // The search must narrow every section, including this one. Building
            // it from the unfiltered catalogue made 「常用」 ignore the query and
            // leak rows into a search that should not have matched them.
            if (!matches(row)) continue
            const key = `${row.route}/${row.model}`
            if (lifted.has(key) || row.usage === null || row.usage.uses <= 0) continue
            if (frequentSeen.has(key)) continue
            frequentSeen.add(key)
            frequent.push(row)
          }
        }
        frequent.sort((left, right) => right.usage.heat - left.usage.heat
          || right.usage.uses - left.usage.uses
          || left.model.localeCompare(right.model))
        const frequentTop = frequent.slice(0, FREQUENT_LIMIT)
        for (const row of frequentTop) lifted.add(`${row.route}/${row.model}`)
        const groups = catalogue
          .map(group => ({
            ...group,
            rows: (byRoute.get(group.route) ?? []).filter(row => !lifted.has(`${group.route}/${row.model}`)),
          }))
          .filter(group => group.rows.length > 0)
        return { pinned, favorites, frequent: frequentTop, groups }
      }, [catalogue, query])

      /**
       * Whether a lifted section mixes routes, and so has to name them.
       *
       * The same model id can be served by several routes, so a row taken out of
       * its group is ambiguous without its route. Naming it on every row of a
       * single-route section would be noise, so this is asked per section.
       *
       * @param {object[]} rows - the section's rows.
       * @returns {boolean} true when the rows span more than one route.
       */
      const spansRoutes = (rows) => new Set(rows.map(row => row.route)).size > 1

      /**
       * Order one section's rows by the active sort.
       *
       * Applied per section, not to the catalogue: the sections are rendered
       * separately, so ordering the catalogue first would be undone by the split.
       * `default` returns the rows untouched, which keeps both the designed order
       * and the heat ranking that gives "Most used" its meaning.
       *
       * @param {object[]} rows - the section's rows.
       * @returns {object[]} the same rows in display order.
       */
      const orderRows = (rows) => {
        if (sortMode === 'default') return rows
        const use = (row) => (row.usage === null || row.usage === undefined ? null : row.usage)
        return rows.slice().sort((left, right) => {
          if (sortMode === 'level') {
            const level = (use(right)?.level ?? 0) - (use(left)?.level ?? 0)
            if (level !== 0) return level
          } else {
            const heat = (use(right)?.heat ?? 0) - (use(left)?.heat ?? 0)
            if (heat !== 0) return heat
          }
          const uses = (use(right)?.uses ?? 0) - (use(left)?.uses ?? 0)
          return uses !== 0 ? uses : left.model.localeCompare(right.model)
        })
      }

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

      /**
       * One selectable model row.
       * @param {object} row - `{ route, model }`.
       * @param {boolean} showRoute - whether to name the route beside the model.
       * @returns {object} the row element.
       *
       * The arrangement follows the panel's row: dot, name, then the status chip
       * immediately after the name. Chips stay adjacent to what they describe
       * rather than drifting to the right edge, so a row reads the same way in both
       * surfaces.
       */
      const renderItem = (row, showRoute, hero) => {
        const overlayRow = overlay.get(`${row.route}/${row.model}`)
        const status = overlayRow ? overlayRow.status : 'unknown'
        const down = isProblem(status)
        const active = current !== null && current.provider === row.route && current.model === row.model
        const usage = row.usage
        // Only a model that has actually been used earns a chip: a row of "Lv.1"
        // badges on an untouched catalogue is noise, not information.
        const leveled = usage !== null && usage !== undefined && usage.uses > 0
        return h('button', {
          key: `${row.route}/${row.model}`,
          type: 'button',
          className: `llmm-item${active ? ' llmm-active' : ''}${down ? ' llmm-down' : ''}`,
          // The same figures the panel's row explains, so a model is described
          // once and read the same way wherever it appears.
          title: leveled
            ? `${t('level')} ${usage.level} · ${usage.uses} ${t('usesLabel')}`
              + (usage.nextAt > 0 ? ` · ${t('level')} ${usage.level + 1} @ ${usage.nextAt}` : '')
              + ` · ${usage.inputTokens}/${usage.outputTokens} ${t('tokensLabel')}`
              + (usage.seeded ? ` · ${t('seededNote')}` : '')
              + ` · ${t(`trend${usage.trend === 'up' ? 'Up' : usage.trend === 'down' ? 'Down' : 'Flat'}`)}`
            : (overlayRow && overlayRow.reason ? overlayRow.reason : statusLabel(status)),
          onClick: () => { choose(row) },
        },
          h('span', { className: `llmm-dot ${statusTone(status)}` }),
          h('span', { className: 'llmm-name' }, row.model),
          down ? h('span', { className: 'llmm-chip' }, statusLabel(status)) : null,
          // Proficiency sits next to the name, on the same line as the other
          // chips, so the menu reads the same way as the panel.
          leveled ? h('span', { className: `llmm-chip llmm-lv llmm-lv-${Math.min(usage.level, 7)}` },
            `${t('levelShort')}.${usage.level}`) : null,
          // The trailing count is what makes the arrow mean something: "busier"
          // without a number cannot be told apart from one extra request. A model
          // idle for a week keeps its level but shows no trend, because there is
          // no recent use to report either way.
          leveled && usage.recent7 > 0
            ? h('span', {
              className: `llmm-trend llmm-trend-${usage.trend}`,
              title: t(`trend${usage.trend === 'up' ? 'Up' : usage.trend === 'down' ? 'Down' : 'Flat'}`),
            }, `${usage.trend === 'up' ? '↑' : usage.trend === 'down' ? '↓' : '→'}${usage.recent7}`)
            : null,
          // The route chip takes the panel's "also on" slot: the same kind of
          // annotation, pushed to the right edge by its own margin.
          showRoute ? h('span', { className: 'llmm-chip llmm-route' }, row.route) : null,
          active ? h('span', { className: 'llmm-chip' }, t('selected')) : null,
          // The lifted section is where the day-to-day models live, so it is the
          // one place worth the space of a distance-to-next-level bar: the same
          // question the panel's hero card answers, on the surface where the
          // model is actually chosen.
          hero && leveled
            ? h('span', { className: 'llmm-item-bar', 'aria-hidden': true },
              h('span', {
                className: 'llmm-item-bar-fill',
                style: { width: `${Math.round((usage.progress ?? 0) * 100)}%` },
              }))
            : null,
        )
      }

      /**
       * One titled section of rows.
       * @param {string} key - stable React key.
       * @param {string} title - section heading.
       * @param {object[]} rows - the rows.
       * @param {boolean} [hero] - whether the rows carry progress bars.
       * @returns {object} the section element.
       */
      const renderSection = (key, title, rows, hero) => h('div', { key },
        h('div', { className: 'llmm-group' }, `${title} (${rows.length})`),
        rows.map(row => renderItem(row, spansRoutes(rows), hero === true)),
      )

      const shown = sections.pinned.length + sections.favorites.length + sections.frequent.length
        + sections.groups.reduce((total, group) => total + group.rows.length, 0)

      // Whether any model carries usage at all, which decides whether the sort
      // control is offered. Counted across the catalogue rather than the visible
      // sections so the control does not appear and vanish while typing.
      const usageSeen = catalogue.reduce(
        (total, group) => total + group.rows.filter(
          row => row.usage !== null && row.usage !== undefined && row.usage.uses > 0,
        ).length,
        0,
      )

      const triggerLabel = current === null
        ? t('pickerTitle')
        : `${current.model}${current.provider === '' ? '' : ` · ${current.provider}`}`

      // The card is built as its own value so it can be portalled to <body>
      // instead of being nested in the composer row. See the createPortal note
      // above the React require for why the ancestry, not the z-index, is the
      // thing that decides whether the sidebar can paint over this card.
      const card = h('div', {
        className: 'llmm-menu', style: position, ref: menuRef, role: 'dialog', 'aria-label': t('pickerTitle'),
      },
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
          shown === 0 ? h('div', { className: 'llmm-empty' }, t('noModels')) : null,
          // Pins and favorites first, across every route. Below, each route
          // keeps its own section with those rows removed, so a model is never
          // listed twice and the menu still offers the whole catalogue.
          sections.pinned.length > 0
            ? renderSection('llmm-pinned', t('sectionPinned'), orderRows(sections.pinned))
            : null,
          sections.favorites.length > 0
            ? renderSection('llmm-favorites', t('sectionFavorites'), orderRows(sections.favorites))
            : null,
          // Most used, between the user's explicit choices and the raw catalogue:
          // earned by use rather than declared by hand. This is the section that
          // gets the progress bars, since it is the one built from usage.
          sections.frequent.length > 0
            ? renderSection('llmm-frequent', t('sectionFrequent'), orderRows(sections.frequent), true)
            : null,
          sections.groups.map(group => renderSection(
            group.route, group.name || group.route, orderRows(group.rows),
          )),
        ),
        // The sort control earns its place only once there is usage to sort by;
        // on a fresh profile it would offer three orderings that all look alike.
        usageSeen > 0
          ? h('div', { className: 'llmm-menu-foot' },
            h('div', { className: 'llmm-sort' },
              h('span', { className: 'llmm-sort-label' }, t('sortLabel')),
              ['default', 'level', 'heat'].map(mode => h('button', {
                key: mode,
                type: 'button',
                className: `llmm-sortbtn${sortMode === mode ? ' llmm-sortbtn-on' : ''}`,
                'aria-pressed': sortMode === mode,
                onClick: () => setSortMode(mode),
              }, t(mode === 'default' ? 'sortDefault' : mode === 'level' ? 'sortLevel' : 'sortHeat'))),
            ),
          )
          : null,
        failure !== '' ? h('div', { className: 'llmm-err', style: { padding: '8px' } }, failure) : null,
      )

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
        open && position !== null ? createPortal(card, document.body) : null,
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
      // `remote` and `remote.session` are not used by name here, but they are
      // required all the same: Cordis scopes a service proxy to the *consumer's*
      // inject list, and `modelDirectories.directoryFor()` reaches
      // `this.ctx.remote.session` internally. Declaring only the services called
      // directly made that call throw "cannot get property remote.session without
      // inject", which crashed this slot entry — and with it the picker and every
      // rule in its <style>, since `Style` renders inside the same subtree. The
      // shipped picker declares the same key set for the same reason.
      inject: ['slots', 'modelDirectories', 'sessions', 'remote', 'remote.session'],
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
