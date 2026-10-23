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
        sectionHidden: 'Hidden',
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
        routeSection: 'Routes',
        detailLevels: 'Gateway levels',
        detailLevelsNone: 'none accepted',
        detailLevelsUnprobed: 'not probed',
        detailLevelsRefused: 'declared but refused',
        detailGroupHealth: 'Availability',
        detailGroupLevels: 'Reasoning level',
        detailGroupUsage: 'Usage',
        declareLevels: 'Use measured levels',
        effortName: 'Reasoning',
        effortDefault: 'Default',
        effortDefaultFull: 'Default (upstream)',
        effortSingle: 'this model offers one level only',
        effortUpstreamNote: 'DSH sends no level, so the upstream decides',
        effortMeasuredHint: 'Measured at the gateway, not declared yet',
        effortDeclareNow: 'Declare these levels',
        search: 'Search models',
        noModels: 'No models matched.',
        unavailable: 'unavailable',
        alsoOn: 'also on',
        selected: 'current',
        // The report is split by what was PROVEN, not by what was decided: a
        // switch that never reached the model must not read like one that did.
        fallbackTitleReached: 'Model switched',
        fallbackTitleElsewhere: 'Switch did not take effect',
        fallbackTitleUnreached: 'Switch attempted, turn not recovered',
        // Per-reason wording. One hardcoded sentence used to claim "exhausted
        // quota" for every cause, including causes that are not about quota.
        fallbackReasonQuota: 'quota exhausted',
        fallbackReasonRetired: 'model no longer served',
        fallbackReasonProtocol: 'model not supported on that route',
        fallbackReasonNoAdapter: 'route has no adapter',
        fallbackReasonRateLimited: 'account rate limited',
        fallbackReasonError: 'the route reported a failure',
        fallbackRanOn: 'the turn actually ran on',
        fallbackRevert: 'Switch back',
        fallbackSuppress: 'Stop switching',
        fallbackSuppressed: 'Automatic switching off',
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
        sectionHidden: '已隐藏',
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
        routeSection: '路由',
        detailLevels: '网关实测等级',
        detailLevelsNone: '全部不接受',
        detailLevelsUnprobed: '未探测',
        detailLevelsRefused: '已声明但被拒绝',
        detailGroupHealth: '可用性',
        detailGroupLevels: '推理档位',
        detailGroupUsage: '用量',
        declareLevels: '启用实测档位',
        effortName: '思考强度',
        effortDefault: '默认',
        effortDefaultFull: '默认（上游）',
        effortSingle: '该模型只有一档',
        effortUpstreamNote: 'DSH 不发送该参数，实际等级由上游决定',
        effortMeasuredHint: '网关实测支持这些档位，但还没写进配置',
        effortDeclareNow: '写进配置',
        search: '搜索模型',
        noModels: '没有匹配的模型。',
        unavailable: '不可用',
        alsoOn: '同时来自',
        selected: '当前',
        fallbackTitleReached: '已自动切换模型',
        fallbackTitleElsewhere: '切换未生效',
        fallbackTitleUnreached: '已尝试切换，本轮未恢复',
        fallbackReasonQuota: '额度已用尽',
        fallbackReasonRetired: '模型已下线',
        fallbackReasonProtocol: '该路由不支持此模型',
        fallbackReasonNoAdapter: '该路由没有可用的适配器',
        fallbackReasonRateLimited: '账号被限流',
        fallbackReasonError: '该路由报错',
        fallbackRanOn: '本轮实际使用',
        fallbackRevert: '改回',
        fallbackSuppress: '不再自动切换',
        fallbackSuppressed: '已关闭自动切换',
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

    /**
     * The full record behind one model row, as label/value pairs.
     *
     * Shared by the panel and the picker deliberately: both surfaces show the same
     * row, so they must describe it in the same words. It renders only what the
     * Host actually reported — an absent value leaves no field behind rather than
     * an empty one, so a row with no usage does not claim a level of 0.
     *
     * @param {object} props - `{ row }`, the Host's own row plus its usage.
     * @returns {object} the detail element.
     */
    function ModelDetail(props) {
      const row = props.row
      // A level sweep answers two questions at once: which levels this gateway accepts
      // at all, and whether a level DECLARED in the route config is one of them. The
      // second turns a silent runtime rejection into a visible configuration mistake.
      const levels = row.levels === null || row.levels === undefined ? undefined : row.levels
      const declared = Array.isArray(props.declared) ? props.declared : undefined
      const refusedDeclared = levels === undefined || declared === undefined
        ? []
        : declared.filter(level => (levels.rejected ?? []).some(entry => entry.level === level))
      const usage = row.usage === null || row.usage === undefined || row.usage.uses <= 0 ? null : row.usage
      const tone = statusTone(row.status)
      // One line answers "can I use it, and how do I know": the tone dot, the state,
      // what was checked, how long ago, and whether the gateway still lists it. The
      // record used to spend five rows on these, which read as a settings form rather
      // than as a description of one model.
      const summaryParts = [statusLabel(row.status)]
      if (typeof row.reason === 'string' && row.reason !== '' && row.reason.length <= 48) {
        summaryParts.push(row.reason)
      }
      summaryParts.push(sourceLabel(row.source))
      if (row.at > 0) summaryParts.push(ageOf(row.at))
      summaryParts.push(row.inDirectory === true ? t('detailListed') : t('detailMissing'))
      // Only a long reason earns its own line, and only when it is clamped: an error
      // body is the one value here that can be a paragraph.
      const longReason = typeof row.reason === 'string' && row.reason.length > 48 ? row.reason : undefined
      const compactCount = (value) => {
        if (typeof value !== 'number' || !Number.isFinite(value)) return String(value ?? 0)
        if (value >= 1e6) return `${(value / 1e6).toFixed(1)}M`
        if (value >= 1e3) return `${(value / 1e3).toFixed(1)}K`
        return String(value)
      }
      const usageStats = []
      if (usage !== null) {
        usageStats.push(`${usage.uses} ${t('usesLabel')}`)
        if (usage.recent7 > 0) usageStats.push(`${t('detailRecent7')} ${usage.recent7}`)
        if (usage.prior7 > 0) usageStats.push(`${t('detailPrior7')} ${usage.prior7}`)
        if (typeof usage.heat === 'number') usageStats.push(`${t('detailHeat')} ${usage.heat.toFixed(1)}`)
        if (usage.inputTokens > 0 || usage.outputTokens > 0) {
          usageStats.push(`${compactCount(usage.inputTokens)}/${compactCount(usage.outputTokens)} ${t('tokensLabel')}`)
        }
        if (usage.firstAt > 0) usageStats.push(`${t('detailFirstUsed')} ${ageOf(usage.firstAt)}`)
      }
      const levelsText = levels === undefined
        ? t('detailLevelsUnprobed')
        : (levels.accepted ?? []).length === 0
          ? t('detailLevelsNone')
          : (levels.accepted ?? []).join(' · ')
      const declareAction = typeof props.onDeclare === 'function'
        ? h('button', { type: 'button', className: 'llmm-inline-act', onClick: props.onDeclare }, t('declareLevels'))
        : null
      const line = (label, value, extra) => h('div', { className: 'llmm-detail-line' },
        h('span', { className: 'llmm-detail-line-label' }, label),
        h('span', { className: 'llmm-detail-line-value' }, value, extra ?? null))
      const actions = Array.isArray(props.actions) ? props.actions.filter(Boolean) : []
      return h('div', { className: `llmm-detail${props.pick === true ? ' llmm-detail-pick' : ''}` },
        h('div', { className: 'llmm-detail-summary' },
          h('span', { className: `llmm-dot ${tone}` }),
          h('span', { className: 'llmm-detail-summary-text' }, summaryParts.join(' · ')),
          actions.length === 0
            ? null
            : h('div', { className: 'llmm-detail-acts' }, actions)),
        longReason === undefined
          ? null
          : h('div', { className: 'llmm-detail-reason', title: longReason }, longReason),
        line(t('detailGroupLevels'), levelsText, declareAction),
        refusedDeclared.length === 0
          ? null
          : h('div', { className: 'llmm-detail-line llmm-detail-line-warn' },
            h('span', { className: 'llmm-detail-line-label' }, t('detailLevelsRefused')),
            h('span', { className: 'llmm-detail-line-value' }, refusedDeclared.join(' · '))),
        usage === null
          ? null
          : h('div', { className: 'llmm-detail-line' },
            h('span', { className: 'llmm-detail-line-label' }, t('detailGroupUsage')),
            h('div', { className: 'llmm-usage' },
              h('span', { className: 'llmm-usage-level' }, `${t('levelShort')}.${usage.level}`),
              h('div', { className: 'llmm-bar llmm-bar-field' },
                h('div', { className: 'llmm-bar-fill', style: { width: `${Math.round((usage.progress ?? 0) * 100)}%` } })),
              h('span', { className: 'llmm-usage-stats', title: usageStats.join(' · ') }, usageStats.join(' · ')))),
        row.alsoOn && row.alsoOn.length > 0
          ? line(t('detailAlsoOn'), row.alsoOn.join(', '))
          : null,
          props.extra ?? null,
      )
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
/* The detail is a PROFILE, not a form: one line says whether the model is usable
   and how that was established, one line carries the reasoning level, one line the
   usage. Fifteen label/value rows read as a settings page and buried the answer. */
.llmm-detail{display:flex;flex-direction:column;gap:5px;margin:0 0 6px;padding:2px 0 2px}
.llmm-detail-pick{padding-left:22px;margin:0 0 8px}
.llmm-detail-summary{display:flex;align-items:center;gap:6px;min-width:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}
.llmm-detail-acts{flex:none;display:flex;align-items:center;gap:2px;margin-left:auto}
.llmm-detail-summary-text{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.llmm-detail-reason{padding-left:14px;color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px;word-break:break-word;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.llmm-detail-line{display:flex;align-items:baseline;gap:8px;min-width:0;font-size:12px;line-height:18px}
.llmm-detail-line-label{flex:none;width:52px;color:var(--dsw-alias-label-tertiary)}
.llmm-detail-line-value{flex:1;min-width:0;color:var(--dsw-alias-label-primary);font-variant-numeric:tabular-nums;word-break:break-word}
.llmm-detail-line-warn .llmm-detail-line-value{color:var(--dsw-alias-state-warn-primary)}
.llmm-usage{display:flex;align-items:center;gap:8px;flex:1;min-width:0}
.llmm-usage-level{flex:none;color:var(--dsw-alias-label-primary);font-variant-numeric:tabular-nums}
.llmm-usage-stats{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}
/* Actions are ghost TEXT, not bordered pills: at this weight they used to read as
   the primary content of the row. Same grammar as the panel's icon actions. */
/* A progress bar is a hint, not a headline: 3px, and the fill stays neutral so it
   cannot out-shout the values beside it. */
.llmm-bar{height:3px;border-radius:2px;background:var(--dsw-alias-bg-layer-2,var(--dsw-alias-border-l3));overflow:hidden}
.llmm-bar-fill{height:100%;border-radius:2px;background:var(--dsw-alias-label-tertiary);transition:width .2s ease}
.llmm-bar-field{flex:1;min-width:56px;max-width:110px;align-self:center}
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
.llmm-effort{flex:none;max-width:140px;padding-left:2px}
.llmm-effort-static{cursor:default}
.llmm-effort-static .llmm-trigger-label{color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary))}
.llmm-effort-sep{flex:none;color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary))}
.llmm-effort-menu{position:fixed;z-index:1100;display:flex;flex-direction:column;padding:4px;border-radius:var(--dsw-radius-lg);box-shadow:var(--dsw-elevation-prominent,0 0 0 .5px var(--dsw-alias-border-l1),0 3px 8px rgba(0,0,0,.04));color:var(--dsw-alias-label-primary);font-size:13px}
.llmm-effort-item{display:flex;align-items:center;justify-content:space-between;gap:10px;width:100%;padding:6px 8px;border:0;border-radius:var(--dsw-radius-sm);background:transparent;color:inherit;font:inherit;font-size:13px;line-height:18px;text-align:left;cursor:pointer}
.llmm-effort-item:hover{background:var(--dsw-alias-interactive-bg-hover)}
.llmm-effort-item:focus-visible{outline:none;box-shadow:0 0 0 2px var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary))}
.llmm-routes{display:flex;flex-direction:column;gap:1px;padding:2px 4px 6px}
.llmm-routes-label{padding:2px 6px;color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary));font-size:11px;font-weight:500}
.llmm-route-choice{display:flex;align-items:center;gap:6px;width:100%;padding:4px 6px;border:0;border-radius:var(--dsw-radius-sm);background:transparent;color:inherit;font:inherit;font-size:12px;line-height:16px;text-align:left;cursor:pointer}
.llmm-route-choice:hover{background:var(--dsw-alias-interactive-bg-hover)}
.llmm-route-choice:focus-visible{outline:none;box-shadow:0 0 0 2px var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary))}
.llmm-route-on{color:var(--dsw-alias-label-primary);font-weight:600}
.llmm-route-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.llmm-effort-on{font-weight:600}
.llmm-effort-mark{flex:none;width:12px}
.llmm-effort-note{padding:2px 8px 6px;color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary));font-size:12px;line-height:16px}
.llmm-chip-effort{margin-left:2px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}
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
/* The row is a wrapper now: it holds two controls, the selection target and the
   disclosure. Selection keeps the shipped option's own box, so the row still
   measures like the picker it replaces. */
.llmm-item-select{display:flex;align-items:center;gap:6px;flex:1;min-width:0;padding:0;border:0;background:transparent;color:inherit;font:inherit;font-size:13px;line-height:18px;text-align:left;cursor:pointer;outline:none}
/* Keyboard focus is indicated by the row fill, as the design system does for its
   menu items — the fill has to come from the row, because the focused control is
   inside it. */
.llmm-item:focus-within{background:var(--dsw-alias-interactive-bg-hover)}
.llmm-item-select:focus-visible{outline:none}
/* The action block. The chevron is one glyph; these carry labels, because four
   icon-only actions in a 240px menu is a guessing game. */
/* The block belongs to the row above it, so it is indented to the name. */
.llmm-inline-act{margin-left:8px;padding:0;border:0;background:transparent;color:var(--dsw-alias-state-business-primary);font:inherit;font-size:12px;line-height:18px;text-decoration:underline;text-underline-offset:2px;cursor:pointer}
.llmm-inline-act:hover{background:transparent;color:var(--dsw-alias-state-business-primary)}
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
/* The banner is a bounded block, not a one-line strip. It reports a switch and a
   reason, and the reason used to be the provider's raw error text inlined in full
   — up to 400 characters, which is several wrapped lines and made the banner
   taller than the conversation around it. */
.llmm-banner{display:flex;align-items:flex-start;gap:8px;padding:6px 10px;border:0.5px solid var(--dsw-alias-state-warn-primary);border-radius:var(--dsw-radius-md);background:color-mix(in srgb, var(--dsw-alias-state-warn-primary) 12%, transparent);color:var(--dsw-alias-state-warn-label);font-size:12px;line-height:18px}
.llmm-banner b{font-weight:500}
.llmm-banner-mark{flex:none;line-height:18px}
/* The flexible middle owns the wrapping, and is allowed to shrink: the actions
   beside it never shrink, so a long model id cannot push them out of view. */
.llmm-banner-body{flex:1;min-width:0;display:flex;flex-direction:column;gap:1px}
.llmm-banner-line{display:flex;align-items:baseline;gap:6px;flex-wrap:wrap;min-width:0}
.llmm-banner-move{font-family:var(--ds-font-family-code);font-size:12px;line-height:18px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
/* One line, with the whole message on hover: the banner states the cause, the
   provider's exact wording stays available without taking over the composer. */
.llmm-banner-why{color:var(--dsw-alias-state-warn-label);opacity:.85;font-size:11px;line-height:16px;display:-webkit-box;-webkit-line-clamp:1;-webkit-box-orient:vertical;overflow:hidden;min-width:0}
.llmm-banner-acts{flex:none;display:flex;align-items:center;gap:4px;flex-wrap:wrap;justify-content:flex-end}
.llmm-banner-off{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px;white-space:nowrap}
.llmm-btn-quiet{padding:1px 6px;font-size:11px;line-height:16px}
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
      const rowKey = (row) => row.route + '/' + row.model

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
                open ? h(ModelDetail, { row }) : null,
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
      // Which rows have their action/record block open, plus the one action in
      // flight, so a click answers immediately and cannot be double-fired.
      const [detailKeys, setDetailKeys] = useState(() => new Set())
      const [pending, setPending] = useState('')
      // The level menu is a separate surface from the model list on purpose: it is
      // reached without opening the list, which is the whole point of putting it on
      // the trigger. Two open surfaces would fight over the same dismiss handler.
      const [levelOpen, setLevelOpen] = useState(false)
      const [levelPos, setLevelPos] = useState(null)
      const levelRef = useRef(null)
      const levelMenuRef = useRef(null)
      // A tooltip channel of this component's own. The panel has one, but each is
      // scoped to its own subtree, and the actions need the label the icon cannot
      // spell — the same reason the panel's icon buttons carry one.
      const [tip, setTip] = useState(null)
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
      // Section membership as it was when this menu opened, captured at the first
      // pin or favorite. Pinning otherwise lifts a row out of its route group into
      // a section at the top — a bigger jump than the panel's, and the one thing
      // this menu must not do while the user is choosing from it. Only
      // pinned/favorite are frozen: hidden stays live, because hiding a row is
      // meant to make it leave.
      const [frozenFlags, setFrozenFlags] = useState(null)
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

      // A row's identity is the MODEL when the Host supplies the model-first view,
      // and route/model when it does not. Every membership set in this component
      // (pins, favorites, frequent, frozen flags, detail expansion) keys off this, so
      // an un-restarted Host keeps working instead of silently losing state.
      const rowKey = (row) => (row.key !== undefined ? row.key : row.route + '/' + row.model)
      const overlay = useMemo(() => {
        const map = new Map()
        if (snap === null) return map
        for (const group of snap.groups) {
          for (const row of group.rows) {
            map.set(rowKey(row), row)
            // A model-first row is keyed by model id; keeping that spelling too means the
            // two key schemes cannot silently disagree about a row again.
            if (!map.has(row.model)) map.set(row.model, row)
          }
        }
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

      /**
       * Build the model-first catalogue from the shipped directory alone.
       *
       * Used only when the Host cannot answer. Two routes serving one model id become
       * one row, same as the Host's own view, so the degraded path is not the one place
       * where a wrapped route lists the same model twice.
       *
       * @param {object|null} catalog - the shipped directory snapshot.
       * @returns {object[]} groups keyed by the model's first route, in catalog order.
       */
      const modelFirstFromCatalog = (catalog) => {
        const groups = catalog && Array.isArray(catalog.groups) ? catalog.groups : []
        const families = new Map()
        const seen = new Map()
        for (const group of groups) {
          for (const model of Array.isArray(group.models) ? group.models : []) {
            const known = seen.get(model.id)
            if (known !== undefined) {
              known.alsoOn.push(group.name || group.id)
              continue
            }
            const family = families.get(group.id) ?? { route: group.id, name: group.name, rows: [] }
            const row = {
              key: model.id, route: group.id, model: model.id, routes: [],
              alsoOn: [], pinned: false, favorite: false, hidden: false,
              status: 'unknown', usage: null,
            }
            families.set(group.id, family)
            family.rows.push(row)
            seen.set(model.id, row)
          }
        }
        return [...families.values()]
      }

      const catalogue = useMemo(() => {
        // The Host now reports one entry per MODEL with its routes as attributes, so
        // render what the user is choosing rather than what DSH uses to reach it. Two
        // routes serving one model id collapse here without this half knowing why they
        // exist: a vision twin today, an alias or a future wrapper tomorrow.
        //
        // Grouping still needs a provider label. The FAMILY is the model's first route
        // in the Host's own order (routes arrive sorted), which is stable across
        // refreshes and needs no naming rule; the route a click selects is `primary`,
        // which follows usage. They can differ, and the row's `also on` chip says so.
        if (snap !== null && Array.isArray(snap.models) && snap.models.length > 0) {
          const families = new Map()
          for (const entry of snap.models) {
            const routes = Array.isArray(entry.routes) ? entry.routes : []
            if (routes.length === 0) continue
            // The family is the route the model is actually used through, not the first
            // alphabetically: `deepseek-flash` is served by `deepseek-account` and
            // `deepseek-official`, and alphabetical order filed it under the former while
            // every call went through the latter — a heading that contradicted the row.
            const family = routes.find(route => route.route === entry.primary) ?? routes[0]
            const group = families.get(family.route) ?? { route: family.route, name: family.name, rows: [] }
            group.rows.push({
              ...entry,
              key: entry.model,
              route: entry.primary,
              alsoOn: routes
                .filter(route => route.route !== entry.primary)
                .map(route => route.name || route.route),
              usage: entry.usage ?? null,
            })
            families.set(family.route, group)
          }
          return [...families.values()]
        }
        const live = snap !== null
          ? snap.groups.map(group => ({
            route: group.route,
            name: group.name,
            // The whole Host row is carried, not a reduced projection: the action
            // block shows the same record the panel does, and that record is the
            // Host's own status/reason/source/timestamps. Hidden rows are kept
            // here and filtered by the sections, so the menu can also offer them
            // back — filtering them out at this point is what made hiding a
            // one-way door.
            rows: group.rows.map(row => ({
              ...row,
              route: row.route,
              model: row.model,
              pinned: row.pinned === true,
              favorite: row.favorite === true,
              hidden: row.hidden === true,
              status: row.status ?? 'unknown',
              usage: row.usage ?? null,
            })),
          }))
          // The shipped directory carries no overlay, so nothing can be lifted:
          // without the Host there is no way to know what is pinned or favorited.
          //
          // It is still grouped model-first, because the degraded path must not be the
          // one place where a model served by two routes appears twice — two routes are
          // exactly how a wrapper route (a vision twin) shows up, and that is likelier
          // than usual when the Host is unreachable.
          : modelFirstFromCatalog(state)
        return live
      }, [snap, state])

      // The catalog the shipped directory already carries has `reasoning` on every
      // model, and it is the ONLY place this half can see it: the Host snapshot
      // describes health and usage, not capability. Indexing it once per catalog
      // generation keeps the row render and the trigger from searching 75 entries
      // per keystroke.
      const reasoningIndex = useMemo(() => {
        const index = new Map()
        if (state && Array.isArray(state.groups)) {
          for (const group of state.groups) {
            const models = Array.isArray(group.models) ? group.models : []
            for (const entry of models) {
              if (entry && entry.id !== undefined && entry.reasoning !== undefined) {
                index.set(`${group.id}/${entry.id}`, entry.reasoning)
              }
            }
          }
        }
        return index
      }, [state])

      /** What this model lets the user pick, if anything. */
      const reasoningOf = useCallback(
        (route, model) => reasoningIndex.get(`${route}/${model}`),
        [reasoningIndex],
      )

      const levelName = (reasoning, id) => {
        const found = reasoning === undefined ? undefined : reasoning.efforts.find(level => level.id === id)
        return found === undefined || found.name === '' ? id : found.name
      }

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
        const hidden = []
        const byRoute = new Map()
        // Which section a row BELONGS to is frozen; what the row itself reports
        // is not. Rewriting the row's own flags would have frozen the pin icon
        // too, so the button could never light up and the menu would claim the
        // click did nothing.
        const flagsOf = (row) => (frozenFlags === null
          ? { pinned: row.pinned, favorite: row.favorite }
          : frozenFlags.get(rowKey(row)) ?? { pinned: row.pinned, favorite: row.favorite })
        for (const group of catalogue) {
          // Hidden models leave the menu — that is what hiding means — but they
          // are collected rather than dropped, so the menu can offer them back.
          const rows = group.rows.filter(row => !row.hidden && matches(row))
          byRoute.set(group.route, rows)
          for (const row of rows) {
            const flags = flagsOf(row)
            if (flags.pinned) pinned.push(row)
            else if (flags.favorite) favorites.push(row)
          }
          for (const row of group.rows) if (row.hidden && matches(row)) hidden.push(row)
        }
        const lifted = new Set([...pinned, ...favorites].map(row => rowKey(row)))
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
            const key = rowKey(row)
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
        for (const row of frequentTop) lifted.add(rowKey(row))
        const groups = catalogue
          .map(group => ({
            ...group,
            rows: (byRoute.get(group.route) ?? []).filter(row => !lifted.has(rowKey(row))),
          }))
          .filter(group => group.rows.length > 0)
        return { pinned, favorites, frequent: frequentTop, groups, hidden }
      }, [catalogue, query, frozenFlags])

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
      // The route chip says "this row is reachable another way", so it is about the
      // row, not about the section: under model-first nearly every section mixes
      // several routes and would have stamped the chip on every single row.
      const spansRoutes = (rows) => rows.some(row => (row.alsoOn ?? []).length > 0)

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

      /**
       * Freeze section membership at its current state, once.
       *
       * Called before a pin or a favorite changes which section a row belongs to.
       * Only pinned/favorite are captured: `hidden` stays live, so hiding a row
       * still removes it — that is the whole point of hiding, and an unhidden row
       * returns to the section its frozen flags place it in.
       */
      const freezeSections = useCallback(() => {
        setFrozenFlags((current) => {
          if (current !== null) return current
          const flags = new Map()
          for (const group of catalogue) {
            for (const row of group.rows) {
              flags.set(rowKey(row), { pinned: row.pinned, favorite: row.favorite })
            }
          }
          return flags
        })
      }, [catalogue])

      /**
       * Flip one overlay list for one row, folding the Host's snapshot back in.
       *
       * The returned snapshot is applied rather than re-fetched: this menu reads
       * its own snapshot once on mount, so without folding the answer back the row
       * would keep showing the state the click just replaced.
       *
       * @param {object} row - the row.
       * @param {string} list - 'pins' | 'favorites' | 'hidden'.
       * @param {boolean} on - the desired membership.
       * @returns {Promise<void>} fulfillment once the UI updated.
       */
      const mutate = useCallback(async (row, list, on) => {
        const key = `${list}:${rowKey(row)}`
        if (list !== 'hidden') freezeSections()
        setPending(key)
        // A model reads as pinned when ANY of its routes is pinned, so turning the
        // flag off has to clear every route. Clearing only the primary would leave the
        // row reporting exactly the state the click removed.
        const targets = on || !Array.isArray(row.routes) ? [row.route] : row.routes.map(entry => entry.route)
        try {
          let data
          for (const route of targets) {
            data = await callHost({ action: 'toggle', route, model: row.model, list, on })
          }
          if (data !== undefined && data.snapshot !== undefined) setSnap(data.snapshot)
        } catch { /* leave the menu usable; the row keeps the state it had */ } finally {
          setPending('')
        }
      }, [freezeSections])

      /**
       * Deep-probe one model, folding the result back in.
       *
       * The probe outlives the menu — its result lands in the persisted health
       * record, so it is still there next time even if this menu closes first.
       *
       * @param {object} row - the row.
       * @returns {Promise<void>} fulfillment once the probe answered.
       */
      const probe = useCallback(async (row) => {
        const key = `probe:${row.route}/${row.model}`
        setPending(key)
        try {
          const data = await callHost({ action: 'probe', route: row.route, model: row.model })
          if (data.snapshot !== undefined) setSnap(data.snapshot)
          // The probe now declares what it measured, and a declaration changes the
          // catalog — the model's reasoning metadata, which the snapshot does not
          // carry (the row's `reasoning` comes from the directory). Reload it so the
          // level segment turns switchable in the same gesture, not on next mount.
          if (data.value?.declared !== undefined) await load()
        } catch { /* leave the menu usable */ } finally {
          setPending('')
        }
      }, [load])

      const choose = useCallback(async (row) => {
        setFailure('')
        // Picking the model you are already on must not silently move you off a route
        // you chose deliberately (the vision twin, say): when the current provider is
        // one of this model's routes, keep it.
        const provider = Array.isArray(row.routes) && current !== null && current.model === row.model
          && row.routes.some(entry => entry.route === current.provider)
          ? current.provider
          : row.route
        // `retainedEffort` is the level NAME ("High"), not its id ("high"): the shipped
        // directory spells it for display. Passing it straight through made the adapter
        // reject the selection with `does not support reasoning effort "High"`, so the
        // name is mapped back through this model's own declaration and dropped when it
        // cannot be resolved — an unknown level must never be sent as if it were valid.
        const retainedEffort = current !== null && current.provider === provider && current.model === row.model
          && state !== null && state !== undefined && state.retainedEffort !== undefined
          ? (reasoningOf(provider, row.model)?.efforts ?? []).find(
            level => level.name === state.retainedEffort || level.id === state.retainedEffort,
          )?.id
          : undefined
        const reuseEffort = retainedEffort
        const result = await select({
          provider,
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
        callHost({ action: 'use', route: provider, model: row.model }).catch(() => {})
        setOpen(false)
      }, [select, current, state])

      // Switching which route serves the SAME model. The current level is carried over
      // only when that route declares it: levels are a per-model capability, and a
      // wrapper route may advertise a different set — carrying an unsupported one would
      // fail the selection instead of falling back to the route's own default.
      const chooseRoute = useCallback(async (row, route) => {
        setFailure('')
        const carried = current !== null && current.model === row.model ? current.reasoningEffort : undefined
        const reasoning = reasoningOf(route, row.model)
        const supported = carried !== undefined && reasoning !== undefined
          && reasoning.efforts.some(level => level.id === carried)
        const result = await select({
          provider: route,
          model: row.model,
          ...(supported ? { reasoningEffort: carried } : {}),
        })
        if (result && result.ok === false) {
          const error = result.error
          setFailure(error && error.message ? error.message : JSON.stringify(error))
        }
      }, [select, current, reasoningOf])

      // Measurement unlocks nothing on its own: the harness validates a level against
      // the model's DECLARATION, so a level the gateway accepts but the config omits is
      // offered by nobody. This writes the probe's answer through the Host, which uses
      // the same settings path the settings UI does, then re-reads both sources so the
      // trigger becomes adjustable without a page reload.
      const declare = useCallback(async (row) => {
        setFailure('')
        try {
          await callHost({ action: 'declareLevels', route: row.route, model: row.model })
        } catch (error) {
          setFailure(error instanceof Error ? error.message : String(error))
          return
        }
        load()
        callHost({ action: 'snapshot' })
          .then((data) => { if (data !== null && data.value !== undefined) setSnap(data.value) })
          .catch(() => { /* the declaration itself succeeded; a stale list is recoverable */ })
      }, [load])

      /**
       * The levels the probe measured for one model, if any.
       *
       * Measurement and declaration are different facts, and the picker needs both: a
       * model whose gateway was measured but whose config declares nothing cannot be
       * switched, and pretending otherwise would offer choices that always fail.
       *
       * @param {string} route - provider route id.
       * @param {string} model - model id.
       * @returns {string[]} accepted levels, empty when nothing was measured.
       */
      const measuredOf = (route, model) => {
        const entries = snap !== null && Array.isArray(snap.models) ? snap.models : []
        const entry = entries.find(candidate => candidate.model === model
          && (candidate.routes ?? []).some(routeEntry => routeEntry.route === route))
        const accepted = entry?.levels?.accepted
        return Array.isArray(accepted) ? accepted : []
      }

      // What the trigger's second segment says, and whether it is a control.
      //
      // Three states, all always visible: adjustable (the declared levels), a single
      // declared level (read-only), and no declaration at all — where the honest
      // answer is "the upstream decides", not "off". Omitting the field does not
      // mean "no thinking": on this gateway it measured identical to `max`.
      const currentReasoning = current === null
        ? undefined
        : reasoningOf(current.provider, current.model)
      const selectedEffort = current === null ? undefined : current.reasoningEffort
      const effectiveEffort = selectedEffort ?? currentReasoning?.defaultEffort
      const currentMeasured = current === null ? [] : measuredOf(current.provider, current.model)
      // Four states, not three: a model the probe measured but the config never
      // declared is its own case — it CANNOT be switched, but the reason is actionable,
      // so the segment stays clickable and the menu explains what to do.
      const effortState = currentReasoning !== undefined
        ? (currentReasoning.efforts.length > 1 ? 'adjustable' : 'single')
        : (currentMeasured.length > 0 ? 'measured' : 'undeclared')
      const effortLabel = current === null
        ? ''
        : currentReasoning === undefined || effectiveEffort === undefined
          ? t('effortDefault')
          : levelName(currentReasoning, effectiveEffort)
      const effortTitle = effortState === 'adjustable'
        ? `${t('effortName')} · ${effortLabel}`
        : effortState === 'single'
          ? t('effortSingle')
          : effortState === 'measured'
            ? `${t('effortMeasuredHint')} · ${currentMeasured.join(' · ')}`
            : t('effortUpstreamNote')
      const levelChoices = useMemo(() => {
        if (currentReasoning === undefined) return []
        return [
          // Offered only when the model names no default: when it does, that level is
          // the provider's own answer and a separate "default" row would be a second
          // spelling of it.
          ...currentReasoning.defaultEffort === undefined
            ? [{ key: '__default__', effort: undefined, label: t('effortDefaultFull') }]
            : [],
          ...currentReasoning.efforts.map(level => ({
            key: level.id,
            effort: level.id,
            label: level.name === '' ? level.id : level.name,
            description: level.description,
          })),
        ]
      }, [currentReasoning, t])

      const placeLevel = useCallback(() => {
        const node = levelRef.current
        if (node === null) return
        const rect = node.getBoundingClientRect()
        const width = 176
        const left = Math.min(Math.max(8, rect.left), Math.max(8, window.innerWidth - width - 8))
        setLevelPos({
          left: `${left}px`,
          width: `${width}px`,
          bottom: `${Math.max(8, window.innerHeight - rect.top + 8)}px`,
        })
      }, [])

      useEffect(() => {
        if (!levelOpen) return undefined
        placeLevel()
        const onDown = (event) => {
          if (levelMenuRef.current !== null && levelMenuRef.current.contains(event.target)) return
          if (levelRef.current !== null && levelRef.current.contains(event.target)) return
          setLevelOpen(false)
        }
        const onKey = (event) => { if (event.key === 'Escape') setLevelOpen(false) }
        document.addEventListener('mousedown', onDown, true)
        document.addEventListener('keydown', onKey)
        window.addEventListener('resize', placeLevel)
        return () => {
          document.removeEventListener('mousedown', onDown, true)
          document.removeEventListener('keydown', onKey)
          window.removeEventListener('resize', placeLevel)
        }
      }, [levelOpen, placeLevel])

      // Changing a level is a selection in its own right — it names the same model
      // the session already has and only moves the effort — so it goes through the
      // same verb the row click uses. An undefined effort is "no explicit level",
      // which is what the Host reads as the provider's own default.
      const applyEffort = useCallback(async (effort) => {
        if (current === null) return
        setFailure('')
        const result = await select({
          provider: current.provider,
          model: current.model,
          ...(effort === undefined ? {} : { reasoningEffort: effort }),
        })
        if (result && result.ok === false) {
          const error = result.error
          setFailure(error && error.message ? error.message : JSON.stringify(error))
          return
        }
        setLevelOpen(false)
      }, [select, current])

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
      /**
       * Whether a row has measured levels its declaration does not carry.
       * @param {object} row - the row.
       * @returns {boolean} true when the probe learned something the config lacks.
       */
      const needsDeclaration = (row) => {
        const measured = row.levels === null || row.levels === undefined ? [] : (row.levels.accepted ?? [])
        if (measured.length === 0) return false
        const declared = (reasoningOf(row.route, row.model)?.efforts ?? []).map(level => level.id)
        return declared.length === 0 || measured.some(level => !declared.includes(level))
      }

      const renderItem = (row, showRoute, hero) => {
        // The Host's own status wins: a model-first row carries it, and looking it up
        // in the route-keyed overlay map would MISS (that map is keyed `route/model`,
        // while a model-first row is keyed by model id) and silently fall back to
        // "unknown" — which is exactly how every status dot went grey at once.
        const overlayRow = overlay.get(rowKey(row)) ?? overlay.get(`${row.route}/${row.model}`)
        const status = row.status !== undefined ? row.status : (overlayRow ? overlayRow.status : 'unknown')
        const down = isProblem(status)
        const active = current !== null && current.provider === row.route && current.model === row.model
        const usage = row.usage
        // Only a model that has actually been used earns a chip: a row of "Lv.1"
        // badges on an untouched catalogue is noise, not information.
        const leveled = usage !== null && usage !== undefined && usage.uses > 0
        const key = rowKey(row)
        const expanded = detailKeys.has(key)
        // Only an adjustable model carries a chip. Stamping "default" on the other
        // seventy-odd rows would turn a capability signal into noise, and the one
        // thing worth seeing while scrolling is which rows can be tuned at all.
        const rowReasoning = reasoningOf(row.route, row.model)
        const rowEffort = rowReasoning === undefined || rowReasoning.efforts.length < 2
          ? undefined
          : levelName(rowReasoning, row.reasoningEffort ?? rowReasoning.defaultEffort)
        // Icon-only, like the panel's row actions: four labels of different lengths
        // cannot line up in a row, and the label a text button spelled out is what the
        // hover tooltip is for.
        const act = (icon, label, active, on, pendingKey, danger) => h(IconButton, {
          icon,
          label,
          active,
          danger: danger === true,
          filled: active,
          pending: pending === pendingKey,
          tip: tipChannel,
          on,
        })
          const toggleDetail = () => setDetailKeys((currentKeys) => {
          const next = new Set(currentKeys)
          if (next.has(key)) next.delete(key)
          else next.add(key)
          return next
        })
        // The row is no longer the button. A button cannot contain buttons: the
        // action block needs four of them, and nesting them inside the selection
        // target would be invalid markup whose clicks also selected the model.
        // Selection therefore keeps its own button and the row wraps both.
        return h(React.Fragment, { key },
          h('div', {
            className: `llmm-item${active ? ' llmm-active' : ''}${down ? ' llmm-down' : ''}`,
          },
            h('button', {
              type: 'button',
              className: 'llmm-item-select',
              // The same figures the panel's row explains, so a model is described
              // once and read the same way wherever it appears.
              title: leveled
                ? `${t('level')} ${usage.level} · ${usage.uses} ${t('usesLabel')}`
                  + (usage.nextAt > 0 ? ` · ${t('level')} ${usage.level + 1} @ ${usage.nextAt}` : '')
                  + ` · ${usage.inputTokens}/${usage.outputTokens} ${t('tokensLabel')}`
                  + (usage.seeded ? ` · ${t('seededNote')}` : '')
                  + ` · ${t(`trend${usage.trend === 'up' ? 'Up' : usage.trend === 'down' ? 'Down' : 'Flat'}`)}`
                : (row.reason ? row.reason : statusLabel(status)),
              onClick: () => { choose(row) },
            },
              h('span', { className: `llmm-dot ${statusTone(status)}` }),
              h('span', { className: 'llmm-name' }, row.model),
              down ? h('span', { className: 'llmm-chip' }, statusLabel(status)) : null,
              // Proficiency sits next to the name, on the same line as the other
              // chips, so the menu reads the same way as the panel.
              leveled ? h('span', { className: `llmm-chip llmm-lv llmm-lv-${Math.min(usage.level, 7)}` },
                `${t('levelShort')}.${usage.level}`) : null,
              rowEffort === undefined
                ? null
                : h('span', { className: 'llmm-chip llmm-chip-effort', title: t('effortName') }, rowEffort),
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
            ),
            h('button', {
              type: 'button',
              className: `llmm-chevron${expanded ? ' llmm-chevron-open' : ''}`,
              'aria-expanded': expanded,
              'aria-label': expanded ? t('collapseRow') : t('expandRow'),
              title: expanded ? t('collapseRow') : t('expandRow'),
              onClick: toggleDetail,
            }, expanded ? '▾' : '▸'),
          ),
          // The actions and the record, on demand. The menu's width belongs to the
          // model name, so neither can be always-on; a chevron costs one glyph and
          // keeps every action reachable by pointer, keyboard and touch.
          expanded
            ? h(ModelDetail, {
              row,
              pick: true,
              declared: (reasoningOf(row.route, row.model)?.efforts ?? []).map(level => level.id),
              // Offered only where the probe measured a level the declaration lacks: the
              // action belongs beside the fact it acts on.
              onDeclare: needsDeclaration(row) ? () => { declare(row) } : undefined,
              actions: [
                act('pin', row.pinned ? t('unpin') : t('pin'), row.pinned,
                  () => mutate(row, 'pins', !row.pinned), `pins:${key}`),
                act('star', row.favorite ? t('unfavorite') : t('favorite'), row.favorite,
                  () => mutate(row, 'favorites', !row.favorite), `favorites:${key}`),
                act(row.hidden ? 'eyeOff' : 'eye', row.hidden ? t('unhide') : t('hide'), row.hidden,
                  () => mutate(row, 'hidden', !row.hidden), `hidden:${key}`),
                act('pulse', t('probe'), false, () => probe(row), `probe:${key}`, isProblem(status)),
              ],
              // Which route serves this model, when more than one does: a wrapper route is
              // a property of the model, not a second model.
              extra: Array.isArray(row.routes) && row.routes.length > 1
                ? h('div', { className: 'llmm-routes' },
                  h('div', { className: 'llmm-routes-label' }, t('routeSection')),
                  row.routes.map(route => {
                    const on = current !== null && current.provider === route.route
                      && current.model === row.model
                    return h('button', {
                      key: route.route,
                      type: 'button',
                      className: `llmm-route-choice${on ? ' llmm-route-on' : ''}`,
                      'aria-pressed': on,
                      title: route.reason === '' ? statusLabel(route.status) : route.reason,
                      onClick: () => { chooseRoute(row, route.route) },
                    },
                      h('span', { className: 'llmm-route-name' }, route.name || route.route),
                      on
                        ? h('span', { className: 'llmm-chip' }, t('selected'))
                        : h('span', { className: 'llmm-chip' }, statusLabel(route.status)),
                    )
                  }),
                )
                : null,
            })
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
        // Per row, not per section: a section that mixes a shared model with
        // single-route ones must not stamp a route label on the ones that have no
        // other route to name. `spansRoutes` stays as the fallback for a catalog that
        // reports no per-row routes at all.
        rows.map(row => renderItem(
          row,
          Array.isArray(row.alsoOn) ? row.alsoOn.length > 0 : spansRoutes(rows),
          hero === true,
        )),
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
          // Hidden models last, and offered back. Without this section hiding from
          // the picker would be a one-way door: the row leaves the menu and the
          // only way to undo it is the settings page.
          sections.hidden.length > 0
            ? renderSection('llmm-hidden', t('sectionHidden'), orderRows(sections.hidden))
            : null,
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
                // Reordering is what the user asked for here, so a pending pin is
                // allowed to settle at the same time.
                onClick: () => { setFrozenFlags(null); setSortMode(mode) },
              }, t(mode === 'default' ? 'sortDefault' : mode === 'level' ? 'sortLevel' : 'sortHeat'))),
            ),
          )
          : null,
        failure !== '' ? h('div', { className: 'llmm-err', style: { padding: '8px' } }, failure) : null,
      )

      // The level menu's rows are the model's own declaration, never a fixed list:
      // one gateway accepts low/high/max and rejects medium, another accepts all
      // seven, and a model that always thinks rejects "off" outright. Rendering a
      // hardcoded set would offer choices that fail on submit.
      const levelMenu = h('div', {
        ref: levelMenuRef,
        className: 'llmm-effort-menu',
        style: levelPos,
        role: 'menu',
        'aria-label': t('effortName'),
      },
        // A measured-but-undeclared model gets the explanation and the one action that
        // unlocks it, never a list of levels that would be rejected on click.
        effortState === 'measured'
          ? h('div', { className: 'llmm-effort-note' }, t('effortMeasuredHint'))
          : null,
        effortState === 'measured'
          ? h('button', {
            type: 'button',
            className: 'llmm-effort-item llmm-effort-declare',
            onClick: () => {
              if (current !== null) declare({ route: current.provider, model: current.model })
              setLevelOpen(false)
            },
          }, t('effortDeclareNow'), h('span', { className: 'llmm-effort-mark', 'aria-hidden': true }, '↵'))
          : null,
        effortState === 'measured'
          ? null
          : levelChoices.length === 0
            ? h('div', { className: 'llmm-effort-note' }, effortTitle)
            : null,
        levelChoices.map(choice => {
          const on = choice.effort === undefined
            ? effectiveEffort === undefined
            : choice.effort === effectiveEffort
          return h('button', {
            key: choice.key,
            type: 'button',
            role: 'menuitemradio',
            'aria-checked': on,
            className: `llmm-effort-item${on ? ' llmm-effort-on' : ''}`,
            title: choice.description === undefined ? choice.label : choice.description,
            onClick: () => { applyEffort(choice.effort) },
          },
            h('span', null, choice.label),
            h('span', { className: 'llmm-effort-mark', 'aria-hidden': true }, on ? '✓' : ''),
          )
        }),
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
            // Reopening is the boundary that settles the order: the pins set while
            // the last menu was open are applied here, so the freeze never holds a
            // stale section layout longer than the menu it belongs to.
            onClick: () => {
              setFrozenFlags(null)
              setDetailKeys((currentKeys) => (currentKeys.size === 0 ? currentKeys : new Set()))
              // Two portals anchored to the same composer cannot both own the
              // document-level dismiss, so opening one closes the other.
              setLevelOpen(false)
              setOpen(value => !value)
            },
          },
            h('span', { className: 'llmm-trigger-label' }, triggerLabel),
            h('span', { 'aria-hidden': true }, '▾'),
          ),
          // The second segment answers "what am I getting?" even where it cannot be
          // changed: an omitted level is NOT "no thinking" — on this gateway it
          // measured identical to `max` — so hiding the row would leave the user
          // reading a default as if it were off.
          current === null ? null : h('button', {
            ref: levelRef,
            type: 'button',
            className: `llmm-trigger llmm-effort${effortState === 'adjustable' || effortState === 'measured' ? '' : ' llmm-effort-static'}`,
            'aria-disabled': locked || (effortState !== 'adjustable' && effortState !== 'measured'),
            'aria-haspopup': effortState === 'adjustable' || effortState === 'measured' ? 'menu' : undefined,
            title: effortTitle,
            onClick: () => {
              // A measured-but-undeclared model opens the menu too: the levels exist,
              // the declaration does not, and the menu is where that is explained and
              // fixed. Only a model the probe never touched stays a plain label.
              if (locked || (effortState !== 'adjustable' && effortState !== 'measured')) return
              setOpen(false)
              setLevelOpen(value => !value)
            },
          },
            h('span', { className: 'llmm-effort-sep', 'aria-hidden': true }, '·'),
            h('span', { className: 'llmm-trigger-label' }, effortLabel),
            effortState === 'adjustable' || effortState === 'measured'
              ? h('span', { 'aria-hidden': true }, '▾')
              : null,
          ),
        ),
        open && position !== null ? createPortal(card, document.body) : null,
        levelOpen && levelPos !== null ? createPortal(levelMenu, document.body) : null,
        // The label an icon cannot spell. Portalled for the same reason the card is:
        // an ancestor with overflow would clip a fixed child out of position.
        tip !== null
          ? createPortal(h('div', {
            className: 'llmm-tip',
            style: { left: `${tip.x}px`, top: `${tip.y}px` },
            role: 'tooltip',
          }, tip.text), document.body)
          : null,
      )
    }

    /**
     * The composer banner that reports an automatic model switch.
     *
     * It reports what was proven. The Host records a switch as pending when it is
     * decided and promotes it only once a committed assistant message names the
     * model that actually answered, so this never claims a switch that did not
     * reach the model — which is exactly what the previous version did.
     *
     * @param {object} props - slot props, including the session id when supplied.
     * @returns {object|null} the banner, or nothing when no switch happened.
     */
    function FallbackBanner(props) {
      const sessionId = typeof props?.sessionId === 'string' ? props.sessionId : ''
      const [note, setNote] = useState(null)
      const [autoSwitch, setAutoSwitch] = useState(true)
      const [hiddenAt, setHiddenAt] = useState(0)
      const [busy, setBusy] = useState('')

      useEffect(() => {
        if (sessionId === '') return undefined
        let alive = true
        const tick = () => {
          callHost({ action: 'fallbackLog', sessionId })
            .then((data) => {
              if (!alive) return
              setNote(data.value ?? null)
              setAutoSwitch(data.autoSwitch !== false)
            })
            .catch(() => { /* the banner is advisory only */ })
        }
        tick()
        const timer = setInterval(tick, 5000)
        return () => { alive = false; clearInterval(timer) }
      }, [sessionId])

      if (note === null || note === undefined) return null
      if (note.at <= hiddenAt) return null
      if (Date.now() - note.at > 5 * 60 * 1000) return null

      const label = (endpoint) => (endpoint ? `${endpoint.route}/${endpoint.model}` : '')
      const from = label(note.from)
      const to = label(note.to)
      const ran = label(note.ran)
      // Which of the three things actually happened, in the user's terms.
      const outcome = note.outcome === 'reached' ? 'reached'
        : note.outcome === 'unreached' ? 'unreached' : 'elsewhere'
      const title = t(outcome === 'reached' ? 'fallbackTitleReached'
        : outcome === 'unreached' ? 'fallbackTitleUnreached' : 'fallbackTitleElsewhere')
      const reasonKey = `fallbackReason${note.reason === 'quota' ? 'Quota'
        : note.reason === 'retired' ? 'Retired'
          : note.reason === 'protocol' ? 'Protocol'
            : note.reason === 'no_adapter' ? 'NoAdapter'
              : note.reason === 'rate_limited' ? 'RateLimited' : 'Error'}`
      const reason = t(reasonKey)
      const run = async (action, body) => {
        setBusy(action)
        try { await callHost({ action, sessionId, ...body }) } catch { /* advisory */ } finally { setBusy('') }
      }
      return h(React.Fragment, null,
        h(Style),
        h('div', { className: 'llmm-root llmm-banner', role: 'status' },
          h('span', { className: 'llmm-banner-mark', 'aria-hidden': true }, outcome === 'reached' ? '⇄' : '⚠'),
          h('div', { className: 'llmm-banner-body' },
            h('div', { className: 'llmm-banner-line' },
              h('b', null, title),
              from !== '' ? h('code', { className: 'llmm-banner-move' }, from, ' → ', to) : null,
            ),
            // The raw provider text is one clamped line with the whole message on
            // hover. It used to be inlined in full — up to 400 characters — which
            // is what made this banner taller than the conversation it sat in.
            h('div', { className: 'llmm-banner-why', title: note.detail ?? '' },
              outcome === 'reached'
                ? reason
                : `${reason}${ran !== '' ? ` · ${t('fallbackRanOn')} ${ran}` : ''}`,
            ),
          ),
          h('div', { className: 'llmm-banner-acts' },
            // Undo, only once something was actually switched: it moves the
            // Session's model back, so it is offered when that is meaningful.
            outcome === 'reached' && note.from
              ? h('button', {
                type: 'button',
                className: 'llmm-btn llmm-btn-quiet',
                disabled: busy !== '',
                onClick: () => run('fallbackRevert', { route: note.from.route, model: note.from.model }),
              }, t('fallbackRevert'))
              : null,
            autoSwitch
              ? h('button', {
                type: 'button',
                className: 'llmm-btn llmm-btn-quiet',
                disabled: busy !== '',
                onClick: () => { setAutoSwitch(false); run('fallbackSuppress') },
              }, t('fallbackSuppress'))
              : h('span', { className: 'llmm-banner-off' }, t('fallbackSuppressed')),
            h('button', { type: 'button', className: 'llmm-btn llmm-btn-quiet', onClick: () => setHiddenAt(note.at) }, t('dismiss')),
          ),
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
        // `selector.mode` cannot arrive as a second argument: the client runtime hands
        // a plugin only its module URL (`__DSH_BOOT__` entries are { id, url, rev }),
        // never the Loader row config, so `apply(ctx, config)` receives undefined in
        // the real app and `native` stayed inert. The Host is asked instead — and
        // because that answer is asynchronous, the picker registers immediately (the
        // managed default) and RELEASES the seat only if the answer is `native`. The
        // normal path therefore gains no latency and no flash; the inspection path
        // pays a few milliseconds and flashes the shipped picker once.
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
        //
        // Only in `managed` mode: `native` exists precisely to hand the seat back
        // to the shipped picker, and registering here regardless is what made that
        // setting inert.
        const releasePicker = ctx.slots.inject('conversation.input.model', () => {
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
        // `native` means hand the seat back to the shipped picker.
        //
        // The cheap action is asked first and the snapshot is the fallback, because
        // the two halves can legitimately be out of step: the browser always loads
        // this client half fresh, while a Host that has not been restarted since a
        // plugin upgrade still serves the older action set. Keying on a single new
        // action would make the mode look inert until a restart — which is exactly
        // how this feature spent its first two attempts failing.
        const readSelectorMode = async () => {
          try {
            return (await callHost({ action: 'selectorMode' })).value
          } catch { /* older Host: fall through to the snapshot */ }
          try {
            return (await callHost({ action: 'snapshot' })).value
          } catch {
            return null
          }
        }
        // A null answer must NOT release it: an unreachable Host would then silently
        // drop a control the user is looking at, which is worse than the managed
        // picker they expected.
        readSelectorMode()
          .then((value) => {
            // Guarded: if this platform's `slots.inject` ever stops returning a
            // disposer, a throw here would be swallowed below and the mode would look
            // inert again. Failing loudly in the console beats failing silently.
            if (value !== null && value.selectorMode === 'native') {
              if (typeof releasePicker === 'function') releasePicker()
              else console.warn('llm-manage: slots.inject returned no disposer; selector.mode = native cannot be honoured')
            }
          })
          .catch(() => { /* keep the picker */ })
      },
    }
  },
})
