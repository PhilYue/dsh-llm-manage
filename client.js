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
        pullDir: 'Re-pull the model directory',
        pullWorking: 'Re-pulling…',
        pullDone: 'Re-pulled: {detail} models',
        pullMissing: '; retired {names}',
        pullFailed: 'Re-pull failed: {message}',
        pullStamp: 'directory {route} {count} · {age}',
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
        tabFrequent: 'Frequent',
        tabAll: 'All',
        frequentEmpty: 'Nothing pinned, starred or used yet — those models land in this tab.',
        railProbe: 'Measure levels',
        panelClose: 'Close',
        managerOpen: 'Manage models',
        managerTitle: 'Model manager',
        managerSearch: 'Search models',
        managerFilter: 'Filter',
        managerEmpty: 'Nothing matches this filter.',
        managerLoadFailed: 'Could not read the model list.',
        hostStale: 'This host still runs an older copy of the plugin — restart `dsh web` to load its newer actions.',
        managerSaved: 'Saved',
        managerSaving: 'Saving…',
        managerSaveFailed: 'Saving failed.',
        managerWriteFailed: 'That change did not land.',
        managerProbeFailed: 'The probe did not finish.',
        managerDirty: 'Unsaved changes',
        managerSave: 'Save',
        managerCancel: 'Cancel',
        managerDiscardTitle: 'Discard changes?',
        managerDiscardBody: 'The fallback order and the proficiency edits have not been saved.',
        managerDiscard: 'Discard',
        managerKeep: 'Keep editing',
        tabCatalog: 'Catalog',
        tabFailover: 'Failover',
        tabRecords: 'Probes',
        tabSwitches: 'Switches',
        removeModel: 'Remove from the catalog',
        removeModelDone: 'Removed — the gateway still serves it, and it can be restored below.',
        restoreModelDone: 'Restored.',
        removedTitle: 'Removed from the catalog',
        removedListed: 'still served upstream',
        removedGone: 'gone from the gateway',
        removedRestore: 'Restore',
        switchesModels: 'Models that triggered a switch',
        switchesClear: 'Clear',
        switchesEmpty: 'No automatic switch has happened yet.',
        switchesRecent: 'Recent switches',
        switchesNote: 'Only proven switches are recorded: which model failed, what it moved to, and whether that ended the failure. A history that could not be cleared would only describe a machine that no longer exists.',
        switchesReached: 'took over',
        switchesUnreached: 'did not take over',
        switchesElsewhere: 'answered elsewhere',
        switchesSessions: 'sessions',
        switchOpenSession: 'Open this session',
        outcomeReached: 'took over',
        outcomeUnreached: 'did not take over',
        outcomeElsewhere: 'ran elsewhere',
        filterAll: 'All',
        filterProblem: 'Needs attention',
        filterPinned: 'Pinned',
        filterStarred: 'Starred',
        filterHidden: 'Hidden',
        probeAll: 'Probe all',
        levelManual: 'Proficiency',
        levelAuto: 'Auto',
        fallbackToggle: 'Switch model automatically when a route fails',
        fallbackEmpty: 'No fallback candidates yet — add one below.',
        fallbackPick: 'Choose a model',
        fallbackAdd: 'Add',
        fallbackUp: 'Move up',
        fallbackDown: 'Move down',
        fallbackRemove: 'Remove',
        fallbackNote1: 'Only models the catalog still resolves and that are not hidden enter the chain.',
        fallbackNote2: 'The model that just failed is skipped even when it appears later in the chain.',
        fallbackNote3: 'A switch is applied at most once per turn, so one failure cannot cascade.',
        fallbackNote4: 'A switch takes effect on the next message: the turn that failed is not retried on the new model.',
        checkChain: 'Check the chain',
        chainMissing: 'not in the catalog',
        chainHidden: 'hidden',
        chainUnprobed: 'not checked yet',
        recordsEmpty: 'No probes recorded yet.',
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
        teamLabel: 'Enable agent teamwork',
        teamInfo: 'About agent teamwork',
        teamDescription: 'Coordinate work and progress across agents with a shared task board for better results on complex tasks, with correspondingly higher token costs.',
        teamFailed: 'Could not confirm the agent teamwork setting was saved. Try again: {message}',
        teamDisableTitle: 'Disable agent teamwork?',
        teamDisableText: 'Disabling agent teamwork during a conversation stops the use of shared task tools and team coordination instructions.',
        teamDisableWarning: 'Disabling it may affect cache reuse, increase subsequent token usage and costs, and affect collaboration on the current task.',
        teamDisableCancel: 'Cancel',
        teamDisableConfirm: 'Disable',
        search: 'Search models',
        noModels: 'No models matched.',
        unavailable: 'unavailable',
        alsoOn: 'also on',
        selected: 'current',
        // The report is split by what was PROVEN, not by what was decided: a
        // switch that never reached the model must not read like one that did.
        fallbackTitleReached: 'Model switched',
        fallbackTitleElsewhere: 'Switch did not take effect',
        fallbackTitleUnreached: 'Switched, but this turn did not come back',
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
        fallbackContinue: 'Continue',
        fallbackContinueFilled: 'Filled into the draft — edit it or send it',
        fallbackTitleContinued: 'Model switched and the work was picked back up',
        fallbackTitleEffort: 'Reasoning level repaired and the work was picked back up',
        switchesContinued: 'continued',
        switchesNotContinued: 'not continued',
        switchesLegacy: 'recorded before this version could resolve it',
        switchesSteps: '{count} steps',
        switchesUndo: 'Undo',
        switchesCleared: 'History cleared.',
        fallbackReasonUnauthorized: 'this account is not authorized for the model',
        fallbackReasonNetwork: 'the route could not be reached',
        bannerHandedOver: 'handed over to {model}',
        // The reason is the whole value of this line: "cannot be called" sent people
        // looking for a network problem when the account had simply run out of free
        // usage. It comes from the same status vocabulary as every other row.
        defaultModelWarn: 'New conversations start on {model} — {why}.',
        defaultModelScope: 'This conversation keeps its own model.',
        defaultModelFix: 'Start them on {model}',
        defaultModelFixed: 'The default model was updated.',
    policyTitle: 'Automatic handling',
    policyRetry: 'Retry a transient failure before moving',
    policyRetryNote: 'A single 5xx is not a broken model; the harness retries those with its own backoff.',
    policyContinue: 'Pick the work back up after a switch',
    policyContinueNote: 'Queues one new turn, telling it to check the actual state first.',
    policySwitches: 'Model switches per request',
    policySwitchesNote: 'How many model switches one request may spend before it stops and asks.',
    policyContinuations: 'Continuations per request',
    policyContinuationsNote: 'How many new turns a repair may queue. Zero switches the model and stops there.',
    policyIdle: 'Wait before giving up (ms)',
    policyIdleNote: 'How long a continuation waits for the failing turn to finish closing.',
    policyBad: 'Use a whole number in the allowed range.',
    policySaved: 'Saved',
        continuePrompt: 'Continue from where the previous answer stopped.',
        fallbackSuppress: 'Stop switching',
        fallbackSuppressed: 'Automatic switching off',
        dismiss: 'Dismiss',
        diagnostics: 'Diagnostics',
        sourceDirectory: 'gateway directory',
        sourceProbe: 'deep probe',
        sourcePassive: 'observed request',
        never: 'never checked',
        ctlIdle: 'Commands',
        ctlKey: '\u2318K',
        ctlDraft: 'Draft',
        ctlChars: 'chars',
        ctlAttach: 'files',
        ctlQueued: 'queued',
        ctlRunning: 'Running',
        ctlWaiting: 'waiting for you',
        ctlAdjudicating: 'reading command',
        ctlClaimed: 'command claimed',
        ctlSubmitting: 'running command',
        ctlSending: 'sending',
        ctlEffort: 'Level',
        ctlAuto: 'Auto',
        ctlPaletteOpen: 'Open the command palette',
        paletteTitle: 'Commands',
        paletteSend: 'Send',
        paletteClear: 'Clear the draft',
        paletteCopyId: 'Copy the session id',
        paletteCopied: 'copied',
        paletteProbe: 'Probe the current model',
        paletteProbed: 'probe finished',
        paletteProbeFailed: 'the route did not answer',
        paletteSwitchFailed: 'that level was refused',
        paletteSearch: 'Type to filter commands',
        paletteEmpty: 'No command matches',
        paletteWorking: 'working',
        paletteFailed: 'the action failed',
        paletteNoLevels: 'no level measured yet \u2014 probe the model first',
        paletteCurrent: 'current',
        paletteGroupSession: 'This session',
        paletteGroupModel: 'Model',
        paletteGroupDiag: 'Diagnostics',
        paletteGroupManage: 'Manage',
        paletteSync: 'Refresh the gateway catalogue',
        paletteSyncDone: 'catalogue refreshed',
        paletteProbeAll: 'Probe every model on this route',
        paletteProbeAllSent: 'probes queued \u2014 see the probe log',
        paletteFailoverLog: 'Recent failovers',
        paletteProbeRecords: 'Probe log',
      },
      zh: {
        panelTitle: '模型管理',
        panelHint: '置顶与收藏的模型会在选择器顶部单独成组；已隐藏的模型不会出现在选择器里。',
        loading: '读取模型中…',
        retry: '重试',
        refresh: '重新检查网关',
        pullDir: '重新拉取模型目录',
        pullWorking: '正在重新拉取…',
        pullDone: '已重新拉取：{detail} 个模型',
        pullMissing: '；下线了 {names}',
        pullFailed: '重新拉取失败：{message}',
        pullStamp: '目录 {route} {count} · {age}',
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
        tabFrequent: '常用',
        tabAll: '全部',
        frequentEmpty: '还没有置顶、收藏或用过的模型——它们会出现在这里。',
        railProbe: '探测档位',
        panelClose: '关闭',
        managerOpen: '模型管理',
        managerTitle: '模型管理',
        managerSearch: '搜索模型',
        managerFilter: '筛选',
        managerEmpty: '没有符合筛选条件的模型。',
        managerLoadFailed: '无法读取模型列表。',
        hostStale: '宿主仍在运行旧版插件：重启 dsh web 之后这些面板才有数据。',
        managerSaved: '已保存',
        managerSaving: '保存中…',
        managerSaveFailed: '保存失败。',
        managerWriteFailed: '这项改动没有落地。',
        managerProbeFailed: '探活没有完成。',
        managerDirty: '有未保存的修改',
        managerSave: '保存',
        managerCancel: '取消',
        managerDiscardTitle: '放弃修改？',
        managerDiscardBody: '后备顺序与熟练度的修改还没有保存。',
        managerDiscard: '放弃',
        managerKeep: '继续编辑',
        tabCatalog: '模型目录',
        tabFailover: '故障切换',
        tabRecords: '探活记录',
        tabSwitches: '切换记录',
        removeModel: '从目录移除',
        removeModelDone: '已从目录移除——网关仍在提供，可在下方恢复。',
        restoreModelDone: '已恢复。',
        removedTitle: '已从目录移除',
        removedListed: '网关仍在提供',
        removedGone: '网关已不再提供',
        removedRestore: '恢复',
        switchesModels: '触发过切换的模型',
        switchesClear: '清空',
        switchesEmpty: '还没有发生过自动切换。',
        switchesRecent: '最近切换',
        switchesNote: '只记录已经证实的切换：哪个模型失败、换到了哪个、是否真的恢复了。不能清空的记录只能描述一台已经不存在的机器。',
        switchesReached: '已接管',
        switchesUnreached: '未接管',
        switchesElsewhere: '落到别处',
        switchesSessions: '个会话',
        switchOpenSession: '打开这个会话',
        outcomeReached: '已接管',
        outcomeUnreached: '未接管',
        outcomeElsewhere: '落到别处',
        filterAll: '全部',
        filterProblem: '需要处理',
        filterPinned: '置顶',
        filterStarred: '收藏',
        filterHidden: '已隐藏',
        probeAll: '全部探活',
        levelManual: '熟练度',
        levelAuto: '自动',
        fallbackToggle: '路由失败时自动切换模型',
        fallbackEmpty: '还没有后备候选模型——在下方添加。',
        fallbackPick: '选择模型',
        fallbackAdd: '添加',
        fallbackUp: '上移',
        fallbackDown: '下移',
        fallbackRemove: '移除',
        fallbackNote1: '只有目录仍能解析、且未被隐藏的模型会进入候选链。',
        fallbackNote2: '刚失败的模型即使排在链里也会被跳过。',
        fallbackNote3: '同一轮最多切换一次，一次失败不会连环切换。',
        fallbackNote4: '切换从下一条消息生效：失败的那一轮不会在新模型上重试。',
        checkChain: '检查恢复链路',
        chainMissing: '不在目录里',
        chainHidden: '已隐藏',
        chainUnprobed: '尚未检查',
        recordsEmpty: '还没有探活记录。',
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
        teamLabel: '启用智能体团队协作',
        teamInfo: '关于智能体团队协作',
        teamDescription: '通过共享任务板协调多个智能体的分工与进度，复杂任务表现更佳，token 开销也相应更高。',
        teamFailed: '无法确认智能体团队协作设置已保存，请重试：{message}',
        teamDisableTitle: '确认停用智能体团队协作？',
        teamDisableText: '对话过程中停用智能体团队协作，将停止共享任务工具和团队协调指令。',
        teamDisableWarning: '停用后可能影响缓存复用、增加后续 token 用量与开销，并影响当前任务的协作效果。',
        teamDisableCancel: '取消',
        teamDisableConfirm: '确认停用',
        search: '搜索模型',
        noModels: '没有匹配的模型。',
        unavailable: '不可用',
        alsoOn: '同时来自',
        selected: '当前',
        fallbackTitleReached: '已自动切换模型',
        fallbackTitleElsewhere: '切换未生效',
        fallbackTitleUnreached: '已换模型，这一轮没接上',
        fallbackReasonQuota: '额度已用尽',
        fallbackReasonRetired: '模型已下线',
        fallbackReasonProtocol: '该路由不支持此模型',
        fallbackReasonNoAdapter: '该路由没有可用的适配器',
        fallbackReasonRateLimited: '账号被限流',
        fallbackReasonError: '该路由报错',
        fallbackRanOn: '本轮实际使用',
        fallbackRevert: '改回',
        fallbackContinue: '接续',
        fallbackContinueFilled: '已填入草稿，可编辑后发送',
        fallbackTitleContinued: '已自动切换并继续执行',
        fallbackTitleEffort: '已修正推理档位并继续执行',
        switchesContinued: '已继续',
        switchesNotContinued: '未继续',
        switchesLegacy: '早期记录无法回写结果',
        switchesSteps: '{count} 步',
        switchesUndo: '撤销',
        switchesCleared: '记录已清空。',
        fallbackReasonUnauthorized: '这个账号没有该模型的权限',
        fallbackReasonNetwork: '路由连不上',
        bannerHandedOver: '已由 {model} 接管',
        defaultModelWarn: '新会话默认使用 {model}：{why}。',
        defaultModelScope: '当前会话不受影响。',
        defaultModelFix: '改为 {model}',
        defaultModelFixed: '默认模型已更新。',
    policyTitle: '自动处理',
    policyRetry: '瞬时失败先重试，再考虑换模型',
    policyRetryNote: '一次 5xx 不代表模型坏了，平台会按自己的退避重试。',
    policyContinue: '换模型后自动继续执行',
    policyContinueNote: '会排一轮新消息，要求先核对实际状态再继续。',
    policySwitches: '每个请求最多切换几次模型',
    policySwitchesNote: '一次请求最多花掉几次自动切换，用完就停下等人。',
    policyContinuations: '每个请求最多续跑几次',
    policyContinuationsNote: '一次修复最多排几轮新消息；填 0 表示换完模型就停。',
    policyIdle: '放弃前等待多久（毫秒）',
    policyIdleNote: '续跑等上一轮收尾的最长时间。',
    policyBad: '请填允许范围内的整数。',
    policySaved: '已保存',
        continuePrompt: '请从中断处继续上一条回答。',
        fallbackSuppress: '不再自动切换',
        fallbackSuppressed: '已关闭自动切换',
        dismiss: '知道了',
        diagnostics: '诊断',
        sourceDirectory: '网关目录',
        sourceProbe: '深度探活',
        sourcePassive: '真实请求',
        never: '未检查',
        ctlIdle: '\u6307\u4ee4',
        ctlKey: '\u2318K',
        ctlDraft: '\u8349\u7a3f',
        ctlChars: '\u5b57',
        ctlAttach: '\u4e2a\u9644\u4ef6',
        ctlQueued: '\u6761\u6392\u961f',
        ctlRunning: '\u8fd0\u884c\u4e2d',
        ctlWaiting: '\u7b49\u5f85\u4f60\u7684\u786e\u8ba4',
        ctlAdjudicating: '\u89e3\u6790\u547d\u4ee4',
        ctlClaimed: '\u547d\u4ee4\u5df2\u9501\u5b9a',
        ctlSubmitting: '\u6267\u884c\u547d\u4ee4',
        ctlSending: '\u53d1\u9001\u4e2d',
        ctlEffort: '\u6863\u4f4d',
        ctlAuto: '\u81ea\u52a8',
        ctlPaletteOpen: '\u6253\u5f00\u6307\u4ee4\u9762\u677f',
        paletteTitle: '\u6307\u4ee4',
        paletteSend: '\u53d1\u9001',
        paletteClear: '\u6e05\u7a7a\u8349\u7a3f',
        paletteCopyId: '\u590d\u5236\u4f1a\u8bdd ID',
        paletteCopied: '\u5df2\u590d\u5236',
        paletteProbe: '\u63a2\u6d3b\u5f53\u524d\u6a21\u578b',
        paletteProbed: '\u63a2\u6d3b\u5b8c\u6210',
        paletteProbeFailed: '\u8def\u7531\u6ca1\u6709\u5e94\u7b54',
        paletteSwitchFailed: '\u8be5\u6863\u4f4d\u88ab\u62d2\u7edd',
        paletteSearch: '\u8f93\u5165\u4ee5\u7b5b\u9009\u6307\u4ee4',
        paletteEmpty: '\u6ca1\u6709\u5339\u914d\u7684\u6307\u4ee4',
        paletteWorking: '\u6267\u884c\u4e2d',
        paletteFailed: '\u64cd\u4f5c\u5931\u8d25',
        paletteNoLevels: '\u5c1a\u672a\u6d4b\u51fa\u6863\u4f4d\uff0c\u5148\u63a2\u6d3b\u8be5\u6a21\u578b',
        paletteCurrent: '\u5f53\u524d',
        paletteGroupSession: '\u672c\u4f1a\u8bdd',
        paletteGroupModel: '\u6a21\u578b',
        paletteGroupDiag: '\u8bca\u65ad',
        paletteGroupManage: '\u7ba1\u7406',
        paletteSync: '\u91cd\u62c9\u7f51\u5173\u76ee\u5f55',
        paletteSyncDone: '\u76ee\u5f55\u5df2\u66f4\u65b0',
        paletteProbeAll: '\u63a2\u6d3b\u672c\u8def\u7531\u5168\u90e8\u6a21\u578b',
        paletteProbeAllSent: '\u5df2\u63d0\u4ea4\u63a2\u6d4b\uff0c\u7ed3\u679c\u89c1\u63a2\u6d3b\u8bb0\u5f55',
        paletteFailoverLog: '\u6700\u8fd1\u7684\u6545\u969c\u5207\u6362',
        paletteProbeRecords: '\u63a2\u6d3b\u8bb0\u5f55',
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
      // Two failures that used to be filed under 'failed' even though neither is
      // answered by trying another model: one needs a person to authorize the account,
      // the other never reached the route at all.
      unauthorized: { tone: 'bad', en: 'needs authorization', zh: '需要授权' },
      network: { tone: 'warn', en: 'route unreachable', zh: '路由不可达' },
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
      return status === 'retired' || status === 'protocol' || status === 'quota'
        || status === 'unauthorized' || status === 'network' || status === 'error'
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
      // A bin reads as "take this away" without needing the word.
      trash: ['M3.1 4.5h9.8', 'M6.5 4.5V3.1h3v1.4', 'M4.6 4.5l.55 8.4h5.7l.55-8.4', 'M6.9 6.7v4.1', 'M9.1 6.7v4.1'],
      // Two rails with handles: the manager is where the policy is set, not the model.
      sliders: ['M2.4 5.2h11.2', 'M2.4 10.8h11.2', 'M5.6 3.2v4', 'M10.4 8.8v4'],
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
        className: `llmm-ibtn${props.active === true ? ' llmm-on' : ''}${props.danger === true ? ' llmm-danger' : ''}${busy ? ' llmm-busy' : ''}${typeof props.className === 'string' && props.className !== '' ? ` ${props.className}` : ''}`,
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
/* The label this plugin contributes inside the SHIPPED picker. It inherits the
   owner's typography (it renders inside the owner's row), so only spacing, the
   level chip and the badge are styled here — anything else would fight the
   surrounding control. */
.llmm-dlg-mask{position:fixed;inset:0;z-index:1000;display:flex;align-items:center;justify-content:center;padding:24px;background:var(--dsw-alias-bg-mask-1);backdrop-filter:var(--dsw-mask-blur)}
.llmm-dlg{position:relative;display:flex;flex-direction:column;width:min(960px,100%);height:min(720px,100%);overflow:hidden;border:0.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-panel);background:var(--dsw-alias-bg-layer-2);box-shadow:var(--dsw-elevation-prominent);outline:none}
.llmm-dlg-small{width:min(420px,100%);height:auto}
.llmm-dlg-ask{z-index:1100}
.llmm-dlg-head{flex:none;display:flex;align-items:center;gap:8px;padding:11px 14px;border-bottom:0.5px solid var(--dsw-alias-border-l3)}
.llmm-dlg-title{font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary)}
.llmm-dlg-count{font-size:11px;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}
.llmm-dlg-gap{flex:1}
.llmm-dlg-tabs{flex:none;display:flex;gap:14px;padding:0 14px;border-bottom:0.5px solid var(--dsw-alias-border-l3)}
.llmm-dlg-body{flex:1;min-height:0;overflow:auto;padding:10px 14px}
.llmm-dlg-copy{margin:0;font-size:12px;line-height:19px;color:var(--dsw-alias-label-secondary)}
.llmm-dlg-foot{flex:none;display:flex;align-items:center;gap:8px;padding:9px 14px;border-top:0.5px solid var(--dsw-alias-border-l3)}
.llmm-dlg-note{font-size:11px;color:var(--dsw-alias-state-success-primary)}
.llmm-dlg-stale{flex:none;margin:0 20px 8px;padding:6px 10px;border-radius:var(--dsw-radius-md,8px);background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary);font-size:11px;line-height:16px}
.llmm-dlg-err{font-size:11px;color:var(--dsw-alias-state-error-primary)}
.llmm-dlg-dirty{margin-right:auto;font-size:11px;color:var(--dsw-alias-label-secondary)}
/* Every dialog button carries its own chrome. A bare <button> inherits the
   browser's grey face, which reads as disabled next to our outlined controls. */
.llmm-dlg-btn{box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;gap:4px;height:28px;padding:0 11px;margin-left:auto;border:0.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;line-height:18px;cursor:pointer;transition:background .12s ease,border-color .12s ease,color .12s ease}
.llmm-dlg-btn:hover:not([disabled]){background:var(--dsw-alias-interactive-bg-hover);border-color:var(--dsw-alias-border-l4)}
.llmm-dlg-btn[disabled]{opacity:.4;cursor:default}
.llmm-dlg-btn + .llmm-dlg-btn{margin-left:0}
.llmm-dlg-btn-primary{border-color:transparent;background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground);font-weight:500}
.llmm-dlg-btn-primary:hover:not([disabled]){border-color:transparent;background:var(--dsw-alias-button-primary-hover)}
.llmm-dlg-btn-danger{color:var(--dsw-alias-state-error-primary)}
.llmm-mg-toolbar{display:flex;align-items:center;gap:8px;padding:2px 0 10px}
.llmm-mg-dirs{display:flex;flex-wrap:wrap;gap:4px 12px;padding:0 0 8px;font-size:11px;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}
.llmm-mg-dir{white-space:nowrap}
.llmm-mg-search{flex:1;min-width:0;height:28px;padding:0 9px;border:0.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:12px}
.llmm-mg-search::placeholder{color:var(--dsw-alias-label-tertiary)}
.llmm-mg-filter{height:28px;padding:0 6px;border:0.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px}
.llmm-mg-empty{padding:18px;border:1px dashed var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-lg);color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;text-align:center}
.llmm-mg-item{border-bottom:0.5px solid var(--dsw-alias-border-l1)}
.llmm-mg-row{display:flex;align-items:center;gap:7px;min-height:32px;padding:3px 0}
.llmm-mg-main{flex:1;min-width:0;display:flex;align-items:center;gap:7px;padding:0;border:0;background:transparent;color:inherit;font:inherit;text-align:left;cursor:pointer}
.llmm-mg-name{flex:none;max-width:56%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px;color:var(--dsw-alias-label-primary)}
.llmm-mg-sub{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px;color:var(--dsw-alias-label-tertiary)}
.llmm-mg-when{flex:none;font-size:11px;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}
.llmm-mg-acts{flex:none;display:flex;align-items:center;gap:2px}
/* The proficiency ladder and the removal control share one line: both are edits to
   this row's membership, and separate lines made the expanded row read as a form. */
.llmm-mg-extra{display:flex;align-items:center;gap:10px;justify-content:space-between;margin-top:6px}
.llmm-mg-remove{flex:none;color:var(--dsw-alias-state-error-primary)}
.llmm-mg-removed{margin-top:12px;padding-top:8px;border-top:0.5px solid var(--dsw-alias-border-l1)}
.llmm-mg-removed-head{font-size:11px;line-height:14px;color:var(--dsw-alias-label-tertiary);padding:0 2px 4px}
.llmm-mg-removed-row{opacity:.85}
.llmm-mg-restore{margin-left:auto;flex:none}
.llmm-sw-head{display:flex;align-items:center;gap:8px;padding:2px 2px 4px}
.llmm-sw-title{font-size:11px;line-height:14px;color:var(--dsw-alias-label-tertiary);padding:8px 2px 3px}
.llmm-sw-row{display:flex;align-items:baseline;gap:8px;padding:5px 2px;border-bottom:0.5px solid var(--dsw-alias-border-l1)}
.llmm-sw-count{flex:none;font-size:11px;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-secondary);min-width:14px}
.llmm-sw-sub{flex:none;font-size:11px;color:var(--dsw-alias-label-tertiary);white-space:nowrap}
.llmm-sw-arrow{flex:none;font-size:11px;color:var(--dsw-alias-label-tertiary)}
.llmm-sw-note{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary);padding:9px 2px 0}
/* One incident is several rows: the same session retrying the same dead model.
   Collapsing them keeps the list readable without hiding the raw evidence. */
.llmm-sw-incs{display:flex;flex-direction:column;gap:2px}
.llmm-sw-inc{display:flex;flex-direction:column;border-radius:var(--dsw-radius-sm)}
.llmm-sw-inc-head{display:flex;align-items:center;gap:8px;min-width:0;padding:3px 2px;border:0;background:none;font:inherit;color:inherit;text-align:left;cursor:pointer;border-radius:var(--dsw-radius-sm)}
.llmm-sw-inc-head:hover{background:var(--dsw-alias-interactive-bg-hover)}
.llmm-sw-inc-steps{flex:none;font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}
.llmm-sw-inc-path{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:var(--ds-font-family-code);font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary)}
.llmm-sw-inc-body{padding-left:18px;display:flex;flex-direction:column;gap:1px}
.llmm-sw-legacy{flex:none;font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary);font-style:italic}
.llmm-sw-undo{display:flex;align-items:center;gap:8px;padding:6px 2px 0;font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary)}
.llmm-sw-undo button{border:0;background:none;padding:0;font:inherit;color:var(--dsw-alias-brand-primary);cursor:pointer;text-decoration:underline;text-underline-offset:2px}
/* The Session is where the failure happened, so its name is a link, not decoration:
   underlined because it can be clicked, and capped so a long title cannot push the
   timestamp off the row. */
.llmm-sw-session{flex:none;max-width:190px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;padding:0;border:0;background:none;color:var(--dsw-alias-label-secondary);font:inherit;font-size:11px;cursor:pointer;text-decoration:underline;text-decoration-color:var(--dsw-alias-border-l3);text-underline-offset:2px}
.llmm-sw-session-flat{cursor:default;text-decoration:none;color:var(--dsw-alias-label-tertiary)}
.llmm-sw-continued{flex:none;color:var(--dsw-alias-label-tertiary)}
.llmm-sw-continued.llmm-sw-ok{color:var(--dsw-alias-state-success-primary)}
.llmm-sw-session:hover{color:var(--dsw-alias-label-primary);text-decoration-color:currentColor}
.llmm-sw-session:focus-visible{outline:none;color:var(--dsw-alias-label-primary);text-decoration-color:currentColor}
.llmm-mg-detail{padding:2px 0 10px 20px}
.llmm-mg-also{padding-top:4px;font-size:11px;color:var(--dsw-alias-label-tertiary)}
.llmm-mg-levels{display:flex;align-items:center;gap:4px;padding:4px 0}
.llmm-mg-levels-label{width:52px;flex:none;font-size:11px;color:var(--dsw-alias-label-tertiary)}
.llmm-mg-lvbtn{min-width:22px;height:20px;padding:0 5px;border:0.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-xs);background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:11px;line-height:16px;cursor:pointer}
.llmm-mg-lvbtn-on{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary)}
.llmm-mg-records{display:flex;flex-direction:column}
.llmm-mg-record{border-bottom:0.5px solid var(--dsw-alias-border-l1)}
.llmm-fb-toggle{display:flex;align-items:center;gap:7px;padding:6px 0 10px;font-size:12px;color:var(--dsw-alias-label-primary)}
.llmm-fb-list{display:flex;flex-direction:column;gap:4px;padding-bottom:8px}
.llmm-fb-item{display:flex;align-items:center;gap:8px;padding:4px 6px;border:0.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-sm)}
.llmm-fb-index{width:16px;flex:none;font-size:11px;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums;text-align:right}
.llmm-fb-name{flex:none;max-width:40%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px;color:var(--dsw-alias-label-primary)}
.llmm-fb-route{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px;color:var(--dsw-alias-label-tertiary)}
.llmm-fb-add{display:flex;align-items:center;gap:8px;padding:2px 0 10px}
.llmm-fb-add .llmm-dlg-btn{margin-left:0}
.llmm-fb-picker{position:relative;flex:1;min-width:0}
.llmm-fb-pick{width:100%;justify-content:space-between;gap:8px}
.llmm-fb-pick-label{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.llmm-fb-pick-caret{flex:none;font-size:10px;color:var(--dsw-alias-label-tertiary)}
.llmm-fb-pop{position:absolute;left:0;right:0;top:calc(100% + 4px);z-index:20;display:flex;flex-direction:column;max-height:280px;padding:6px;border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-2);box-shadow:var(--dsw-elevation-prominent)}
.llmm-fb-pop-search{flex:none;margin-bottom:6px}
.llmm-fb-pop-list{flex:1;min-height:0;overflow:auto}
.llmm-fb-opt{display:flex;align-items:center;gap:7px;width:100%;padding:5px 7px;border:0;border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;line-height:18px;text-align:left;cursor:pointer}
.llmm-fb-opt:hover{background:var(--dsw-alias-interactive-bg-hover)}
.llmm-fb-opt-on{background:var(--dsw-alias-interactive-bg-hover)}
.llmm-fb-opt-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.llmm-fb-opt-route{flex:none;font-size:11px;color:var(--dsw-alias-label-tertiary)}
.llmm-fb-opt-flag{flex:none;font-size:11px;color:var(--dsw-alias-label-tertiary)}
.llmm-fb-opt-bad .llmm-fb-opt-flag{color:var(--dsw-alias-state-error-primary)}
.llmm-policy{display:flex;flex-direction:column;gap:2px;margin:0 0 10px;padding:8px 0 0;border-top:0.5px solid var(--dsw-alias-border-l3)}
.llmm-policy-head{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary);padding-bottom:2px}
.llmm-policy-row{display:flex;align-items:flex-start;gap:9px;padding:5px 0}
.llmm-policy-text{flex:1;min-width:0;display:flex;flex-direction:column;gap:1px}
.llmm-policy-label{font-size:12px;line-height:18px;color:var(--dsw-alias-label-primary)}
.llmm-policy-num{flex:none;width:60px;height:24px;padding:0 6px;border:0.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;text-align:right;font-variant-numeric:tabular-nums}
.llmm-policy-num:focus-visible{outline:none;border-color:var(--dsw-alias-border-l4)}
.llmm-policy-num:disabled{opacity:.5}
.llmm-policy-note{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary)}
.llmm-policy-row .llmm-switch{margin-top:2px;flex:none}
.llmm-fb-notes{margin:0;padding:0 0 10px 16px}
.llmm-fb-notes li{font-size:11px;line-height:18px;color:var(--dsw-alias-label-tertiary)}
.llmm-fb-check{display:flex;flex-direction:column;gap:6px;padding-bottom:10px}
.llmm-fb-results{margin:0;padding:0 0 0 16px}
.llmm-fb-results li{font-size:11px;line-height:18px}
.llmm-fb-ok{color:var(--dsw-alias-state-success-primary)}
.llmm-fb-bad{color:var(--dsw-alias-state-warn-primary)}
.llmm-foot-manage{flex:none;display:inline-flex;align-items:center;gap:4px;margin:0;padding:2px 0;border:0;background:transparent;color:var(--dsw-alias-brand-primary);font:inherit;font-size:11px;line-height:16px;cursor:pointer}
.llmm-foot-manage:hover{text-decoration:underline;text-underline-offset:2px}
.llmm-label{display:inline-flex;align-items:center;gap:6px;min-width:0;max-width:100%}
.llmm-label-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.llmm-label-badge{flex:none;font-size:10px;line-height:14px;padding:0 5px}
.llmm-label .llmm-dot{width:6px;height:6px}

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
.llmm-menu-foot{flex:none;display:flex;align-items:center;justify-content:space-between;gap:10px;margin:3px 0 0;padding:5px 7px 3px;border-top:0.5px solid var(--dsw-alias-border-l3)}
/* ── the switcher: one trigger, two lists, one level rail ─────────────────────
   The level used to live in a popover of its own, on a second trigger. It is a
   rail inside the panel now, so the trigger only has to name the value it
   carries — and a slider needs the panel's width, not a button's. */
.llmm-trigger-effort{flex:none;margin-left:6px;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}
.llmm-menu-close{flex:none;width:22px;height:22px;display:inline-flex;align-items:center;justify-content:center;padding:0;border:0;border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:1;cursor:pointer}
.llmm-menu-close:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.llmm-tabs{flex:none;display:flex;gap:14px;margin:2px 0 3px;padding:0 7px;border-bottom:0.5px solid var(--dsw-alias-border-l3)}
.llmm-tab{position:relative;padding:5px 0 6px;border:0;background:transparent;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;cursor:pointer}
.llmm-tab:hover{color:var(--dsw-alias-label-primary)}
.llmm-tab-on{color:var(--dsw-alias-label-primary)}
.llmm-tab-on::after{content:'';position:absolute;left:0;right:0;bottom:-0.5px;height:2px;border-radius:1px;background:var(--dsw-alias-brand-primary)}
.llmm-tab-count{margin-left:5px;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}
.llmm-rail-section{flex:none;margin:4px 0 0;padding:6px 7px 0;border-top:0.5px solid var(--dsw-alias-border-l3)}
.llmm-rail-head{display:flex;align-items:center;gap:8px}
.llmm-rail-title{flex:none;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}
.llmm-rail-out{flex:1;min-width:0;color:var(--dsw-alias-label-primary);font-size:12px;line-height:18px;font-variant-numeric:tabular-nums}
.llmm-rail-auto{flex:none;padding:1px 8px;border:0;border-radius:var(--dsw-radius-xl);background:transparent;color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px;cursor:pointer}
.llmm-rail-auto:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.llmm-rail-auto-on{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.llmm-rail-auto:disabled{opacity:.5;cursor:default}
.llmm-opt{display:flex;flex-direction:column;gap:4px;padding:6px 12px 8px}
.llmm-opt-row{display:flex;align-items:center;gap:8px}
.llmm-opt-label{flex:1;min-width:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.llmm-opt-note{font-size:11px;line-height:15px;color:var(--dsw-alias-label-tertiary)}
.llmm-opt-bad{font-size:11px;line-height:15px;color:var(--dsw-alias-state-error-primary)}
.llmm-switch{flex:none;position:relative;width:30px;height:17px;padding:0;border:0;border-radius:999px;background:var(--dsw-alias-border-l3);cursor:pointer;transition:background .12s ease}
.llmm-switch:hover:not(:disabled){background:var(--dsw-alias-border-l4)}
.llmm-switch:disabled{opacity:.45;cursor:default}
.llmm-switch-on,.llmm-switch-on:hover:not(:disabled){background:var(--dsw-alias-button-primary-fill)}
.llmm-switch-knob{position:absolute;top:2px;left:2px;width:13px;height:13px;border-radius:50%;background:var(--dsw-alias-bg-layer-1);transition:transform .12s ease}
.llmm-switch-on .llmm-switch-knob{transform:translateX(13px)}
.llmm-opt-confirm{display:flex;flex-direction:column;gap:4px;margin-top:2px;padding:8px 10px;border:0.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-layer-2)}
.llmm-opt-confirm-title{font-size:12px;line-height:17px;color:var(--dsw-alias-label-primary)}
.llmm-opt-confirm-text{font-size:11px;line-height:15px;color:var(--dsw-alias-label-tertiary)}
.llmm-opt-confirm-acts{display:flex;justify-content:flex-end;gap:6px;margin-top:2px}
.llmm-rail{width:100%;height:14px;margin:6px 0 0;padding:0;appearance:none;-webkit-appearance:none;background:transparent;cursor:pointer}
.llmm-rail::-webkit-slider-runnable-track{height:4px;border-radius:2px;background:var(--dsw-alias-border-l3)}
.llmm-rail::-moz-range-track{height:4px;border-radius:2px;background:var(--dsw-alias-border-l3)}
.llmm-rail::-webkit-slider-thumb{appearance:none;-webkit-appearance:none;width:12px;height:12px;margin-top:-4px;border-radius:50%;background:var(--dsw-alias-brand-primary);border:2px solid var(--dsw-alias-bg-layer-1)}
.llmm-rail::-moz-range-thumb{width:12px;height:12px;border-radius:50%;background:var(--dsw-alias-brand-primary);border:2px solid var(--dsw-alias-bg-layer-1)}
.llmm-rail:disabled{cursor:default;opacity:.5}
.llmm-rail-ticks{display:flex;justify-content:space-between;margin-top:-1px;padding:0 1px}
.llmm-rail-tick{width:1px;height:4px;background:var(--dsw-alias-border-l3)}
.llmm-rail-tick-on{background:var(--dsw-alias-brand-primary)}
.llmm-rail-scale{display:flex;justify-content:space-between;color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px}
.llmm-rail-empty{display:flex;align-items:center;gap:8px;padding:0 0 6px;color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px}
.llmm-row-probe{flex:none;display:inline-flex;align-items:center;margin-right:1px}
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
.llmm-banner-cont{color:var(--dsw-alias-label-secondary);font-size:11px;line-height:16px}
.llmm-banner-off{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px;white-space:nowrap}
/* A repair that worked is a footnote: one quiet line, no warning colour, no
   buttons competing with the composer. */
.llmm-banner-quiet{align-items:center;gap:6px;padding:3px 8px;border:0.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);background:transparent;color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px}
.llmm-banner-quiet .llmm-banner-mark{color:var(--dsw-alias-state-success-primary)}
.llmm-banner-quiet-text{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.llmm-banner-quiet-when{flex:none;font-variant-numeric:tabular-nums}
.llmm-banner-x{flex:none;border:0;background:none;padding:0 2px;color:inherit;font:inherit;line-height:1;cursor:pointer;opacity:.7}
.llmm-banner-x:hover,.llmm-banner-x:focus-visible{opacity:1;color:var(--dsw-alias-label-secondary)}
.llmm-btn-quiet{padding:1px 6px;font-size:11px;line-height:16px}
/* The default model is not this plugin's to configure, but it decides whether the
   next conversation works at all, so a broken one earns exactly one line here. */
.llmm-default-warn{display:flex;align-items:center;gap:8px;margin:0 0 8px;padding:6px 10px;border:0.5px solid var(--dsw-alias-state-warn-primary);border-radius:var(--dsw-radius-md);background:color-mix(in srgb, var(--dsw-alias-state-warn-primary) 10%, transparent);color:var(--dsw-alias-state-warn-label);font-size:11px;line-height:16px}
.llmm-default-warn-text{flex:1;min-width:0}
.llmm-default-warn-scope{opacity:.85}
.llmm-default-warn button{flex:none;border:0;background:none;padding:0;font:inherit;color:inherit;cursor:pointer;text-decoration:underline;text-underline-offset:2px}
.llmm-default-note{margin:0 0 8px;padding:0 2px;font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary)}

/* -- The composer controller ------------------------------------------------
   Additive, directly above the composer card. The editor keeps every shipped
   seat (IME, paste, slash adjudication, mentions, attachments); this layer only
   reads the input state it publishes and changes shape. Idle is a hairline, a
   draft is a meter, a turn in flight is a capsule with a clock. Theme tokens
   only -- no new materials. */
/* A control cluster, not a toolbar: the row keeps the card's width but the rail only
   takes what it needs and sits against the card's right edge. */
.llmm-ctl{display:flex;align-items:center;gap:6px;min-width:0;height:26px}
.llmm-ctl-dot{flex:none;width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-label-tertiary)}
.llmm-ctl[data-mode="running"] .llmm-ctl-dot{background:var(--dsw-alias-state-success-primary);animation:llmm-ctl-pulse 1.6s ease-in-out infinite}
.llmm-ctl[data-mode="busy"] .llmm-ctl-dot{background:var(--dsw-alias-brand-primary);animation:llmm-ctl-pulse 1.1s ease-in-out infinite}
.llmm-ctl-text{min-width:0;max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}
.llmm-ctl[data-mode="running"] .llmm-ctl-text,.llmm-ctl[data-mode="busy"] .llmm-ctl-text{color:var(--dsw-alias-label-secondary)}
.llmm-ctl-icon{flex:none;display:inline-flex;align-items:center;justify-content:center;width:22px;height:22px;padding:0;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-tertiary);opacity:.7;cursor:pointer;transition:opacity .15s ease,background-color .15s ease,color .15s ease}
.llmm-ctl-icon:hover,.llmm-ctl-icon:focus-visible{opacity:1;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover);outline:none}
/* The shortcut is a standing hint, not a hover reward. Hiding it to opacity 0
   left a blank slot between the gear and the model trigger — a gap that read as
   broken spacing rather than as restraint. */
.llmm-ctl-key{flex:none;padding:0 6px;border:0;border-radius:999px;background:transparent;color:var(--dsw-alias-label-tertiary);font:inherit;font-size:11px;line-height:16px;cursor:pointer;opacity:.75;transition:opacity .16s ease,color .16s ease,background-color .16s ease}
.llmm-ctl-key:hover,.llmm-ctl-key:focus-visible{opacity:1;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover);outline:none}
@keyframes llmm-ctl-pulse{0%,100%{opacity:.45}50%{opacity:1}}
/* The palette is a fixed surface: the composer card clips its own children, so a
   popover born inside it would be cut at the card's edge. */
/* Same material as the picker card: the theme's menu fill behind the content,
   the elevation stroke instead of a hand-rolled border and a heavy drop shadow.
   The overlay scrim is the colour *behind* a dialog, not a surface — painting a
   560px panel with it is what made this read as a different product. */
.llmm-pal{position:fixed;left:50%;bottom:132px;transform:translateX(-50%);z-index:90;width:min(560px,calc(100vw - 32px));max-height:min(420px,50vh);display:flex;flex-direction:column;isolation:isolate;border:0;border-radius:var(--dsw-radius-lg);overflow:hidden;box-shadow:var(--dsw-elevation-prominent,0 0 0 .5px var(--dsw-alias-border-l1),0 3px 8px rgba(0,0,0,.04),0 0 20px rgba(0,0,0,.05));--dsw-elevation-stroke-color:var(--dsw-alias-border-l1);font-size:13px;color:var(--dsw-alias-label-primary)}
.llmm-pal::before{content:'';position:absolute;inset:0;z-index:-1;border-radius:inherit;background:var(--dsw-specific-menu,var(--dsw-alias-bg-layer-2,var(--dsw-alias-bg-overlay)));backdrop-filter:var(--dsw-menu-backdrop-filter,none)}
.llmm-pal-head{flex:none;display:flex;align-items:center;justify-content:space-between;gap:12px;padding:8px 12px 6px;border-bottom:0.5px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px}
.llmm-pal-note{color:var(--dsw-alias-brand-primary);text-transform:none;letter-spacing:0}
.llmm-pal-list{flex:1;min-height:0;margin:0;padding:4px;list-style:none;overflow:auto}
.llmm-pal-item{margin:0;padding:0}
.llmm-pal-run{display:flex;align-items:center;gap:10px;width:100%;padding:6px 8px;border:0;border-radius:var(--dsw-radius-md);background:transparent;color:inherit;font:inherit;text-align:left;cursor:pointer}
.llmm-pal-on .llmm-pal-run{background:var(--dsw-alias-interactive-bg-hover)}
.llmm-pal-run:focus-visible{outline:none;background:var(--dsw-alias-interactive-bg-hover)}
.llmm-pal-off .llmm-pal-run{opacity:.45;cursor:default}
.llmm-pal-label{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.llmm-pal-hint{flex:none;color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px;font-variant-numeric:tabular-nums;max-width:45%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
/* The palette is a command list, not a level picker: the levels live one level
   down, and the root carries a search field, group headings and per-row answers.
   A row that is asked to do work says so on its own line rather than in a toast,
   because the answer belongs to the command, not to the panel. */
.llmm-pal-search{flex:1;min-width:0;height:22px;padding:0;border:0;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;outline:none}
.llmm-pal-search::placeholder{color:var(--dsw-alias-label-tertiary)}
.llmm-pal-search::-webkit-search-cancel-button{display:none}
.llmm-pal-back{flex:none;padding:0;border:0;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;cursor:pointer}
.llmm-pal-back:hover{color:var(--dsw-alias-label-primary)}
.llmm-pal-group{padding:7px 8px 3px;color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:14px;user-select:none}
.llmm-pal-group:first-child{padding-top:2px}
.llmm-pal-empty{padding:14px 8px;color:var(--dsw-alias-label-tertiary);font-size:12px;text-align:center}
.llmm-pal-spin{flex:none;width:11px;height:11px;border:1.5px solid var(--dsw-alias-border-l3);border-top-color:var(--dsw-alias-label-primary);border-radius:50%;animation:llmm-rotate .7s linear infinite}
.llmm-pal-ok{color:var(--dsw-alias-label-secondary)}
.llmm-pal-bad{color:var(--dsw-alias-state-error-primary)}
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
    /**
     * The session-options row the shipped model menu appends: the agent-team switch.
     *
     * Taking the seat cannot take that row with it. `renderSlot` is injected only
     * into entries that DECLARE children, and declaring this one is refused because
     * the shipped entry already owns the declaration — a second `children` table
     * throws `slot "…" is already declared` (harness
     * `packages/client/ui-slots/src/index.ts:1280`; `ui-renderer/src/client/scoped-slots.tsx:76`
     * throws `SlotOwnershipError` for a key outside an entry's declaration). The
     * capability is therefore RE-PROVIDED against the same projection and the same
     * remote call the shipped row uses, instead of disappearing with the seat. If a
     * future framework lets a replacement inherit its children, delete this row and
     * go back to `props.renderSlot(...)`.
     *
     * Rules mirrored from `ui-agent-team/TeamModeToggle`: no switch for a child
     * session, no switch when the capability projection is absent, and turning it
     * off mid-conversation asks first — the confirmation is inline here because the
     * shipped confirmation lives in a store this plugin does not own.
     *
     * @param props - session, lock state, standard hooks, the switch verb, and copy.
     * @returns the row, or nothing when the capability is absent for this session.
     */
    function TeamModeRow(props) {
      const { sessionId, locked, setTeamEnabled, useProjection, t } = props
      // Presence of the hook cannot change under a mounted entry, so the
      // conditional call below keeps the hook order stable.
      const readProjection = typeof useProjection === 'function' ? useProjection : null
      const mode = readProjection === null ? undefined : readProjection('agentTeam')
      const selection = readProjection === null ? undefined : readProjection('modelSelection')
      const addressedChild = typeof props.useSession === 'function'
        ? props.useSession(snapshot => snapshot.subagent !== null) === true
        : false
      const listedChild = typeof props.useSessions === 'function' && sessionId !== ''
        ? props.useSessions(state => state.byId[sessionId]?.origin === 'subagent') === true
        : false
      const [pending, setPending] = useState(false)
      const [confirming, setConfirming] = useState(false)
      const [failure, setFailure] = useState('')
      if (mode === undefined || mode === null || typeof mode !== 'object') return null
      if (addressedChild || listedChild) return null
      const enabled = mode.enabled === true
      const busy = pending
      const commit = (next) => {
        if (typeof setTeamEnabled !== 'function') {
          setFailure(t('teamFailed').replace('{message}', 'agentTeams is not available in this client'))
          return
        }
        setPending(true)
        setFailure('')
        Promise.resolve()
          .then(() => setTeamEnabled(sessionId, next))
          .then((response) => {
            if (response !== undefined && response !== null && response.ok === false) {
              const detail = response.error === undefined || response.error === null
                ? ''
                : String(response.error.message ?? '')
              setFailure(t('teamFailed').replace('{message}', detail))
            }
          }, (error) => {
            setFailure(t('teamFailed').replace('{message}', String(error?.message ?? error)))
          })
          .then(() => { setPending(false) })
      }
      const toggle = () => {
        if (busy) return
        // Turning teamwork off after the session has already run a model choice is
        // the case the shipped row confirms: the next turn keeps its cache only if
        // it keeps the same tools.
        if (enabled && selection !== undefined && selection !== null
          && selection.lastUsed !== undefined && selection.lastUsed !== null) {
          setConfirming(true)
          return
        }
        commit(!enabled)
      }
      return h('div', { className: 'llmm-opt' },
        h('div', { className: 'llmm-opt-row' },
          h('span', { className: 'llmm-opt-label', title: t('teamInfo') }, t('teamLabel')),
          h('button', {
            type: 'button',
            role: 'switch',
            'aria-checked': enabled,
            'aria-label': t('teamLabel'),
            className: `llmm-switch${enabled ? ' llmm-switch-on' : ''}`,
            disabled: locked === true || busy || selection === undefined,
            onClick: toggle,
          }, h('span', { className: 'llmm-switch-knob', 'aria-hidden': true })),
        ),
        failure !== ''
          ? h('div', { className: 'llmm-opt-bad' }, failure)
          : h('div', { className: 'llmm-opt-note' }, t('teamDescription')),
        confirming
          ? h('div', { className: 'llmm-opt-confirm', role: 'alertdialog', 'aria-label': t('teamDisableTitle') },
            h('div', { className: 'llmm-opt-confirm-title' }, t('teamDisableTitle')),
            h('div', { className: 'llmm-opt-confirm-text' }, t('teamDisableText')),
            h('div', { className: 'llmm-opt-confirm-text' }, t('teamDisableWarning')),
            h('div', { className: 'llmm-opt-confirm-acts' },
              h('button', {
                type: 'button',
                className: 'llmm-dlg-btn',
                onClick: () => setConfirming(false),
              }, t('teamDisableCancel')),
              h('button', {
                type: 'button',
                className: 'llmm-dlg-btn llmm-dlg-btn-primary',
                onClick: () => { setConfirming(false); commit(false) },
              }, t('teamDisableConfirm')),
            ),
          )
          : null,
      )
    }

    function Picker(props) {
      const { available, directory, load, select, locked, setTeamEnabled } = props
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
      // One entry, two lists. `all` stays the default so a first-time reader sees
      // the whole catalogue without having to discover a tab first; `frequent` is
      // the shortcut back to the models this profile actually reaches for.
      const [tab, setTab] = useState('all')
      // The slider's position while a drag is in flight. React cannot commit fast
      // enough to follow the pointer on its own, so the thumb follows this and the
      // selection is committed once the value lands on a level.
      const [railIndex, setRailIndex] = useState(null)
      // A tooltip channel of this component's own. The panel has one, but each is
      // scoped to its own subtree, and the actions need the label the icon cannot
      // spell — the same reason the panel's icon buttons carry one.
      const [tip, setTip] = useState(null)
      // The model new sessions start on is not ours, but a dead one there fails every
      // conversation on its first message. One line, one button, only when it is broken.
      const [defaultRow, setDefaultRow] = useState(null)
      const [defaultNote, setDefaultNote] = useState('')
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

      // Checked when the picker opens rather than on every render: it is one read of
      // the composition, and the answer only changes when something else changes it.
      useEffect(() => {
        if (!open) return undefined
        let alive = true
        setDefaultNote('')
        callHost({ action: 'defaultModel' })
          .then((data) => { if (alive) setDefaultRow(data.value ?? null) })
          .catch(() => { if (alive) setDefaultRow(null) })
        return () => { alive = false }
      }, [open])

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
        // Only an EXPLICIT level travels with the re-pick. `state.retainedEffort` is the
        // effective level NAME — since 0.2.2 that includes the adapter default — so
        // reusing it would pin an automatic setting the first time the same model is
        // chosen again, and a level this route does not declare must never be sent.
        const explicitEffort = current !== null && current.provider === provider && current.model === row.model
          ? current.reasoningEffort
          : undefined
        const reuseEffort = explicitEffort !== undefined
          && (reasoningOf(provider, row.model)?.efforts ?? []).some(level => level.id === explicitEffort)
          ? explicitEffort
          : undefined
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
      }, [select, current, reasoningOf])

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
      // The slider is the only level control now: the trigger names the level, the
      // panel moves it. Index 0 is "auto" — no explicit level, which the platform
      // reads as the adapter's own default — and every declared level follows it.
      const railLevels = currentReasoning === undefined ? [] : currentReasoning.efforts
      const railStop = railLevels.length === 0
        ? 0
        : selectedEffort === undefined
          ? 0
          : Math.max(0, railLevels.findIndex(level => level.id === selectedEffort) + 1)
      const railValue = Math.min(railIndex === null ? railStop : railIndex, railLevels.length)
      // Index 0 is "auto" — the adapter's own default — but the prototype's output
      // names that default ("自动 · High"): "Default (upstream)" is jargon, and the
      // level that actually runs is the model's declared default, not a mystery.
      const defaultName = railLevels.length === 0
        ? ''
        : (railLevels.find(level => level.id === currentReasoning?.defaultEffort)?.name
          || currentReasoning?.defaultEffort
          || '')
      const railName = railValue === 0
        ? (defaultName !== '' ? `${t('ctlAuto')} · ${defaultName}` : t('effortDefaultFull'))
        : (railLevels[railValue - 1]?.name || railLevels[railValue - 1]?.id || '')
      const railAria = railLevels.length === 0
        ? effortTitle
        : railValue === 0
          ? (defaultName !== '' ? `${defaultName}, auto` : 'auto')
          : `${railName}, ${railLevels[railValue - 1].id}`

      // A different model carries a different level set; a leftover in-flight index
      // would point past the end of it.
      useEffect(() => {
        setRailIndex(null)
      }, [current === null ? '' : current.provider, current === null ? '' : current.model])

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
      }, [select, current])

      // A range input reports every step it crosses, and a slider that snaps has no
      // free-hand position to hold, so the value is committed as it lands.
      const commitRail = useCallback((index) => {
        setRailIndex(index)
        const level = index === 0 ? undefined : railLevels[index - 1]?.id
        if (index > 0 && level === undefined) return
        applyEffort(level)
      }, [applyEffort, railLevels])

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
            // The ECG button answers "is this route actually alive?" right where the
            // row already says it is not: the status and the reason are replaced in
            // place, and the same probe measures the model's level set.
            isProblem(status)
              ? h('span', { className: 'llmm-row-probe' },
                act('pulse', t('probe'), false, () => probe(row), `probe:${key}`, true))
              : null,
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
      // The curated tab is exactly the three sections the list already lifts, with
      // the catalogue left out: "frequent" means what the sort already means, so the
      // two tabs cannot disagree about which models those are.
      const curatedCount = sections.pinned.length + sections.favorites.length + sections.frequent.length
      const frequentRows = [
        sections.pinned.length > 0
          ? renderSection('llmm-pinned', t('sectionPinned'), orderRows(sections.pinned))
          : null,
        sections.favorites.length > 0
          ? renderSection('llmm-favorites', t('sectionFavorites'), orderRows(sections.favorites))
          : null,
        sections.frequent.length > 0
          ? renderSection('llmm-frequent', t('sectionFrequent'), orderRows(sections.frequent), true)
          : null,
      ]
      // Each route keeps its own section with the lifted rows removed, so a model is
      // never listed twice and the menu still offers the whole catalogue. Hidden
      // models come last and offered back: hiding would otherwise be a one-way door.
      const catalogueRows = [
        sections.groups.map(group => renderSection(
          group.route, group.name || group.route, orderRows(group.rows),
        )),
        sections.hidden.length > 0
          ? renderSection('llmm-hidden', t('sectionHidden'), orderRows(sections.hidden))
          : null,
      ]

      // Arrow roaming is the one keyboard affordance the shipped picker has that a
      // mouse-only list does not, and it has to work from the search box because that
      // is where the hands already are: the list is long, and reaching for the mouse
      // to pick the third hit is the slow half of a search.
      const roam = event => {
        if (event.altKey || event.metaKey || event.ctrlKey) return
        if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
        const buttons = [...event.currentTarget.querySelectorAll('.llmm-item-select')]
          .filter(button => button.disabled !== true)
        if (buttons.length === 0) return
        event.preventDefault()
        const at = buttons.indexOf(document.activeElement)
        const step = event.key === 'ArrowDown' ? 1 : -1
        const next = at < 0
          ? (step === 1 ? 0 : buttons.length - 1)
          : (at + step + buttons.length) % buttons.length
        buttons[next].focus()
      }

      // Whether this conversation is the one that would use that default. A session
      // without its own selection inherits it, so the warning is about *this* chat;
      // a session that picked its own model needs to be told that this line is not
      // about it, or the sentence reads as a fault report for the wrong conversation.
      const runsOnDefault = current === null
        || (defaultRow !== null && current.provider === defaultRow.route && current.model === defaultRow.model)
      const warnDefault = defaultRow !== null && defaultRow.known === true && defaultRow.unusable === true
      const fixDefault = async () => {
        const target = defaultRow?.suggestion
        if (target === null || target === undefined) return
        try {
          const answer = await callHost({ action: 'setDefaultModel', route: target.route, model: target.model })
          if (answer.value !== undefined) setDefaultRow(answer.value)
          setDefaultNote(t('defaultModelFixed'))
        } catch {
          setDefaultNote(t('managerWriteFailed'))
        }
      }

      const card = h('div', {
        className: 'llmm-menu', style: position, ref: menuRef, role: 'dialog', 'aria-label': t('pickerTitle'),
        onKeyDown: roam,
      },
        h('div', { className: 'llmm-menu-head' },
          h('input', {
            className: 'llmm-input',
            placeholder: t('search'),
            value: query,
            autoFocus: true,
            onChange: event => setQuery(event.target.value),
          }),
          h('button', {
            type: 'button',
            className: 'llmm-menu-close',
            'aria-label': t('panelClose'),
            title: t('panelClose'),
            onClick: () => setOpen(false),
          }, '\u2715'),
        ),
        warnDefault
          ? h('div', { className: 'llmm-default-warn' },
            h('span', {
              className: 'llmm-default-warn-text',
              title: typeof defaultRow.detail === 'string' ? defaultRow.detail : '',
            },
              t('defaultModelWarn')
                .replace('{model}', defaultRow.model)
                .replace('{why}', statusLabel(defaultRow.status)),
              runsOnDefault ? null : ' ',
              runsOnDefault
                ? null
                : h('span', { className: 'llmm-default-warn-scope' }, t('defaultModelScope'))),
            defaultRow.suggestion !== null && defaultRow.suggestion !== undefined
              ? h('button', { type: 'button', onClick: fixDefault },
                t('defaultModelFix').replace('{model}', defaultRow.suggestion.model))
              : null)
          : defaultNote === ''
            ? null
            : h('div', { className: 'llmm-default-note' }, defaultNote),
        // Two lists, one switch. The counts sit on the tabs because they are the
        // fastest answer to "is anything in there?" without opening it.
        h('div', { className: 'llmm-tabs', role: 'tablist' },
          h('button', {
            type: 'button',
            role: 'tab',
            'aria-selected': tab === 'frequent',
            className: `llmm-tab${tab === 'frequent' ? ' llmm-tab-on' : ''}`,
            onClick: () => setTab('frequent'),
          },
            t('tabFrequent'),
            curatedCount > 0 ? h('span', { className: 'llmm-tab-count' }, String(curatedCount)) : null,
          ),
          h('button', {
            type: 'button',
            role: 'tab',
            'aria-selected': tab === 'all',
            className: `llmm-tab${tab === 'all' ? ' llmm-tab-on' : ''}`,
            onClick: () => setTab('all'),
          },
            t('tabAll'),
            h('span', { className: 'llmm-tab-count' }, String(shown)),
          ),
        ),
        h('div', { className: 'llmm-menu-body' },
          shown === 0 ? h('div', { className: 'llmm-empty' }, t('noModels')) : null,
          tab === 'frequent'
            ? curatedCount === 0
              ? h('div', { className: 'llmm-empty' }, t('frequentEmpty'))
              : frequentRows
            : [...frequentRows, ...catalogueRows],
        ),
        // The level control lives here, not on the trigger: a slider cannot be put on
        // a 100px button, and the panel is already where the model's capability is
        // being read. Index 0 is "auto" — the provider's own default.
        h('div', { className: 'llmm-rail-section' },
          h('div', { className: 'llmm-rail-head' },
            h('span', { className: 'llmm-rail-title' }, t('effortName')),
            h('output', { className: 'llmm-rail-out' }, railName),
            h('button', {
              type: 'button',
              className: `llmm-rail-auto${railValue === 0 ? ' llmm-rail-auto-on' : ''}`,
              'aria-pressed': railValue === 0,
              disabled: railLevels.length === 0 || locked,
              title: t('effortDefaultFull'),
              onClick: () => { commitRail(0) },
            }, t('ctlAuto')),
          ),
          railLevels.length === 0
            // No declared levels is an unmeasured state, not an error one: the panel
            // offers the measurement instead of a dead control.
            ? h('div', { className: 'llmm-rail-empty' },
              h('span', null, effortState === 'measured' ? t('effortMeasuredHint') : effortTitle),
              h('button', {
                type: 'button',
                className: 'llmm-inline-act',
                disabled: current === null || pending !== '',
                onClick: () => {
                  if (current !== null) probe({ route: current.provider, model: current.model })
                },
              }, t('railProbe')),
            )
            : h(React.Fragment, null,
              h('input', {
                type: 'range',
                className: 'llmm-rail',
                min: 0,
                max: railLevels.length,
                step: 1,
                value: railValue,
                disabled: locked,
                'aria-label': t('effortName'),
                'aria-valuetext': railAria,
                onChange: event => { commitRail(Number(event.target.value)) },
              }),
              h('div', { className: 'llmm-rail-ticks', 'aria-hidden': true },
                Array.from({ length: railLevels.length + 1 }, (unused, index) => h('span', {
                  key: index,
                  className: `llmm-rail-tick${index === railValue ? ' llmm-rail-tick-on' : ''}`,
                }))),
              h('div', { className: 'llmm-rail-scale' },
                h('span', null, t('ctlAuto')),
                h('span', null, railLevels[railLevels.length - 1].name || railLevels[railLevels.length - 1].id),
              ),
            ),
        ),
        // Session options the shipped menu appends after its model and reasoning
        // controls. That child seat is `conversation.input.model.options`, and the
        // agent-team switch lives in it. A replacing entry cannot render the seat —
        // see TeamModeRow — so the capability is provided here instead, after the
        // level control, in the same reading order.
        h(TeamModeRow, {
          sessionId: typeof props.sessionId === 'string' ? props.sessionId : '',
          locked: locked === true,
          setTeamEnabled,
          useSession: props.useSession,
          useSessions: props.useSessions,
          useProjection: props.useProjection,
          t,
        }),
        // The sort control earns its place only once there is usage to sort by;
        // on a fresh profile it would offer three orderings that all look alike.
        h('div', { className: 'llmm-menu-foot' },
          h('button', {
            type: 'button',
            className: 'llmm-foot-manage',
            onClick: () => { setOpen(false); openManager() },
          }, t('managerOpen')),
          usageSeen > 0
            ? h('div', { className: 'llmm-sort' },
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
            )
            : null,
        ),
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
            // Reopening is the boundary that settles the order: the pins set while
            // the last menu was open are applied here, so the freeze never holds a
            // stale section layout longer than the menu it belongs to.
            onClick: () => {
              setFrozenFlags(null)
              setDetailKeys((currentKeys) => (currentKeys.size === 0 ? currentKeys : new Set()))
              setOpen(value => !value)
            },
          },
            h('span', { className: 'llmm-trigger-label' }, triggerLabel),
            // The level rides on the same control as the model: one entry, one panel.
            // It is a label and not a second button because the panel owns moving it,
            // and two controls 4px apart read as a segmented switch.
            current === null
              ? null
              : h('span', { className: 'llmm-trigger-effort', title: effortTitle }, effortLabel),
            h('span', { 'aria-hidden': true }, '▾'),
          ),
        ),
        open && position !== null ? createPortal(card, document.body) : null,
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
      const [filled, setFilled] = useState(false)

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

      // A continuation belongs to one switch; a newer one starts it over.
      useEffect(() => { setFilled(false) }, [note?.at])

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
      // Did the repair pick the work back up? That is a different fact from "the model
      // was switched": one means the run was rescued, the other means the person still
      // has to restart it, and conflating them is what made this banner read as a
      // half-finished feature.
      const continued = note.continued === true
      const levelRepair = note.reason === 'effort'
        && note.from?.model === note.to?.model
      const title = continued
        ? t(levelRepair ? 'fallbackTitleEffort' : 'fallbackTitleContinued')
        : t(outcome === 'reached' ? 'fallbackTitleReached'
          : outcome === 'unreached' ? 'fallbackTitleUnreached' : 'fallbackTitleElsewhere')
      const reasonKey = `fallbackReason${note.reason === 'quota' ? 'Quota'
        : note.reason === 'retired' ? 'Retired'
          : note.reason === 'protocol' ? 'Protocol'
            : note.reason === 'no_adapter' ? 'NoAdapter'
              : note.reason === 'rate_limited' ? 'RateLimited'
                : note.reason === 'unauthorized' ? 'Unauthorized'
                  : note.reason === 'network' ? 'Network' : 'Error'}`
      const reason = t(reasonKey)
      // A switch cannot rescue the run that failed — the platform freezes the
      // model for the step that already started — so the only continuation is the
      // next message. That message should stay the user's: this fills an editable
      // prompt instead of sending text they never wrote.
      // A continuation that already happened makes this button a lie: the turn is
      // queued, and handing over a draft would ask the person to send the same request
      // twice.
      // Offered exactly when the work stopped: a turn that came back on the new model
      // needs nothing, and offering to "continue" it was the old banner's lie.
      const continuable = outcome !== 'reached'
        && continued !== true
        && props?.inputActions !== undefined
        && typeof props.inputActions.setDraft === 'function'
      const continueTurn = () => {
        props.inputActions.setDraft(t('continuePrompt'))
        if (typeof props.inputActions.persistDraft === 'function') props.inputActions.persistDraft()
        setFilled(true)
      }
      const run = async (action, body) => {
        setBusy(action)
        try { await callHost({ action, sessionId, ...body }) } catch { /* advisory */ } finally { setBusy('') }
      }
      // A switch that landed and was picked back up is good news, and good news that
      // occupies the width of the conversation gets read as a warning. It becomes one
      // quiet line that can be dismissed; only a turn that never came back earns the
      // full banner, and that banner leads with the outcome instead of the mechanism.
      if (continued || outcome === 'reached') {
        return h(React.Fragment, null,
          h(Style),
          h('div', { className: 'llmm-root llmm-banner llmm-banner-quiet', role: 'status' },
            h('span', { className: 'llmm-banner-mark', 'aria-hidden': true }, '\u21c4'),
            h('span', { className: 'llmm-banner-quiet-text' },
              t('bannerHandedOver').replace('{model}', note.to?.model ?? to)),
            h('span', { className: 'llmm-banner-quiet-when' }, ageOf(note.at)),
            // Undo stays reachable without turning the line back into a banner: moving a
            // Session to another model is a real change, and a footnote is still a place
            // a person can look after they notice it.
            note.from !== undefined && note.from !== null
              ? h('button', {
                type: 'button',
                className: 'llmm-banner-x llmm-banner-undo',
                title: t('fallbackRevert'),
                'aria-label': t('fallbackRevert'),
                disabled: busy !== '',
                onClick: () => run('fallbackRevert', { route: note.from.route, model: note.from.model }),
              }, '↩')
              : null,
            h('button', {
              type: 'button',
              className: 'llmm-banner-x',
              title: t('dismiss'),
              'aria-label': t('dismiss'),
              onClick: () => setHiddenAt(note.at),
            }, '\u00d7')))
      }

      return h(React.Fragment, null,
        h(Style),
        h('div', { className: 'llmm-root llmm-banner', role: 'status' },
          h('span', { className: 'llmm-banner-mark', 'aria-hidden': true }, continued || outcome === 'reached' ? '⇄' : '⚠'),
          h('div', { className: 'llmm-banner-body' },
            h('div', { className: 'llmm-banner-line' },
              h('b', null, title),
              from !== '' ? h('code', { className: 'llmm-banner-move' }, from, ' → ', to) : null,
            ),
            // The raw provider text is one clamped line with the whole message on
            // hover. It used to be inlined in full — up to 400 characters — which
            // is what made this banner taller than the conversation it sat in.
            filled
              ? h('div', { className: 'llmm-banner-cont' }, t('fallbackContinueFilled'))
              : null,
            h('div', {
              className: 'llmm-banner-why',
              // The raw provider text stays available on hover; the refusal reason is
              // appended there too, so the banner can say "not continued" without
              // spending a line on internal wording.
              title: [note.detail ?? '', continued || !note.continueRefused ? '' : note.continueRefused]
                .filter(part => part !== '').join(' · '),
            },
              outcome === 'reached' || continued
                ? reason
                : `${reason}${ran !== '' ? ` · ${t('fallbackRanOn')} ${ran}` : ''}`,
            ),
          ),
          h('div', { className: 'llmm-banner-acts' },
            // Offered only where a switch really landed: elsewhere there is no new
            // model to continue on, so the button would promise what it cannot do.
            continuable
              ? h('button', {
                type: 'button',
                className: 'llmm-btn llmm-btn-quiet',
                onClick: continueTurn,
              }, t('fallbackContinue'))
              : null,
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

    // ── The model manager ──

    /**
     * Open state for the manager dialog.
     *
     * It lives at module scope because two unrelated surfaces drive it: the
     * picker's footer opens the dialog, and the dialog itself closes it. State
     * owned by one slot entry would only be reachable from that entry.
     *
     * @returns {object} `{ subscribe, get, set }`.
     */
    const managerStore = (() => {
      let open = false
      // Which tab the next open lands on. The palette names tabs ("recent
      // failovers", "probe log"), so opening the dialog at its first tab and
      // leaving the user to click again would answer a different question.
      let tab = 'catalog'
      const listeners = new Set()
      const emit = () => {
        for (const listener of listeners) {
          // One surface's failure must not cost the others their rerender.
          try { listener() } catch { /* ignore */ }
        }
      }
      return {
        subscribe(listener) {
          listeners.add(listener)
          return () => { listeners.delete(listener) }
        },
        get: () => open,
        tab: () => tab,
        // The dialog reports the tab the user actually clicked, so "open on
        // records" repeated after a manual switch still differs from where the
        // dialog sits and therefore still moves it.
        setTab(next) {
          if (tab === next) return
          tab = next
          emit()
        },
        set(next, nextTab) {
          // An entry point that names no tab means "manage models", so it lands on
          // the catalogue even if the last visit sat on another tab. Reopening
          // where someone happened to be earlier answers a question they did not ask.
          const wanted = typeof nextTab === 'string' ? nextTab : 'catalog'
          if (open === next && tab === wanted) return
          open = next
          tab = wanted
          emit()
        },
      }
    })()

    /** Open the manager from anywhere inside this plugin, optionally at a tab. */
    const openManager = (tab) => managerStore.set(true, tab)

    /**
     * Split the persisted `route/model` chain entry back into its halves.
     *
     * The Host stores the chain as one string per candidate, so a rename of a
     * route display name never has to rewrite the policy.
     *
     * @param {string} entry - `"route/model"`.
     * @returns {{route: string, model: string}} the two halves.
     */
    const splitRef = (entry) => {
      const at = entry.indexOf('/')
      return at <= 0 ? { route: entry, model: '' } : { route: entry.slice(0, at), model: entry.slice(at + 1) }
    }

    /**
     * An action this client knows but this host does not is the signature of a
     * stale process: the browser reloaded the plugin's client half while the
     * host still runs the copy it booted with. Saying so beats an empty list.
     *
     * @param {unknown} failure - whatever `callHost` rejected with.
     * @returns {boolean} whether the host is running an older copy.
     */
    function isStaleHost(failure) {
      return /unknown action/i.test(String(failure?.message ?? failure ?? ''))
    }

    /**
     * The dialog's mounting point: it renders nothing while closed, so its data
     * is only fetched on the turn the user actually asks for it.
     *
     * @param {object} props - the slot props (unused; the dialog reads the Host).
     * @returns {object|null} the dialog, or nothing while closed.
     */
    /**
     * A hook seat that answers nothing, so the manager reads the Session list through
     * one unconditional hook call whether or not the host provides it.
     * @returns {undefined} no rows.
     */
    function useNoSessions() {
      return undefined
    }

    function ManagerDialog(props) {
      const open = useSyncExternalStore(managerStore.subscribe, managerStore.get, managerStore.get)
      return open ? h(ManagerBody, props) : null
    }

    /**
     * The manager itself: catalog, failover policy and probe log.
     *
     * Three tabs rather than three dialogs because they answer one question —
     * "what will this profile do when I send a message" — and the draft has to
     * span the policy and the proficiency overrides together: a chain saved
     * without its levels would be a half-applied edit.
     *
     * Pins, stars and visibility are NOT drafted: they are already immediate
     * everywhere else in this plugin, and hiding a model that then stays listed
     * until "save" would read as a bug. Edits to them write through at once; only
     * the policy and the manual levels wait for the save button.
     *
     * @returns {object} the dialog element.
     */
    function ManagerBody(props) {
      const [snap, setSnap] = useState(null)
      const [records, setRecords] = useState([])
      const [failovers, setFailovers] = useState({ records: [], models: [] })
      // Clearing is reversible for a few seconds, and saying so is cheaper than a
      // confirmation dialog that every later clear has to pay for.
      const [clearedAt, setClearedAt] = useState(0)
      // Which incident cards are open. A set, not an index: comparing two incidents is
      // the reason to open a second one, and closing the first on that click would make
      // the comparison impossible.
      const [openIncidents, setOpenIncidents] = useState(() => new Set())
      const requestedTab = useSyncExternalStore(managerStore.subscribe, managerStore.tab, managerStore.tab)
      const [tab, setTab] = useState(() => managerStore.tab())
      const [query, setQuery] = useState('')
      const [filter, setFilter] = useState('all')
      const [expandKeys, setExpandKeys] = useState(new Set())
      const [enabled, setEnabled] = useState(true)
      const [chain, setChain] = useState([])
      const [baseline, setBaseline] = useState({ enabled: true, chain: [] })
      const [manual, setManual] = useState({})
      const [addKey, setAddKey] = useState('')
      const [addOpen, setAddOpen] = useState(false)
      const [addQuery, setAddQuery] = useState('')
      const [checked, setChecked] = useState(null)
      const [busy, setBusy] = useState('')
      const [error, setError] = useState('')
      const [stale, setStale] = useState(false)
      const [note, setNote] = useState('')
      const [askDiscard, setAskDiscard] = useState(false)
      const [pendingSession, setPendingSession] = useState('')
      const [tip, setTip] = useState(null)
      const panelRef = useRef(null)
      const tipChannel = useMemo(() => ({
        show: (text, node) => {
          const rect = node.getBoundingClientRect()
          const half = Math.max(40, text.length * 5.5)
          const x = Math.min(window.innerWidth - half - 8, Math.max(half + 8, rect.left + rect.width / 2))
          setTip({ text, x, y: rect.top - 6 })
        },
        hide: () => setTip(null),
      }), [])

      const reload = useCallback(async () => {
        try {
          const data = await callHost({ action: 'snapshot' })
          if (data !== undefined && data.value !== undefined) setSnap(data.value)
        } catch (failure) {
          if (isStaleHost(failure)) setStale(true)
          else setError(t('managerLoadFailed'))
        }
      }, [])

      /**
       * Re-read the gateway directory instead of the cached one.
       *
       * The directory has a 30-minute cache because reading it costs a round trip
       * per route, but a gateway that retires models without notice makes that
       * cache a lie about which rows still exist. Forcing the read is the whole
       * point of the button: the cached answer is exactly the one the user
       * already has on screen.
       */
      // The recovery policy is a preference with an immediate effect on the next
      // failure, so it is written when the switch moves and not saved with the draft:
      // a switch that looks on and does nothing until you press a button elsewhere is
      // the kind of lie a settings row should never tell.
      const recovery = snap !== null && snap !== undefined
        && snap.recovery !== null && typeof snap.recovery === 'object'
        ? snap.recovery
        : { retryFirst: true, autoContinue: true }
      const setPolicy = async (key) => {
        if (busy !== '') return
        setBusy('policy')
        setError('')
        setNote('')
        try {
          const data = await callHost({ action: 'setRecovery', [key]: recovery[key] !== true })
          if (data === undefined || data.value === undefined) return
          setNote(t('policySaved'))
          const fresh = await callHost({ action: 'snapshot' })
          if (fresh !== undefined && fresh.value !== undefined) setSnap(fresh.value)
        } catch (failure) {
          if (isStaleHost(failure)) setStale(true)
          else setError(failure instanceof Error ? failure.message : String(failure))
        } finally {
          setBusy('')
        }
      }

      /**
       * Save one numeric ceiling.
       *
       * Kept apart from the switch handler because the value is a number, not a
       * negation: `!value` on a limit would silently turn 3 into `false`. The field is
       * allowed to be refused — a blank or out-of-range entry leaves the old number in
       * force and says so, instead of quietly pinning it to the minimum.
       */
      const commitPolicyNumber = async (key, raw) => {
        if (busy !== '') return
        const value = Number(String(raw).trim())
        if (!Number.isInteger(value) || value < 0 || value > 10) {
          setError(t('policyBad'))
          return
        }
        if (value === recovery[key]) return
        setBusy('policy')
        setError('')
        setNote('')
        try {
          const data = await callHost({ action: 'setRecovery', [key]: value })
          if (data === undefined || data.value === undefined) return
          setNote(t('policySaved'))
          const fresh = await callHost({ action: 'snapshot' })
          if (fresh !== undefined && fresh.value !== undefined) setSnap(fresh.value)
        } catch (failure) {
          if (isStaleHost(failure)) setStale(true)
          else setError(failure instanceof Error ? failure.message : String(failure))
        } finally {
          setBusy('')
        }
      }

      const pull = async () => {
        setBusy('pull')
        setNote('')
        setError('')
        try {
          const before = snap
          const data = await callHost({ action: 'snapshot', forceDirectory: true })
          if (data === undefined || data.value === undefined) return
          const next = data.value
          setSnap(next)
          const directories = Array.isArray(next.directory) ? next.directory : []
          // A route that exposes no baseURL has no directory to read, and saying so is
          // not the same as the pull failing: the built-in routes are in that state on
          // every pull, so treating them as errors would make the button always red.
          // Only "not one route could be read" is a failed pull.
          const readable = directories.filter((entry) => entry.ok === true)
          if (readable.length === 0) {
            setError(t('pullFailed').replace('{message}',
              directories[0] === undefined || directories[0].error === '' ? '' : directories[0].error))
            return
          }
          // Naming the routes keeps the number honest: the catalogue header counts every
          // model on every route, so a bare "75" next to "115/115" reads like a partial
          // failure instead of "75 is what a directory can be read for".
          const detail = readable.map((entry) => `${entry.route} ${entry.count}`).join(' \u00b7 ')

          // What the user asked the button for: which models the gateway stopped
          // listing. Named, not counted — "3 retired" leaves them looking it up by
          // hand, which is the work this row exists to remove.
          const wasListed = new Set((before?.models ?? [])
            .filter((entry) => entry.status !== 'retired')
            .map((entry) => entry.model))
          const gone = (next.models ?? [])
            .filter((entry) => entry.status === 'retired' && wasListed.has(entry.model))
            .map((entry) => entry.model)
          const named = gone.slice(0, 3).join(', ') + (gone.length > 3 ? ` +${gone.length - 3}` : '')
          setNote(t('pullDone').replace('{detail}', detail)
            + (gone.length === 0 ? '' : t('pullMissing').replace('{names}', named)))
        } catch (failure) {
          if (isStaleHost(failure)) setStale(true)
          else setError(t('pullFailed').replace('{message}', failure instanceof Error ? failure.message : String(failure)))
        } finally {
          setBusy('')
        }
      }

      useEffect(() => {
        ensureStylesheet()
        reload()
      }, [reload])

      // A palette row can ask for a tab while the dialog is already open, so the
      // store's choice has to win over the local state after mount as well.
      useEffect(() => { setTab(requestedTab) }, [requestedTab])

      // The policy is fetched once: it is the only tab whose values are drafted,
      // so it has to be complete before the first keystroke can be judged dirty.
      useEffect(() => {
        let alive = true
        callHost({ action: 'fallbackConfig' })
          .then((data) => {
            if (!alive || data === undefined || data.value === undefined) return
            const next = {
              enabled: data.value.enabled !== false,
              chain: Array.isArray(data.value.chain) ? data.value.chain.slice() : [],
            }
            setEnabled(next.enabled)
            setChain(next.chain)
            setBaseline(next)
          })
          .catch((failure) => { if (isStaleHost(failure)) setStale(true) })
        return () => { alive = false }
      }, [])

      useEffect(() => {
        if (tab !== 'switches') return undefined
        let alive = true
        callHost({ action: 'failoverHistory' })
          .then((data) => {
            if (!alive || data === undefined || data.value === undefined) return
            setFailovers({
              records: Array.isArray(data.value.records) ? data.value.records : [],
              models: Array.isArray(data.value.models) ? data.value.models : [],
            })
          })
          .catch((failure) => { if (isStaleHost(failure)) setStale(true) })
        return () => { alive = false }
      }, [tab])

      useEffect(() => {
        if (tab !== 'records') return undefined
        let alive = true
        callHost({ action: 'probeRecords' })
          .then((data) => {
            if (!alive) return
            setRecords(Array.isArray(data?.value?.records) ? data.value.records : [])
          })
          .catch((failure) => { if (isStaleHost(failure)) setStale(true) })
        return () => { alive = false }
      }, [tab])

      useEffect(() => {
        if (panelRef.current !== null) panelRef.current.focus()
      }, [])

      const dirty = Object.keys(manual).length > 0
        || enabled !== baseline.enabled
        || JSON.stringify(chain) !== JSON.stringify(baseline.chain)

      /**
       * Closing with unsaved edits asks once. Losing a reordered chain to a
       * stray click on the backdrop is the kind of thing a dialog must not do.
       */
      const attemptClose = () => {
        if (dirty) { setAskDiscard(true); return }
        managerStore.set(false)
      }

      /**
       * Leaving for a Session also closes the dialog, so it takes the same guard as
       * the close button: a reordered chain that was never saved must not be dropped
       * because the click landed on a session name rather than on the backdrop.
       */
      const leaveForSession = (sessionId) => {
        setPendingSession('')
        managerStore.set(false)
        if (typeof props.openSession === 'function') props.openSession(sessionId)
      }

      const openSessionRow = (sessionId) => {
        if (typeof sessionId !== 'string' || sessionId === '') return
        if (dirty) { setPendingSession(sessionId); setAskDiscard(true); return }
        leaveForSession(sessionId)
      }

      const discardAndClose = () => {
        const target = pendingSession
        setAskDiscard(false)
        setManual({})
        setEnabled(baseline.enabled)
        setChain(baseline.chain)
        if (target !== '') { leaveForSession(target); return }
        managerStore.set(false)
      }

      const save = async () => {
        setBusy('save')
        setError('')
        setNote('')
        try {
          // Levels first: a chain entry the user just gave a proficiency is still
          // valid if the policy write fails, and both writes report their own error.
          for (const model of Object.keys(manual)) {
            await callHost({ action: 'setLevel', model, level: manual[model] })
          }
          await callHost({ action: 'setFallback', enabled, chain })
          setManual({})
          setBaseline({ enabled, chain })
          setNote(t('managerSaved'))
          await reload()
        } catch (failure) {
          // Never claim a write that did not land: the draft stays, and the reason
          // is shown next to the button that failed.
          setError(failure?.message ?? t('managerSaveFailed'))
        } finally {
          setBusy('')
        }
      }

      // ── the model-first rows, the same shape the picker uses ──
      const rows = useMemo(() => {
        if (snap === null || !Array.isArray(snap.models)) return []
        return snap.models.map((entry) => {
          const routes = Array.isArray(entry.routes) ? entry.routes : []
          const primary = routes.find((route) => route.route === entry.primary) ?? routes[0] ?? null
          return primary === null ? null : { model: entry.model, primary, routes }
        }).filter(Boolean)
      }, [snap])

      const shown = rows.filter((row) => {
        const needle = query.trim().toLowerCase()
        if (needle !== '' && `${row.model} ${row.primary.route} ${row.primary.name ?? ''}`.toLowerCase().indexOf(needle) < 0) return false
        if (filter === 'problem') return isProblem(row.primary.status) || row.primary.status === 'unknown'
        if (filter === 'pinned') return row.routes.some((route) => route.pinned === true)
        if (filter === 'starred') return row.routes.some((route) => route.favorite === true)
        if (filter === 'hidden') return row.routes.every((route) => route.hidden === true)
        return true
      })

      const toggleList = async (row, list) => {
        const active = list === 'pins' ? row.primary.pinned === true
          : list === 'favorites' ? row.primary.favorite === true
            : row.primary.hidden === true
        setBusy(`${list}:${row.model}`)
        setError('')
        try {
          await callHost({ action: 'toggle', route: row.primary.route, model: row.model, list, on: !active })
          await reload()
        } catch {
          setError(t('managerWriteFailed'))
        } finally {
          setBusy('')
        }
      }

      const probeOne = async (row) => {
        setBusy(`probe:${row.model}`)
        setError('')
        try {
          await callHost({ action: 'probe', route: row.primary.route, model: row.model })
          await reload()
        } catch {
          setError(t('managerProbeFailed'))
        } finally {
          setBusy('')
        }
      }

      const probeAll = async () => {
        setBusy('probe-all')
        setError('')
        try {
          // The Host caps the batch and paces it; the dialog sends what is on
          // screen so "probe all" means the list the user is looking at.
          const targets = shown.map((row) => ({ route: row.primary.route, model: row.model }))
          await callHost({ action: 'probeBatch', targets })
          await reload()
          if (tab === 'records') {
            const data = await callHost({ action: 'probeRecords' })
            setRecords(Array.isArray(data?.value?.records) ? data.value.records : [])
          }
        } catch {
          setError(t('managerProbeFailed'))
        } finally {
          setBusy('')
        }
      }

      // Removal writes through at once, like pins and visibility: it is a statement
      // about which rows the user wants to see, not a drafted policy. It is also the
      // one action here that can be undone from the same panel, which is why it does
      // not need a confirmation dialog of its own.
      const removeModel = async (row) => {
        setBusy(`remove:${row.model}`)
        setError('')
        setNote('')
        try {
          const data = await callHost({ action: 'removeModel', route: row.primary.route, model: row.model })
          if (data !== undefined && data.value !== undefined) setSnap(data.value)
          setNote(t('removeModelDone'))
        } catch (failure) {
          if (isStaleHost(failure)) setStale(true)
          else setError(t('managerWriteFailed'))
        } finally {
          setBusy('')
        }
      }

      const restoreModel = async (entry) => {
        setBusy(`restore:${entry.model}`)
        setError('')
        setNote('')
        try {
          const data = await callHost({ action: 'restoreModel', route: entry.route, model: entry.model })
          if (data !== undefined && data.value !== undefined) setSnap(data.value)
          setNote(t('restoreModelDone'))
        } catch (failure) {
          if (isStaleHost(failure)) setStale(true)
          else setError(t('managerWriteFailed'))
        } finally {
          setBusy('')
        }
      }

      const clearSwitches = async () => {
        setBusy('clear-switches')
        setError('')
        try {
          await callHost({ action: 'clearFailover' })
          setFailovers({ records: [], models: [] })
          setClearedAt(Date.now())
        } catch (failure) {
          if (isStaleHost(failure)) setStale(true)
          else setError(t('managerWriteFailed'))
        } finally {
          setBusy('')
        }
      }

      // The rows are archived host-side, so undo is a real restore rather than a
      // redraw of something that was already deleted.
      const undoClearSwitches = async () => {
        setBusy('undo-switches')
        setError('')
        try {
          await callHost({ action: 'undoClearFailover' })
          setClearedAt(0)
          const data = await callHost({ action: 'failoverHistory' })
          if (data.value !== undefined) setFailovers(data.value)
        } catch (failure) {
          if (isStaleHost(failure)) setStale(true)
          else setError(t('managerWriteFailed'))
        } finally {
          setBusy('')
        }
      }

      const moveInChain = (index, delta) => {
        const next = chain.slice()
        const to = index + delta
        if (to < 0 || to >= next.length) return
        const moved = next.splice(index, 1)[0]
        next.splice(to, 0, moved)
        setChain(next)
      }

      const removeFromChain = (index) => setChain(chain.filter((unused, at) => at !== index))

      const addToChain = () => {
        if (addKey === '' || chain.includes(addKey) || chain.length >= 12) return
        setChain([...chain, addKey])
        setAddKey('')
      }

      // Local only: the chain is about "would this even resolve", so it answers
      // from the directory and the health this plugin already recorded instead of
      // spending a request per candidate.
      const checkChain = () => {
        const results = chain.map((entry) => {
          const ref = splitRef(entry)
          const row = rows.find((candidate) => candidate.model === ref.model)
          const route = row === undefined ? undefined : row.routes.find((candidate) => candidate.route === ref.route)
          if (route === undefined) return { entry, ok: false, why: t('chainMissing') }
          if (route.hidden === true) return { entry, ok: false, why: t('chainHidden') }
          if (isProblem(route.status)) return { entry, ok: false, why: statusLabel(route.status) }
          if (route.status === 'unknown') return { entry, ok: false, why: t('chainUnprobed') }
          return { entry, ok: true, why: statusLabel(route.status) }
        })
        setChecked(results)
      }

      const levelOf = (row) => (manual[row.model] !== undefined
        ? manual[row.model]
        : (row.primary.usage === undefined || row.primary.usage === null ? 1 : row.primary.usage.level))

      const levelEditor = (row) => h('div', { className: 'llmm-mg-levels' },
        h('span', { className: 'llmm-mg-levels-label' }, t('levelManual')),
        h('button', {
          type: 'button',
          className: `llmm-mg-lvbtn${manual[row.model] === null ? ' llmm-mg-lvbtn-on' : ''}`,
          'aria-pressed': manual[row.model] === null,
          onClick: () => setManual({ ...manual, [row.model]: null }),
        }, t('levelAuto')),
        Array.from({ length: 7 }, (unused, index) => index + 1).map((level) => h('button', {
          key: level,
          type: 'button',
          className: `llmm-mg-lvbtn${manual[row.model] === level ? ' llmm-mg-lvbtn-on' : ''}`,
          'aria-pressed': manual[row.model] === level,
          onClick: () => setManual({ ...manual, [row.model]: level }),
        }, String(level))),
      )

      const catalogRow = (row) => {
        const route = row.primary
        const open = expandKeys.has(row.model)
        const level = levelOf(row)
        return h('div', { className: 'llmm-mg-item', key: row.model },
          h('div', { className: 'llmm-mg-row' },
            h('button', {
              type: 'button',
              className: 'llmm-mg-main',
              'aria-expanded': open,
              onClick: () => setExpandKeys((keys) => {
                const next = new Set(keys)
                if (next.has(row.model)) next.delete(row.model)
                else next.add(row.model)
                return next
              }),
            },
              h('span', { className: `llmm-dot ${statusTone(route.status)}` }),
              h('span', { className: 'llmm-mg-name' }, row.model),
              level > 0 && level !== null
                ? h('span', { className: `llmm-chip llmm-lv llmm-lv-${Math.min(level, 7)}` }, `${t('levelShort')}.${level}`)
                : null,
              h('span', { className: 'llmm-mg-sub' }, `${route.name ?? route.route} \u00b7 ${statusLabel(route.status)}`),
            ),
            h('div', { className: 'llmm-mg-acts' },
              h(IconButton, {
                icon: 'pin',
                label: route.pinned === true ? t('unpin') : t('pin'),
                active: route.pinned === true,
                filled: route.pinned === true,
                tip: tipChannel,
                pending: busy === `pins:${row.model}`,
                on: () => toggleList(row, 'pins'),
              }),
              h(IconButton, {
                icon: 'star',
                label: route.favorite === true ? t('unfavorite') : t('favorite'),
                active: route.favorite === true,
                filled: route.favorite === true,
                tip: tipChannel,
                pending: busy === `favorites:${row.model}`,
                on: () => toggleList(row, 'favorites'),
              }),
              h(IconButton, {
                icon: route.hidden === true ? 'eyeOff' : 'eye',
                label: route.hidden === true ? t('unhide') : t('hide'),
                active: route.hidden === true,
                tip: tipChannel,
                pending: busy === `hidden:${row.model}`,
                on: () => toggleList(row, 'hidden'),
              }),
              h(IconButton, {
                icon: 'pulse',
                label: t('probe'),
                danger: isProblem(route.status),
                tip: tipChannel,
                pending: busy === `probe:${row.model}`,
                on: () => probeOne(row),
              }),
            ),
          ),
          open
            ? h('div', { className: 'llmm-mg-detail' },
              h(ModelDetail, {
                row: { ...route, model: row.model },
                extra: h('div', { className: 'llmm-mg-extra' },
                  levelEditor(row),
                  h('button', {
                    type: 'button',
                    className: 'llmm-dlg-btn llmm-mg-remove',
                    disabled: busy !== '',
                    onClick: () => removeModel(row),
                  }, busy === `remove:${row.model}` ? t('managerSaving') : t('removeModel'))),
              }),
              row.routes.length > 1
                ? h('div', { className: 'llmm-mg-also' }, `${t('alsoOn')} ${row.routes.map((candidate) => candidate.route).join(' \u00b7 ')}`)
                : null,
            )
            : null,
        )
      }

      // A flat list of `route/model` strings told the user nothing about which
      // candidate can actually serve a turn, and once a provider ships twenty
      // models the list was long enough that picking one was a scroll hunt.
      // Order by whether the route answered, then by measured level, then name.
      const statusRank = { ok: 0, unknown: 1, protocol: 2, error: 3, retired: 4 }
      const candidates = rows
        .map((row) => ({
          key: `${row.primary.route}/${row.model}`,
          model: row.model,
          route: row.primary.route,
          routeName: row.primary.name ?? row.primary.route,
          status: row.primary.status,
          level: levelOf(row),
        }))
        .filter((entry) => !chain.includes(entry.key))
        .sort((left, right) => (statusRank[left.status] ?? 1) - (statusRank[right.status] ?? 1)
          || (right.level ?? 0) - (left.level ?? 0)
          || left.model.localeCompare(right.model))
      const needle = addQuery.trim().toLowerCase()
      const pickable = needle === ''
        ? candidates
        : candidates.filter((entry) => entry.key.toLowerCase().includes(needle))

      const removedEntries = Array.isArray(snap?.removed) ? snap.removed : []

      const directoryReads = (Array.isArray(snap?.directory) ? snap.directory : [])
        .filter((entry) => entry.ok === true)
      const catalogView = h(React.Fragment, null,
        h('div', { className: 'llmm-mg-toolbar' },
          h('input', {
            type: 'search',
            className: 'llmm-mg-search',
            placeholder: t('managerSearch'),
            value: query,
            'aria-label': t('managerSearch'),
            onChange: (event) => setQuery(event.target.value),
          }),
          h('select', {
            className: 'llmm-mg-filter',
            value: filter,
            'aria-label': t('managerFilter'),
            onChange: (event) => setFilter(event.target.value),
          }, [
            ['all', t('filterAll')],
            ['problem', t('filterProblem')],
            ['pinned', t('filterPinned')],
            ['starred', t('filterStarred')],
            ['hidden', t('filterHidden')],
          ].map(([value, label]) => h('option', { key: value, value }, label))),
          h('button', {
            type: 'button',
            className: 'llmm-dlg-btn',
            disabled: busy !== '' || shown.length === 0,
            onClick: probeAll,
          }, t('probeAll')),
        ),
        directoryReads.length === 0
          ? null
          : h('div', { className: 'llmm-mg-dirs' },
            // Only what was actually read. A route with no directory endpoint is not a
            // failure and has no action behind it — printing it once per route turned
            // the one fact worth reading ("this route, this many models, this fresh")
            // into fourteen lines of unreadable apology — lines that could not change
            // and had no action behind them. Provenance is worth one line; it is not
            // worth one line per route that cannot have any.
            directoryReads.map((entry) => h('span', {
              key: entry.route,
              className: 'llmm-mg-dir',
            }, t('pullStamp')
              .replace('{route}', entry.route)
              .replace('{count}', String(entry.count))
              .replace('{age}', ageOf(entry.at))))),
        shown.length === 0
          ? h('div', { className: 'llmm-mg-empty' }, t('managerEmpty'))
          : shown.map((row) => catalogRow(row)),
        removedEntries.length === 0
          ? null
          : h('div', { className: 'llmm-mg-removed' },
            h('div', { className: 'llmm-mg-removed-head' }, `${t('removedTitle')} \u00b7 ${removedEntries.length}`),
            removedEntries.map((entry) => h('div', { className: 'llmm-mg-row llmm-mg-removed-row', key: `${entry.route}/${entry.model}` },
              h('span', { className: 'llmm-mg-name' }, entry.model),
              h('span', { className: 'llmm-mg-sub' }, `${entry.route} \u00b7 ${entry.listed === true ? t('removedListed') : t('removedGone')}`),
              h('button', {
                type: 'button',
                className: 'llmm-dlg-btn llmm-mg-restore',
                disabled: busy !== '',
                onClick: () => restoreModel(entry),
              }, t('removedRestore'))))),
      )

      const policyRow = (key, label, note) => h('div', { className: 'llmm-policy-row', key },
        h('div', { className: 'llmm-policy-text' },
          h('span', { className: 'llmm-policy-label' }, t(label)),
          h('span', { className: 'llmm-policy-note' }, t(note))),
        h('button', {
          type: 'button',
          role: 'switch',
          'aria-checked': recovery[key] === true,
          'aria-label': t(label),
          className: `llmm-switch${recovery[key] === true ? ' llmm-switch-on' : ''}`,
          disabled: busy !== '',
          onClick: () => setPolicy(key),
        }, h('span', { className: 'llmm-switch-knob', 'aria-hidden': 'true' })))

      /**
       * One numeric ceiling, editable in place.
       *
       * Uncontrolled on purpose: the number is committed when the field loses focus, so
       * typing "1" on the way to "12" asks the host for nothing.
       */
      const policyNumber = (key, label, note, min, max) => h('div', { className: 'llmm-policy-row', key },
        h('div', { className: 'llmm-policy-text' },
          h('span', { className: 'llmm-policy-label' }, t(label)),
          h('span', { className: 'llmm-policy-note' }, t(note))),
        h('input', {
          type: 'number',
          className: 'llmm-policy-num',
          defaultValue: String(recovery[key] ?? ''),
          min,
          max,
          step: 1,
          'aria-label': t(label),
          disabled: busy !== '',
          onKeyDown: (event) => { if (event.key === 'Enter') event.currentTarget.blur() },
          onBlur: (event) => { commitPolicyNumber(key, event.target.value) },
        }))

      const failoverView = h(React.Fragment, null,
        h('section', { className: 'llmm-policy', 'aria-label': t('policyTitle') },
          h('div', { className: 'llmm-policy-head' }, t('policyTitle')),
          policyRow('retryFirst', 'policyRetry', 'policyRetryNote'),
          policyRow('autoContinue', 'policyContinue', 'policyContinueNote'),
          policyNumber('maxSwitches', 'policySwitches', 'policySwitchesNote', 0, 10),
          policyNumber('maxContinuations', 'policyContinuations', 'policyContinuationsNote', 0, 10),
          policyNumber('idleWaitMs', 'policyIdle', 'policyIdleNote', 50, 60000)),
        h('label', { className: 'llmm-fb-toggle' },
          h('input', {
            type: 'checkbox',
            checked: enabled,
            onChange: (event) => setEnabled(event.target.checked),
          }),
          h('span', null, t('fallbackToggle'))),
        chain.length === 0
          ? h('div', { className: 'llmm-mg-empty' }, t('fallbackEmpty'))
          : h('div', { className: 'llmm-fb-list' }, chain.map((entry, index) => h('div', { className: 'llmm-fb-item', key: entry },
            h('span', { className: 'llmm-fb-index' }, String(index + 1)),
            h('span', { className: 'llmm-fb-name' }, splitRef(entry).model),
            h('code', { className: 'llmm-fb-route' }, splitRef(entry).route),
            h('div', { className: 'llmm-mg-acts' },
              h('button', {
                type: 'button',
                className: 'llmm-ibtn',
                'aria-label': t('fallbackUp'),
                disabled: index === 0,
                onClick: () => moveInChain(index, -1),
              }, '\u2191'),
              h('button', {
                type: 'button',
                className: 'llmm-ibtn',
                'aria-label': t('fallbackDown'),
                disabled: index === chain.length - 1,
                onClick: () => moveInChain(index, 1),
              }, '\u2193'),
              h('button', {
                type: 'button',
                className: 'llmm-ibtn llmm-danger',
                'aria-label': t('fallbackRemove'),
                onClick: () => removeFromChain(index),
              }, '\u2715'),
            ),
          ))),
        h('div', { className: 'llmm-fb-add' },
          h('div', { className: 'llmm-fb-picker' },
            h('button', {
              type: 'button',
              className: 'llmm-dlg-btn llmm-fb-pick',
              'aria-haspopup': 'listbox',
              'aria-expanded': addOpen === true,
              'aria-label': t('fallbackPick'),
              onClick: () => { setAddOpen(addOpen !== true); setAddQuery('') },
            },
              h('span', { className: 'llmm-fb-pick-label' }, addKey === '' ? t('fallbackPick') : addKey),
              h('span', { className: 'llmm-fb-pick-caret', 'aria-hidden': 'true' }, '\u25be')),
            addOpen === true
              ? h('div', { className: 'llmm-fb-pop', role: 'listbox', 'aria-label': t('fallbackPick') },
                h('input', {
                  type: 'search',
                  className: 'llmm-mg-search llmm-fb-pop-search',
                  placeholder: t('managerSearch'),
                  value: addQuery,
                  'aria-label': t('managerSearch'),
                  onChange: (event) => setAddQuery(event.target.value),
                }),
                h('div', { className: 'llmm-fb-pop-list' },
                  pickable.length === 0
                    ? h('div', { className: 'llmm-mg-empty' }, t('managerEmpty'))
                    : pickable.map((entry) => h('button', {
                      key: entry.key,
                      type: 'button',
                      role: 'option',
                      'aria-selected': entry.key === addKey,
                      className: 'llmm-fb-opt' + (entry.key === addKey ? ' llmm-fb-opt-on' : '') + (entry.status === 'ok' ? '' : ' llmm-fb-opt-bad'),
                      onClick: () => { setAddKey(entry.key); setAddOpen(false) },
                    },
                      h('span', { className: `llmm-dot ${statusTone(entry.status)}`, 'aria-hidden': 'true' }),
                      h('span', { className: 'llmm-fb-opt-name' }, entry.model),
                      entry.level > 1
                        ? h('span', { className: `llmm-chip llmm-lv llmm-lv-${Math.min(entry.level, 7)}` }, `Lv.${entry.level}`)
                        : null,
                      h('span', { className: 'llmm-fb-opt-route' }, entry.routeName),
                      h('span', { className: 'llmm-fb-opt-flag' }, statusLabel(entry.status)),
                    )),
                ),
              )
              : null,
          ),
          h('button', {
            type: 'button',
            className: 'llmm-dlg-btn llmm-dlg-btn-primary llmm-fb-commit',
            disabled: addKey === '' || chain.length >= 12,
            onClick: addToChain,
          }, t('fallbackAdd')),
        ),
        h('ul', { className: 'llmm-fb-notes' },
          [t('fallbackNote1'), t('fallbackNote2'), t('fallbackNote3'), t('fallbackNote4')]
            .map((line, index) => h('li', { key: index }, line))),
        h('div', { className: 'llmm-fb-check' },
          h('button', { type: 'button', className: 'llmm-dlg-btn', onClick: checkChain }, t('checkChain')),
          checked === null
            ? null
            : h('ul', { className: 'llmm-fb-results' }, checked.map((result) => h('li', {
              key: result.entry,
              className: result.ok ? 'llmm-fb-ok' : 'llmm-fb-bad',
            }, `${result.entry} \u2014 ${result.why}`))),
        ),
      )

      // The history answers one question the other tabs cannot: which model keeps
      // failing. It is sorted by that count, and the aggregate sits above the raw
      // events so the answer is readable without scrolling a log.
      const outcomeLabel = (outcome) => {
        if (outcome === 'reached') return t('outcomeReached')
        if (outcome === 'ran-elsewhere') return t('outcomeElsewhere')
        return t('outcomeUnreached')
      }
      // Titles come from the Session list projection, not from our own log: the log
      // records the id it saw, and a Session that was renamed since must not keep
      // answering to its old name in the history.
      const useSessionRows = typeof props.useSessions === 'function' ? props.useSessions : useNoSessions
      const sessionRows = useSessionRows((state) => (state === undefined ? undefined : state.byId))
      const canOpenSession = typeof props.canOpenSession === 'function' && props.canOpenSession() === true
      const sessionLabel = (sessionId) => {
        const row = sessionRows === undefined ? undefined : sessionRows[sessionId]
        const label = typeof row?.displayTitle === 'string' && row.displayTitle !== '' ? row.displayTitle : row?.title
        if (typeof label === 'string' && label !== '') return label
        return String(sessionId ?? '').slice(0, 8)
      }

      // One row per raw record, reused by the incident cards and by the flat list.
      const switchEventRow = (record, index) => h('div', {
        className: 'llmm-sw-row llmm-sw-event',
        key: `${record.at}-${index}`,
      },
        h('span', { className: `llmm-dot ${record.outcome === 'reached' ? 'ok' : 'bad'}` }),
        h('span', { className: 'llmm-mg-name' }, record.from?.model ?? ''),
        h('span', { className: 'llmm-sw-arrow' }, '\u2192'),
        h('span', { className: 'llmm-mg-name' }, record.to?.model ?? ''),
        h('span', { className: 'llmm-mg-sub' }, `${statusLabel(record.reason)} \u00b7 ${outcomeLabel(record.outcome)}`),
        // The Session is where the failure happened, so the history row is the
        // only place a reader can go and look at it. The id stays in the title,
        // because two Sessions may share a title and the id is what is unique.
        typeof record.sessionId !== 'string' || record.sessionId === ''
          ? null
          : canOpenSession
            ? h('button', {
              type: 'button',
              className: 'llmm-sw-session',
              title: `${t('switchOpenSession')} \u00b7 ${record.sessionId}`,
              onClick: () => openSessionRow(record.sessionId),
            }, sessionLabel(record.sessionId))
            : h('span', {
              className: 'llmm-sw-session llmm-sw-session-flat',
              title: record.sessionId,
            }, sessionLabel(record.sessionId)),
        // Whether the work was picked back up separates a repair that rescued the
        // run from one that only moved it.
        typeof record.continued !== 'boolean'
          ? null
          : h('span', {
            className: `llmm-sw-sub llmm-sw-continued${record.continued === true ? ' llmm-sw-ok' : ''}`,
            title: typeof record.continueRefused === 'string' ? record.continueRefused : '',
          }, t(record.continued === true ? 'switchesContinued' : 'switchesNotContinued')),
        // Rows written before results could be written back can never resolve; saying
        // so beats leaving a reader to wonder why this one still says "did not take over".
        record.legacy === true
          ? h('span', { className: 'llmm-sw-legacy' }, t('switchesLegacy'))
          : null,
        h('span', { className: 'llmm-mg-when' }, record.at > 0 ? ageOf(record.at) : ''),
      )

      // Several rows from the same Session a minute apart are one incident — the same
      // dead model being retried — not three independent events. They collapse into a
      // card whose head states the outcome; the raw rows stay one click away because
      // they are the evidence and the summary is only the account of it.
      const incidents = []
      for (const record of failovers.records.slice(0, 24)) {
        const last = incidents[incidents.length - 1]
        const sameSession = last !== undefined
          && typeof record.sessionId === 'string'
          && record.sessionId === last.sessionId
        const recent = last !== undefined && Math.abs(last.at - (record.at ?? 0)) <= 5 * 60 * 1000
        if (sameSession && recent) {
          last.rows.push(record)
          last.at = Math.max(last.at, record.at ?? 0)
        } else {
          incidents.push({ sessionId: record.sessionId, at: record.at ?? 0, rows: [record] })
        }
      }

      const switchesView = h(React.Fragment, null,
        h('div', { className: 'llmm-sw-head' },
          h('span', { className: 'llmm-sw-title' }, t('switchesModels')),
          h('span', { className: 'llmm-dlg-gap' }),
          h('button', {
            type: 'button',
            className: 'llmm-dlg-btn llmm-sw-clear',
            disabled: busy !== '' || failovers.records.length === 0,
            onClick: clearSwitches,
          }, t('switchesClear'))),
        busy === 'clear-switches' && clearedAt > 0
          ? null
          : clearedAt > 0 && Date.now() - clearedAt < 30000
            ? h('div', { className: 'llmm-sw-undo' },
              h('span', null, t('switchesCleared')),
              h('button', { type: 'button', onClick: undoClearSwitches }, t('switchesUndo')))
            : null,
        failovers.records.length === 0
          ? h('div', { className: 'llmm-mg-empty' }, t('switchesEmpty'))
          : h(React.Fragment, null,
            h('div', { className: 'llmm-sw-models' }, failovers.models.map((stat) => h('div', {
              className: 'llmm-sw-row',
              key: `${stat.route}/${stat.model}`,
            },
              h('span', { className: 'llmm-sw-count' }, String(stat.switches)),
              h('span', { className: 'llmm-mg-name' }, stat.model),
              h('span', { className: 'llmm-sw-sub' }, `${t('switchesReached')} ${stat.reached}`),
              h('span', { className: 'llmm-sw-sub' }, `${t('switchesUnreached')} ${stat.unreached}`),
              stat.sessions > 0
                ? h('span', { className: 'llmm-sw-sub' }, `${stat.sessions} ${t('switchesSessions')}`)
                : null,
              // Only the leading cause earns a word here; the full histogram was a row
              // of counts nobody could act on.
              Object.keys(stat.reasons ?? {}).length === 0
                ? null
                : h('span', { className: 'llmm-mg-sub' }, statusLabel(
                  Object.keys(stat.reasons).sort((a, b) => stat.reasons[b] - stat.reasons[a])[0],
                )),
              h('span', { className: 'llmm-mg-when' }, stat.lastAt > 0 ? ageOf(stat.lastAt) : ''),
            ))),
            h('div', { className: 'llmm-sw-title' }, t('switchesRecent')),
            h('div', { className: 'llmm-sw-log llmm-sw-incs' }, incidents.map((incident, index) => {
              const head = incident.rows[0]
              const settled = incident.rows.some(entry => entry.outcome === 'reached')
              const open = openIncidents.has(index)
              return h('div', { className: 'llmm-sw-inc', key: `${incident.at}-${index}` },
                h('button', {
                  type: 'button',
                  className: 'llmm-sw-inc-head',
                  'aria-expanded': open,
                  onClick: () => setOpenIncidents((previous) => {
                    const next = new Set(previous)
                    if (next.has(index)) next.delete(index)
                    else next.add(index)
                    return next
                  }),
                },
                  h('span', { className: `llmm-dot ${settled ? 'ok' : 'bad'}` }),
                  typeof incident.sessionId === 'string' && incident.sessionId !== ''
                    ? h('span', { className: 'llmm-sw-session llmm-sw-session-flat' }, sessionLabel(incident.sessionId))
                    : null,
                  h('span', { className: 'llmm-sw-inc-steps' }, t('switchesSteps').replace('{count}', String(incident.rows.length))),
                  h('span', { className: 'llmm-sw-inc-path' },
                    `${head.from?.model ?? ''} \u2192 ${head.to?.model ?? ''}`),
                  h('span', { className: 'llmm-sw-sub' }, statusLabel(head.reason)),
                  h('span', { className: 'llmm-mg-when' }, incident.at > 0 ? ageOf(incident.at) : '')),
                open
                  ? h('div', { className: 'llmm-sw-inc-body' }, incident.rows.map(switchEventRow))
                  : null)
            })),
            ),
        h('div', { className: 'llmm-sw-note' }, t('switchesNote')),
      )

      const recordsView = records.length === 0
        ? h('div', { className: 'llmm-mg-empty' }, t('recordsEmpty'))
        : h('div', { className: 'llmm-mg-records' }, records.map((record, index) => h('div', {
          className: 'llmm-mg-row llmm-mg-record',
          key: `${record.model}-${record.at}-${index}`,
        },
          h('span', { className: `llmm-dot ${statusTone(record.status)}` }),
          h('span', { className: 'llmm-mg-name' }, record.model),
          h('span', { className: 'llmm-mg-sub' }, `${record.route} \u00b7 ${record.detail !== undefined && record.detail !== '' ? record.detail : statusLabel(record.status)}`),
          h('span', { className: 'llmm-mg-when' }, record.at > 0 ? ageOf(record.at) : ''),
        )))

      return h(React.Fragment, null,
        h('div', {
          className: 'llmm-dlg-mask',
          onMouseDown: (event) => { if (event.target === event.currentTarget) attemptClose() },
        },
          h('div', {
            className: 'llmm-dlg',
            role: 'dialog',
            'aria-modal': 'true',
            'aria-label': t('managerTitle'),
            tabIndex: -1,
            ref: panelRef,
            onKeyDown: (event) => {
              if (event.key === 'Escape') {
                event.stopPropagation()
                attemptClose()
              }
            },
          },
            h('div', { className: 'llmm-dlg-head' },
              h('span', { className: 'llmm-dlg-title' }, t('managerTitle')),
              h('span', { className: 'llmm-dlg-count' }, `${shown.length}/${rows.length}`),
              h('span', { className: 'llmm-dlg-gap' }),
              h(IconButton, {
                icon: 'refresh',
                label: t('pullDir'),
                className: 'llmm-dlg-pull',
                pending: busy === 'pull',
                disabled: busy !== '',
                tip: tipChannel,
                on: pull,
              }),
              h('button', {
                type: 'button',
                className: 'llmm-ibtn llmm-dlg-close',
                'aria-label': t('panelClose'),
                title: t('panelClose'),
                onClick: attemptClose,
              }, '\u2715'),
            ),
            h('div', { className: 'llmm-dlg-tabs', role: 'tablist' },
              [['catalog', t('tabCatalog')], ['failover', t('tabFailover')], ['switches', t('tabSwitches')], ['records', t('tabRecords')]]
                .map(([key, label]) => h('button', {
                  key,
                  type: 'button',
                  role: 'tab',
                  'aria-selected': tab === key,
                  className: `llmm-tab${tab === key ? ' llmm-tab-on' : ''}`,
                  onClick: () => { setTab(key); managerStore.setTab(key); setNote(''); setError('') },
                }, label))),
            stale ? h('div', { className: 'llmm-dlg-stale', role: 'status' }, t('hostStale')) : null,
            h('div', { className: 'llmm-dlg-body' },
              tab === 'catalog' ? catalogView : null,
              tab === 'failover' ? failoverView : null,
              tab === 'switches' ? switchesView : null,
              tab === 'records' ? recordsView : null),
            h('div', { className: 'llmm-dlg-foot' },
              note !== '' ? h('span', { className: 'llmm-dlg-note' }, note) : null,
              error !== '' ? h('span', { className: 'llmm-dlg-err', role: 'alert' }, error) : null,
              dirty ? h('span', { className: 'llmm-dlg-dirty' }, t('managerDirty')) : null,
              h('button', { type: 'button', className: 'llmm-dlg-btn', onClick: attemptClose }, t('managerCancel')),
              h('button', {
                type: 'button',
                className: 'llmm-dlg-btn llmm-dlg-btn-primary',
                disabled: dirty !== true || busy !== '',
                onClick: save,
              }, busy === 'save' ? t('managerSaving') : t('managerSave'))),
          ),
        ),
        tip !== null
          ? createPortal(h('div', {
            className: 'llmm-tip',
            style: { left: `${tip.x}px`, top: `${tip.y}px` },
            role: 'tooltip',
          }, tip.text), document.body)
          : null,
        askDiscard
          ? h('div', { className: 'llmm-dlg-mask llmm-dlg-ask' },
            h('div', {
              className: 'llmm-dlg llmm-dlg-small',
              role: 'alertdialog',
              'aria-modal': 'true',
              'aria-label': t('managerDiscardTitle'),
            },
              h('div', { className: 'llmm-dlg-head' },
                h('span', { className: 'llmm-dlg-title' }, t('managerDiscardTitle'))),
              h('div', { className: 'llmm-dlg-body' },
                h('p', { className: 'llmm-dlg-copy' }, t('managerDiscardBody'))),
              h('div', { className: 'llmm-dlg-foot' },
                h('button', { type: 'button', className: 'llmm-dlg-btn', onClick: () => setAskDiscard(false) }, t('managerKeep')),
                h('button', { type: 'button', className: 'llmm-dlg-btn llmm-dlg-btn-danger', onClick: discardAndClose }, t('managerDiscard')),
              ),
            ),
          )
          : null,
      )
    }

    // ── The shipped picker's inline label ──

    /**
     * Mount the plugin stylesheet once into <head>.
     *
     * Every other surface of this plugin renders `<Style/>` inside its own subtree, and
     * that is not enough here: the label lives inside the SHIPPED picker, whose subtree
     * this plugin does not own, and in `native` mode no other surface of ours may be
     * mounted at all. One `<style>` per row would multiply a 20 KB sheet by the size of
     * the catalogue, so it is mounted once and re-found by its attribute.
     */
    function ensureStylesheet() {
      if (typeof document === 'undefined') return
      if (document.querySelector('style[data-llmm-style]') !== null) return
      const tag = document.createElement('style')
      tag.setAttribute('data-llmm-style', '')
      tag.textContent = CSS
      document.head.appendChild(tag)
    }

    /** Resolve a catalog badge's text: one literal, or translations keyed by language. */
    function badgeText(text) {
      if (typeof text === 'string') return text
      if (text === null || typeof text !== 'object') return ''
      const full = LANG.toLowerCase()
      const short = full.split('-')[0]
      const value = text[full] ?? text[short] ?? text.en
      return typeof value === 'string' ? value : ''
    }

    const BADGE_TTL_MS = 60 * 1000
    const NO_BADGES = new Map()

    /**
     * Per-model health and proficiency, shared by every label on screen.
     *
     * Module scope rather than component state: the label mounts once per picker row,
     * so per-component fetching would be a stampede. The Host answers from its overlay
     * (`badges`), which is why this can refresh on a minute at all.
     */
    const badgeStore = (() => {
      let rows = NO_BADGES
      let at = 0
      let inflight = null
      const listeners = new Set()
      const emit = () => { for (const listener of listeners) listener() }
      const load = () => {
        if (inflight !== null) return inflight
        if (at !== 0 && Date.now() - at < BADGE_TTL_MS) return Promise.resolve(rows)
        inflight = callHost({ action: 'badges' })
          .then((data) => {
            const list = Array.isArray(data?.value) ? data.value : []
            rows = new Map(list
              .filter(row => row !== null && typeof row === 'object'
                && typeof row.route === 'string' && typeof row.model === 'string')
              .map(row => [`${row.route}/${row.model}`, row]))
            at = Date.now()
          })
          // A badge is decoration: an older Host that cannot answer leaves the label
          // drawn exactly as the shipped fallback would have drawn it.
          .catch(() => { at = Date.now() })
          .then(() => {
            inflight = null
            emit()
          })
        return inflight
      }
      return {
        subscribe: (listener) => {
          listeners.add(listener)
          return () => listeners.delete(listener)
        },
        get: () => rows,
        load,
      }
    })()

    /**
     * Read the badge map, asking the Host once when it is cold.
     * @returns {Map<string, object>} badge rows keyed `route/model`.
     */
    function useBadges() {
      const rows = useSyncExternalStore(badgeStore.subscribe, badgeStore.get, badgeStore.get)
      useEffect(() => { badgeStore.load() }, [])
      return rows
    }

    /**
     * This plugin's marks inside the shipped picker's model name.
     *
     * A contribution REPLACES the owner's fallback body, so the model name — and the
     * catalog badge the fallback draws with the owner's own tag — are this component's
     * responsibility: returning null would delete the name from the composer. Only the
     * marks are added here; selection stays entirely the owner's.
     *
     * @param {object} props - `ModelLabelOwner`: provider, model, placement, selected.
     * @returns {object} the label.
     */
    function ModelLabel(props) {
      const provider = props && props.provider !== null && typeof props.provider === 'object' ? props.provider : {}
      const model = props && props.model !== null && typeof props.model === 'object' ? props.model : {}
      const placement = typeof props?.placement === 'string' ? props.placement : 'option'
      useEffect(() => { ensureStylesheet() }, [])
      const rows = useBadges()
      const row = rows.get(`${provider.id}/${model.id}`)
      const status = typeof row?.status === 'string' ? row.status : 'unknown'
      const level = typeof row?.level === 'number' ? row.level : 0
      const uses = typeof row?.uses === 'number' ? row.uses : 0
      const name = typeof model.name === 'string' && model.name !== ''
        ? model.name
        : typeof model.id === 'string' ? model.id : ''
      const badge = badgeText(model.badge === undefined ? undefined : model.badge.text)
      return h('span', { className: 'llmm-label', 'data-placement': placement },
        h('span', { className: 'llmm-label-name' }, name),
        badge === '' ? null : h('span', { className: 'llmm-chip llmm-label-badge' }, badge),
        // The collapsed trigger carries the one mark worth interrupting for: a known
        // problem, with its reason on hover. The level is earned by use, so an untouched
        // model claims nothing and the trigger keeps the width the owner budgeted.
        isProblem(status)
          ? h('span', { className: `llmm-dot ${statusTone(status)}`, title: statusLabel(status) })
          : null,
        placement !== 'trigger' && uses > 0 && level > 1
          ? h('span', { className: `llmm-chip llmm-lv llmm-lv-${Math.min(level, 7)}` }, `Lv.${level}`)
          : null,
      )
    }


    // -- The composer controller --------------------------------------------

    /** Rail copy for each submit phase. */
    const PHASE_LABEL = {
      adjudicating: 'ctlAdjudicating',
      claimed: 'ctlClaimed',
      submitting: 'ctlSubmitting',
      sending: 'ctlSending',
    }

    /**
     * Format an elapsed span for the running rail.
     * @param {number} ms - elapsed milliseconds.
     * @returns {string} `m:ss`.
     */
    function clockText(ms) {
      const total = Math.max(0, Math.floor(ms / 1000))
      const minutes = Math.floor(total / 60)
      const seconds = total % 60
      return `${minutes}:${seconds < 10 ? '0' : ''}${seconds}`
    }

    /**
     * The composer controller: a rail that changes shape with the session, and the
     * command palette it opens.
     *
     * It is additive on purpose. `conversation.composer.bar` owns the editor — IME
     * composition, paste, slash adjudication, @-mentions, attachment drops, local
     * echo, the hero variant — and replacing it would mean reimplementing all of
     * that, plus losing every shipped `conversation.input.*` seat that renders
     * inside it. This sits in `conversation.input.dock`, directly above the card,
     * and reads the same live input state the editor publishes, so it reacts
     * without owning a keystroke.
     *
     * Shapes: idle collapses to a breathing hairline, a draft expands to a meter,
     * a submit in flight names its phase, a running turn becomes a capsule with a
     * clock, and a turn waiting on the user says so.
     *
     * @param {object} props - slot props: `sessionId`, `useInput`,
     *   `useSessionStatus`, `inputActions`, plus the model directory the
     *   registration wrapper adds.
     * @returns {object|null} the rail, and the palette while it is open.
     */
    function ComposerController(props) {
      const sessionId = typeof props?.sessionId === 'string' ? props.sessionId : ''
      // Read the hooks through locals: a partial Host (or the test harness) must not
      // change the hook count between renders.
      const useInputHook = typeof props?.useInput === 'function' ? props.useInput : () => null
      const useStatusHook = typeof props?.useSessionStatus === 'function' ? props.useSessionStatus : () => undefined
      const input = useInputHook(state => state)
      const status = useStatusHook(map => (sessionId === '' ? undefined : map.get(sessionId)))
      const actions = props?.inputActions ?? null

      const directory = useMemo(() => {
        const models = props?.modelDirectories
        if (sessionId === '' || models === undefined || models === null) return null
        try {
          const found = models.directoryFor(sessionId)
          return found !== null && typeof found === 'object' ? found : null
        } catch { return null }
      }, [props?.modelDirectories, sessionId])

      const store = directory === null ? null : directory.store ?? null
      // Directory stores are shipped objects, but this rail renders in EVERY session:
      // one throwing store must not take the composer entry down with it.
      const subscribe = useCallback(listener => {
        if (store === null) return () => {}
        try {
          const off = store.subscribe(listener)
          return typeof off === 'function' ? off : () => {}
        } catch { return () => {} }
      }, [store])
      const snapshot = useCallback(() => {
        if (store === null) return null
        try { return store.getSnapshot() } catch { return null }
      }, [store])
      const catalogState = useSyncExternalStore(subscribe, snapshot, snapshot)

      const railRef = useRef(null)
      const paletteRef = useRef(null)
      const [open, setOpen] = useState(false)
      const [cursor, setCursor] = useState(0)
      const [busy, setBusy] = useState('')
      const [note, setNote] = useState('')
      const [startedAt, setStartedAt] = useState(0)
      const [now, setNow] = useState(() => Date.now())

      useEffect(() => { ensureStylesheet() }, [])

      const running = status !== undefined && status !== null && status.running === true
      const waiting = status !== undefined && status !== null
        && status.pendingInteraction !== undefined && status.pendingInteraction !== null
      const phase = typeof input?.phase === 'string' ? input.phase : 'plain'
      const draft = typeof input?.draft === 'string' ? input.draft : ''
      const attachments = Array.isArray(input?.attachmentIds) ? input.attachmentIds.length : 0
      const queued = Array.isArray(input?.queue) ? input.queue.length : 0
      const mode = running
        ? 'running'
        : phase !== 'plain'
          ? 'busy'
          : draft !== '' || attachments > 0 ? 'draft' : 'idle'

      // One clock, started when the turn starts and only ticked while it runs.
      useEffect(() => {
        if (running) {
          setStartedAt(value => (value === 0 ? Date.now() : value))
          setNow(Date.now())
          return undefined
        }
        setStartedAt(0)
        return undefined
      }, [running])
      useEffect(() => {
        if (!running) return undefined
        const timer = setInterval(() => setNow(Date.now()), 1000)
        return () => clearInterval(timer)
      }, [running])

      const current = catalogState !== null && typeof catalogState === 'object' ? catalogState.current : null
      const route = typeof current?.provider === 'string' ? current.provider : ''
      const model = typeof current?.model === 'string' ? current.model : ''
      const activeEffort = typeof current?.reasoningEffort === 'string' ? current.reasoningEffort : undefined
      // The shipped directory carries the levels; read them here rather than through
      // the picker's index, which only exists while that menu is mounted.
      const efforts = useMemo(() => {
        if (catalogState === null || route === '' || model === '') return []
        const groups = Array.isArray(catalogState.groups) ? catalogState.groups : []
        const group = groups.find(candidate => candidate?.id === route)
        const models = group === undefined || !Array.isArray(group.models) ? [] : group.models
        const entry = models.find(candidate => candidate?.id === model)
        const list = entry?.reasoning?.efforts
        return Array.isArray(list) ? list : []
      }, [catalogState, route, model])
      const defaultEffort = useMemo(() => {
        if (catalogState === null || route === '' || model === '') return undefined
        const groups = Array.isArray(catalogState.groups) ? catalogState.groups : []
        const group = groups.find(candidate => candidate?.id === route)
        const models = group === undefined || !Array.isArray(group.models) ? [] : group.models
        const found = models.find(candidate => candidate?.id === model)
        const level = found?.reasoning?.defaultEffort
        return typeof level === 'string' ? level : undefined
      }, [catalogState, route, model])
      const nameOf = id => (id === undefined ? undefined : (efforts.find(level => level.id === id)?.name ?? id))
      const defaultName = nameOf(defaultEffort)

      const close = useCallback(() => { setOpen(false); setNote('') }, [])
      const togglePalette = useCallback(() => {
        setNote('')
        setOpen(value => !value)
      }, [])

      const switchEffort = async (effort) => {
        if (directory === null || route === '' || model === '') return
        setBusy('effort')
        try {
          await directory.select({
            provider: route,
            model,
            ...(effort === undefined ? {} : { reasoningEffort: effort }),
          })
          close()
        } catch { setNote(t('paletteSwitchFailed')) } finally { setBusy('') }
      }

      const probe = async () => {
        if (route === '' || model === '') return
        setBusy('probe')
        try {
          await callHost({ action: 'probe', route, model })
          setNote(t('paletteProbed'))
          if (directory !== null && typeof directory.load === 'function') directory.load()
        } catch { setNote(t('paletteProbeFailed')) } finally { setBusy('') }
      }

      const copyId = async () => {
        if (sessionId === '') return
        try {
          await navigator.clipboard.writeText(sessionId)
          setNote(t('paletteCopied'))
        } catch { setNote(sessionId) }
      }

      // ── the palette's model ──
      // A tree, not one flat list. The root answers "what can I do here"; a page is
      // entered only when a command needs a choice. The reasoning levels used to sit
      // in the root, where eight stops of one setting outnumbered every other command
      // and pushed them off the first screen — that is what made this read as a
      // second copy of the level picker instead of a command list.
      const levelNow = activeEffort === undefined ? t('ctlAuto') : (nameOf(activeEffort) ?? activeEffort)
      const [query, setQuery] = useState('')
      const [page, setPage] = useState('root')
      const [result, setResult] = useState(null)
      const searchRef = useRef(null)

      // The batch probe targets the route the session is on. The dialog's "probe all"
      // means "what is on screen"; there is no screen here, so "this route" is the
      // only scope that means something.
      const routeModels = useMemo(() => {
        if (catalogState === null || route === '') return []
        const groups = Array.isArray(catalogState.groups) ? catalogState.groups : []
        const group = groups.find(candidate => candidate?.id === route)
        const models = group === undefined || !Array.isArray(group.models) ? [] : group.models
        return models
          .filter(entry => typeof entry?.id === 'string' && entry.id !== '')
          .map(entry => ({ route, model: entry.id }))
      }, [catalogState, route])

      const levelItems = useMemo(() => {
        const list = efforts.map(level => ({
          key: `level-${level.id}`,
          label: typeof level.name === 'string' && level.name !== '' ? level.name : level.id,
          hint: level.id === activeEffort ? t('paletteCurrent') : '',
          alias: `level effort ${level.id} 档位`,
          run: async () => {
            await directory.select({ provider: route, model, reasoningEffort: level.id })
          },
        }))
        list.push({
          key: 'level-auto',
          label: t('ctlAuto'),
          hint: activeEffort === undefined ? t('paletteCurrent') : (defaultName ?? ''),
          alias: 'auto default 自动 默认 省略',
          run: async () => {
            await directory.select({ provider: route, model })
          },
        })
        return list
      }, [efforts, activeEffort, defaultName, directory, route, model])

      const groups = useMemo(() => {
        const session = []
        const modelGroup = []
        const diag = []
        const manage = []
        if (actions !== null && typeof actions.submit === 'function') {
          session.push({
            key: 'send',
            label: t('paletteSend'),
            hint: '\u23ce',
            alias: 'send submit 发送 提交',
            disabled: draft.trim() === '' || phase !== 'plain',
            run: async () => { actions.submit() },
          })
        }
        if (actions !== null && typeof actions.setDraft === 'function') {
          session.push({
            key: 'clear',
            label: t('paletteClear'),
            hint: '\u232b',
            alias: 'clear wipe 清空 清除',
            disabled: draft === '',
            run: async () => { actions.setDraft('') },
          })
        }
        if (sessionId !== '') {
          session.push({
            key: 'copy-id',
            label: t('paletteCopyId'),
            hint: sessionId.slice(0, 8),
            alias: 'copy id session 复制 会话',
            answer: true,
            run: async () => {
              try {
                await navigator.clipboard.writeText(sessionId)
                return t('paletteCopied')
              } catch { return sessionId }
            },
          })
        }
        modelGroup.push({
          key: 'levels',
          label: `${t('ctlEffort')} \u00b7 ${levelNow}`,
          hint: '\u203a',
          alias: 'level effort reasoning 档位 推理 思考',
          disabled: efforts.length === 0,
          fail: t('paletteNoLevels'),
          open: 'levels',
        })
        if (route !== '' && model !== '') {
          modelGroup.push({
            key: 'probe',
            label: t('paletteProbe'),
            hint: `${route}/${model}`,
            alias: 'probe health 探活 检测 健康',
            answer: true,
            fail: t('paletteProbeFailed'),
            run: async () => {
              await callHost({ action: 'probe', route, model })
              if (directory !== null && typeof directory.load === 'function') directory.load()
              return t('paletteProbed')
            },
          })
          modelGroup.push({
            key: 'probe-all',
            label: t('paletteProbeAll'),
            hint: String(routeModels.length),
            alias: 'probe all batch 批量 全部 探活',
            answer: true,
            fail: t('paletteProbeFailed'),
            disabled: routeModels.length === 0,
            run: async () => {
              await callHost({ action: 'probeBatch', targets: routeModels })
              return t('paletteProbeAllSent')
            },
          })
        }
        diag.push({
          key: 'sync',
          label: t('paletteSync'),
          hint: '',
          alias: 'sync refresh gateway catalogue 刷新 重拉 目录',
          answer: true,
          run: async () => {
            await callHost({ action: 'snapshot', forceDirectory: true })
            if (directory !== null && typeof directory.load === 'function') directory.load()
            return t('paletteSyncDone')
          },
        })
        diag.push({
          key: 'failover-log',
          label: t('paletteFailoverLog'),
          hint: '\u203a',
          alias: 'failover fallback log 故障 切换 降级',
          run: async () => { openManager('failover') },
        })
        diag.push({
          key: 'probe-records',
          label: t('paletteProbeRecords'),
          hint: '\u203a',
          alias: 'probe records log 探活 记录 历史',
          run: async () => { openManager('records') },
        })
        manage.push({
          key: 'manager',
          label: t('managerOpen'),
          hint: '\u2318\u21e7M',
          alias: 'manage models dialog catalog 管理 模型',
          run: async () => { openManager('catalog') },
        })
        return [
          { id: 'session', title: t('paletteGroupSession'), items: session },
          { id: 'model', title: t('paletteGroupModel'), items: modelGroup },
          { id: 'diag', title: t('paletteGroupDiag'), items: diag },
          { id: 'manage', title: t('paletteGroupManage'), items: manage },
        ].filter(group => group.items.length > 0)
      }, [actions, draft, phase, sessionId, efforts.length, levelNow, route, model, routeModels, directory, openManager, t])

      // Subsequence matching, not substring: "th" finds 探活 and "mdl" finds the
      // dialog row, which is what makes typing an alias faster than reading a list.
      const shown = useMemo(() => {
        const match = (item) => {
          const needle = query.trim().toLowerCase()
          if (needle === '') return true
          const hay = `${item.label} ${item.hint ?? ''} ${item.alias ?? ''}`.toLowerCase()
          let at = 0
          for (const character of needle) {
            if (character === ' ') continue
            const found = hay.indexOf(character, at)
            if (found < 0) return false
            at = found + 1
          }
          return true
        }
        const pages = page === 'root'
          ? groups
          : [{ id: 'levels', title: '', items: levelItems }]
        const filtered = pages
          .map(group => ({ ...group, items: group.items.filter(match) }))
          .filter(group => group.items.length > 0)
        let index = 0
        // The flat index is what the arrow keys walk; group headers are not stops.
        return filtered.map(group => ({
          ...group,
          items: group.items.map(item => ({ ...item, index: index++ })),
        }))
      }, [groups, levelItems, page, query])
      const flat = useMemo(() => shown.flatMap(group => group.items), [shown])

      const busyRef = useRef('')
      busyRef.current = busy

      const answer = async (item) => {
        if (item === null || item === undefined) return
        if (item.disabled === true || busyRef.current !== '') return
        if (typeof item.open === 'string') {
          setPage(item.open)
          setQuery('')
          setCursor(0)
          return
        }
        // A command that answers stays open to show the answer; one that acts closes,
        // because the composer is where its result lands.
        if (item.answer !== true) { close(); setOpen(false) }
        setBusy(item.key)
        setResult(null)
        try {
          const text = await item.run()
          if (typeof text === 'string' && text !== '') setResult({ key: item.key, text, ok: true })
        } catch (failure) {
          const text = isStaleHost(failure)
            ? t('hostStale')
            : (typeof item.fail === 'string' ? item.fail : t('paletteFailed'))
          setResult({ key: item.key, text, ok: false })
        } finally {
          setBusy('')
        }
      }
      const answerRef = useRef(answer)
      answerRef.current = answer
      const flatRef = useRef(flat)
      flatRef.current = flat
      const cursorRef = useRef(cursor)
      cursorRef.current = cursor
      const pageRef = useRef(page)
      pageRef.current = page
      const queryRef = useRef(query)
      queryRef.current = query

      useEffect(() => {
        if (!open) return
        const node = searchRef.current
        if (node !== null && typeof node.focus === 'function') node.focus()
      }, [open, page])

      // One document listener: the shortcut has to reach us even while the editor
      // owns the focus, and while the palette is open Enter must not also submit.
      useEffect(() => {
        if (typeof document === 'undefined') return undefined
        const onKeyDown = (event) => {
          const meta = event.metaKey || event.ctrlKey
          // Shift+letter reaches the same dialog from anywhere in the session, which
          // is the only route to it while the shipped picker owns the model seat.
          if (meta && event.shiftKey && !event.altKey && (event.key === 'm' || event.key === 'M')) {
            event.preventDefault()
            close()
            openManager('catalog')
            return
          }
          if (meta && !event.altKey && (event.key === 'k' || event.key === 'K' || event.key === 'j' || event.key === 'J')) {
            event.preventDefault()
            setNote('')
            setResult(null)
            setQuery('')
            setPage('root')
            setCursor(0)
            setOpen(value => !value)
            return
          }
          if (!open) return
          const back = () => {
            setPage('root')
            setQuery('')
            setCursor(0)
          }
          if (event.key === 'Escape') {
            event.preventDefault()
            // Three shelves: the page, the search word, then the panel itself.
            if (pageRef.current !== 'root') back()
            else if (queryRef.current !== '') { setQuery(''); setCursor(0) }
            else close()
            return
          }
          if (event.key === 'Backspace' && queryRef.current === '' && pageRef.current !== 'root') {
            event.preventDefault()
            back()
            return
          }
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault()
            const list = flatRef.current
            if (list.length === 0) return
            const step = event.key === 'ArrowDown' ? 1 : -1
            setCursor(value => (value + step + list.length) % list.length)
            return
          }
          if (event.key === 'Enter') {
            const item = flatRef.current[cursorRef.current]
            if (item === undefined) return
            event.preventDefault()
            event.stopPropagation()
            answerRef.current(item)
          }
        }
        document.addEventListener('keydown', onKeyDown, true)
        // A palette is dismissed by leaving it, not only with Esc. The panel is fixed
        // (the composer card would clip an anchored popover), so "outside" is decided
        // against the panel node itself; the rail stays exempt so its own button can
        // still toggle the panel shut.
        const onPointerDown = (event) => {
          const panel = paletteRef.current
          const railNode = railRef.current
          if (panel !== null && panel.contains(event.target)) return
          if (railNode !== null && railNode.contains(event.target)) return
          setOpen(false)
          setNote('')
          setResult(null)
        }
        document.addEventListener('pointerdown', onPointerDown, true)
        return () => {
          document.removeEventListener('keydown', onKeyDown, true)
          document.removeEventListener('pointerdown', onPointerDown, true)
        }
      }, [open, close, openManager])

      const parts = []
      if (mode === 'running') parts.push(`${t('ctlRunning')} ${clockText(now - startedAt)}`)
      else if (mode === 'busy') parts.push(t(PHASE_LABEL[phase] ?? 'ctlSending'))
      else if (mode === 'draft') parts.push(`${t('ctlDraft')} ${draft.trim().length} ${t('ctlChars')}`)
      else parts.push(t('ctlIdle'))
      if (waiting) parts.push(t('ctlWaiting'))
      if (attachments > 0) parts.push(`${attachments} ${t('ctlAttach')}`)
      if (queued > 0) parts.push(`${queued} ${t('ctlQueued')}`)

      // Inline, inside the composer card. Only what the session is doing right now
      // gets drawn; the two entries stay put.
      const worth = mode !== 'idle' || waiting || attachments > 0 || queued > 0
      const rail = h('div', { className: 'llmm-ctl', 'data-mode': mode, ref: railRef },
        worth ? h('span', { className: 'llmm-ctl-dot', 'aria-hidden': true }) : null,
        worth
          ? h('span', { className: 'llmm-ctl-text', role: 'status', 'aria-live': 'polite' }, parts.join(' \u00b7 '))
          : null,
        // No level control here on purpose: the model trigger a few pixels away
        // already names the level and opens the panel that owns it. Two controls for
        // one fact read as two different facts — that is what made this cluster look
        // like a second, competing model switcher.
        h('button', {
          type: 'button',
          className: 'llmm-ctl-icon',
          'aria-label': t('managerOpen'),
          title: `${t('managerOpen')} \u00b7 \u2318\u21e7M`,
          onClick: () => { close(); openManager() },
        }, h(Icon, { name: 'sliders' })),
        h('button', {
          type: 'button',
          className: 'llmm-ctl-key',
          'aria-label': t('ctlPaletteOpen'),
          title: t('ctlPaletteOpen'),
          onClick: togglePalette,
        }, t('ctlKey')),
      )

      const palette = open
        ? createPortal(h('div', {
          className: 'llmm-pal',
          ref: paletteRef,
          role: 'dialog',
          'aria-label': t('paletteTitle'),
          'aria-busy': busy !== '',
          onMouseDown: event => { if (event.target === event.currentTarget) close() },
        },
          h('div', { className: 'llmm-pal-head' },
            page === 'root'
              ? h('input', {
                className: 'llmm-pal-search',
                ref: searchRef,
                type: 'search',
                value: query,
                placeholder: t('paletteSearch'),
                'aria-label': t('paletteSearch'),
                onChange: event => { setQuery(event.target.value); setCursor(0) },
              })
              : h('button', {
                type: 'button',
                className: 'llmm-pal-back',
                onClick: () => { setPage('root'); setQuery(''); setCursor(0) },
              }, `\u2039 ${t('ctlEffort')}`),
            h('span', {
              className: `llmm-pal-note${result !== null && result.ok === false ? ' llmm-pal-bad' : ''}`,
              role: 'status',
              'aria-live': 'polite',
            }, result !== null ? result.text : (busy !== '' ? t('paletteWorking') : 'esc')),
          ),
          h('ul', { className: 'llmm-pal-list', role: 'listbox', 'aria-label': t('paletteTitle') },
            shown.length === 0
              ? h('li', { className: 'llmm-pal-empty' }, t('paletteEmpty'))
              : shown.flatMap(group => [
                h('li', { key: `g-${group.id}`, className: 'llmm-pal-group', role: 'presentation' }, group.title),
                ...group.items.map(item => {
                  const running = busy === item.key
                  const answered = result !== null && result.key === item.key ? result.text : ''
                  return h('li', {
                    key: item.key,
                    className: `llmm-pal-item${item.index === cursor ? ' llmm-pal-on' : ''}${item.disabled === true ? ' llmm-pal-off' : ''}`,
                    role: 'option',
                    'aria-selected': item.index === cursor,
                    'aria-disabled': item.disabled === true,
                  },
                    h('button', {
                      type: 'button',
                      className: 'llmm-pal-run',
                      disabled: item.disabled === true || (busy !== '' && !running),
                      onMouseEnter: () => setCursor(item.index),
                      onClick: () => { answer(item) },
                    },
                      h('span', { className: 'llmm-pal-label' }, item.label),
                      running ? h('span', { className: 'llmm-pal-spin', 'aria-hidden': true }) : null,
                      answered !== ''
                        ? h('span', {
                          className: `llmm-pal-hint ${result !== null && result.ok === false ? 'llmm-pal-bad' : 'llmm-pal-ok'}`,
                        }, answered)
                        : (item.hint === '' || running ? null : h('span', { className: 'llmm-pal-hint' }, item.hint)),
                    ),
                  )
                }),
              ]),
          ),
        ), document.body)
        : null

      return h(React.Fragment, null, rail, palette)
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

        // The composer controls: the two entries and the live status, inside the card
        // just before the submit action. The shipped bar keeps every behaviour it
        // owns; only the model seat is ours (selector.mode: managed).
        ctx.slots.inject('conversation.input.right', () => ctx.slots.register({
          name: 'conversation.input.right',
          id: 'llm-manage-rail',
          order: 0,
        }, props => h(ComposerController, { modelDirectories: ctx.modelDirectories, ...props })))

        // The manager dialog rides the shell overlay: it is a profile-wide surface
        // (one catalog, one fallback policy), so it must not be clipped by the
        // composer row or by the sidebar column.
        try {
          ctx.slots.inject('shell.overlay', () => ctx.slots.register({
            name: 'shell.overlay',
            id: 'llm-manage-manager',
            order: 30,
          }, props => h(ManagerDialog, {
            ...props,
            // One navigation action, the same call the shipped sidebar makes: selecting a
            // Session and showing it. Refused rather than thrown when the face is absent,
            // because a history row that cannot navigate is still worth reading.
            openSession: (sessionId) => {
              try {
                uiWorkspace?.openSession?.(sessionId)
              } catch {
                // Navigation is best effort; the row stays as it was.
              }
            },
            // A name that cannot go anywhere must not look clickable: the row still
            // names the Session, it just stops pretending to be a link. The overlay may
            // answer this itself; when it does not, the navigator's presence decides.
            canOpenSession: typeof props.canOpenSession === 'function'
              ? props.canOpenSession
              : () => uiWorkspace !== null,
          })))
        } catch {
          // A client without the shell overlay keeps the settings panel, which
          // reaches every action this dialog offers.
        }

        // The plugin's own marks INSIDE the shipped picker's model name. Registered in
        // both modes: `managed` shadows the owner's control, where this then simply
        // never renders, and `native` is exactly the case it exists for.
        try {
          ctx.slots.inject('conversation.input.model.label', () => ctx.slots.register({
            name: 'conversation.input.model.label',
            id: 'llm-manage-label',
          }, ModelLabel))
        } catch {
          // A Host whose client predates the label slot: the marks are decoration, and
          // everything else this plugin does keeps working without them.
        }

        // Shadow the shipped picker at priority -1 (lowest renders) so pins and
        // favorites come first. The seat is `single`, so this registration must
        // supply the business face the shipped one does: the same directory
        // store and the same select verb, taken from the same services.
        //
        // Only in `managed` mode: `native` exists precisely to hand the seat back
        // to the shipped picker, and registering here regardless is what made that
        // setting inert.
        // The team switch is driven through the same remote the shipped row uses.
        // Captured through a nested inject so this plugin still mounts on a client
        // that does not install the capability: the row then reports the failure
        // instead of the whole picker disappearing over a service the reader may
        // never have had.
        let agentTeams = null
        try {
          ctx.inject(['remote.agentTeams'], (scope) => {
            agentTeams = scope.remote.agentTeams
            return () => { agentTeams = null }
          })
        } catch { /* the row reports the cap */
        }
        // Navigation lives on the workspace face, not on the Session list. Captured the
        // same lazy way so a client without it still mounts: the history then names the
        // Session as plain text instead of pretending to be a link.
        let uiWorkspace = null
        try {
          ctx.inject(['uiWorkspace'], (scope) => {
            uiWorkspace = scope.uiWorkspace
            return () => { uiWorkspace = null }
          })
        } catch { /* the chip renders as a label */
        }
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
                // The switch verb stays lazy: the remote arrives after mount on a
                // cold client, and a row that captured `null` at register time
                // would claim the capability is missing forever.
                setTeamEnabled: (id, enabled) => (agentTeams === null
                  ? Promise.resolve(undefined)
                  : agentTeams.setEnabled(id, enabled)),
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
