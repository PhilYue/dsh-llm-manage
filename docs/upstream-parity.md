# 上游能力对照（upstream parity）

DSH 每次升级都可能给「输入框里的模型菜单」加新的行。本插件把那块 UI 整个换成了自己的
picker（`conversation.input.model`，`priority: -1`），所以**上游加的行我们不会自动获得**——
不报错、不告警，只是少了一个开关。`0.3.9` 之前「启用智能体团队协作」就是这样消失的。

这份文档和 `tools/check-upstream.mjs` 一起把「每次迭代对比原版能力」变成一条会自动跑的检查，
而不是靠记性。

## 为什么不能直接把上游的子槽搬过来

- 官方入口在自己的注册里声明了子槽：`children: { 'conversation.input.model.label': …, 'conversation.input.model.options': … }`
  （`packages/client/ui-model-selection/src/client/index.ts`）。
- `renderSlot` 这个 prop **只注入给声明了 `children` 的入口**（`packages/client/ui-renderer/src/client/scoped-slots.tsx`
  的 `standardKit()`）。我们没声明，`props.renderSlot` 就是 `undefined`，原来那句
  `typeof props.renderSlot === 'function' ? … : null` 于是静默渲染 `null`。
- 我们也不能补声明：槽表对已经存在的 childKey 会抛
  `slot "…" is already declared (by …)`（`packages/client/ui-slots/src/index.ts`），而官方入口先注册。
  `ctx.slots` 的公开面只有 `register` / `registerFactory` / `inject`，没有「渲染别人的子槽」或
  「继承 children」的入口。

结论：**替换者必须自己把那一行画出来**，用同一个投影、同一个远端方法、同一份文案。

## 检查做什么

`node tools/check-upstream.mjs`（需要 `DSH_CHECKOUT`）读 `docs/upstream-parity.json`，做三件事：

1. 清单里记录的每个座位/子槽**仍然存在于上游源码**（上游改了名字就红）。
2. 扫 `packages/**/*.ts(x)` 里所有注册进这些子槽的条目，**每一条都在清单里有账**
   ——`reproduced`（我们画了）或 `skipped` 且写明理由。出现一条没见过的 `id` 就红。
3. 我们复刻的文案与上游 `locales.ts` **逐字一致**（中英各一份；上游 `{message}` 这类占位符也算字面）。

`verify.mjs` 会把它当一条普通检查跑（`every upstream row in the seats we took over is accounted for`），
所以「跑一遍套件」就等于「对比了一次原版能力」。

## 现状

| 座位 | 子槽 | 上游行 | 我们的处理 |
| --- | --- | --- | --- |
| `conversation.input.model` | `conversation.input.model.label` | 无内建占用者（扩展点） | 我们自己填 `llm-manage-label` |
| `conversation.input.model` | `conversation.input.model.options` | `agent-team`（`ui-agent-team`） | `TeamModeRow`（`client.js`）：同一投影 `agentTeam`、同一远端 `remote.agentTeams.setEnabled` |
| `conversation.input.model` | `conversation.input.model.options` | `experimental/liveshare` 也占这个座位，但同样不声明 children | 不涉及（我们与它互不感知） |

## 新增一条上游行时怎么办

1. 先跑 `node tools/check-upstream.mjs`，红的那条会告诉你 `id` 和文件。
2. 读那个插件的 `mount.ts` / 组件：它从哪个投影取状态、调哪个 remote、什么条件不渲染。
3. 在 `client.js` 里画等价的一行（用 `--dsw-alias-*` token，不搬它的样式），语义逐条对齐：
   条件隐藏、失败文案、需要确认的破坏性动作。
4. 在 `docs/upstream-parity.json` 里把该 `id` 标成 `reproduced` 并写明 `where`；确实不打算做的，
   标 `skipped` 并写理由（理由要能回答「用户会不会觉得少了什么」）。
5. 复刻了文案的，把键对加进清单的 `copy.keys`，检查会守住后续漂移。

## 维护约定

- 上游一旦给替换者开放 children 继承，就删掉 `TeamModeRow`，回到 `renderSlot('conversation.input.model.options', …)`，
  同时把清单里这条改成 `delegated`。
- 清单只记「我们遮蔽了的座位」，不要把所有 DSH 能力都抄进来——它不是功能清单，是一份欠账表。
