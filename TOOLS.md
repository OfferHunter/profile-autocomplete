# form-filler 工具参考

本文档描述 `form-filler` 暴露给模型的全部工具的**输入、输出与实现方式**，以及两侧
（DSH 插件 `form-filler-dsh/`、浏览器扩展 `form-filler-chrome/`）如何协作。

- 模型面向的工具定义在同名源码 `form-filler-dsh/src/tools.ts`。
- 工具只是薄壳：参数校验 + 组装回读 + 图像记忆登记，真正的执行在扩展侧。
- 扩展侧按「内容脚本（页面上下文）」与「CDP（调试器）」两条通道分工。

---

## 1. 架构与调用链

```text
模型 ── form_* 工具 ──► tools.ts（schema / 回读 / 图像记忆）
                              │
                       bridge.ts（回环 WebSocket 服务端，请求-结果关联）
                              │  command { id, op, ... }
                              ▼
                   扩展 service worker：bridge.js（分派、按标签页分道、截图独占前台）
                        │                              │
        chrome.tabs.sendMessage                chrome.debugger (CDP)
                        ▼                              ▼
        内容脚本 dom/scan/act/record           截图 / 真实输入 / 文件上传
          （在页面上下文里读写活 DOM）
```

关键分层原则：

- **感知层不做任何本地裁决**。快照、`form_scan` 只做「枚举 + 打标」，不判断"什么算字段"、
  不排除 hidden/file/按钮；是否该填由模型决定。
- **每个动作都必须回读**。受控组件、自定义控件、被站点 JS 拒绝的写入，都表现为
  "看起来填了、其实没进去"；只有回读能区分。
- **数据通道不加规则**。相对路径一律按**会话工作目录**（`session.header.cwd`）锚定，
  快照落 `<session cwd>/runs/<sessionId>/<snapshotId>/frame-N.html`，把绝对路径交给模型
  用内置 read/grep 读。

### 通用约定

- **地址 `n`**：快照给每个元素一个稳定的 `data-pa-n="N"`；`N` 即操作时指认元素的地址。
  元素被框架换掉后地址失效，动作会返回 `stale_address`，需要重新 `form_observe`。
- **超时**：桥接命令默认 30000ms；几乎每个工具都接受 `timeoutMs` 覆盖，上限 120000ms。
- **确认图**：`form_fill` / `form_click` / `form_type` 默认截一张该元素的裁剪图并登记进
  「图像记忆」，结果里回 `imageId`；传 `confirm:false` 关掉。

### 动作结果通用字段（`ACT_RESULT_SCHEMA`）

除各工具特有字段外，动作类工具共享：

| 字段 | 类型 | 含义 |
| --- | --- | --- |
| `ok` | boolean（必有） | 这一步是否成功（含回读校验） |
| `reason` | string | 失败原因码：`stale_address` / `stale_document` / `stale_snapshot` / `missing_frame` / `unsupported_or_disabled` / `already_filled` / `not_interactable` / `no_option_match` / `no_scroll_container` / `point_offscreen` / `iframe_unsupported` / `readback_mismatch` / `no_box` / `bad_call` / `unknown_op` / `exception` |
| `message` | string | 人类可读的补充说明 |
| `dispatched` | boolean | 事件是否发出（**不代表生效**） |
| `actual` | json | 操作后对该元素的**真实回读**（见 §3） |
| `box` | json | 元素在文档坐标里的位置（iframe 内会把 `top` 标记为 false） |
| `imageId` | integer | 本步截图在图像记忆里的 id（无图时缺省） |
| `matchedOption` | {value,label} | 原生 select 命中项 |
| `scrollY` | integer | 窗口滚动后的文档偏移 |
| `scrolled` / `scrollTop` / `scrollHeight` / `clientHeight` | integer | 元素自滚的增量与新指标（见 `form_scroll`） |
| `files` | string[] | 上传后挂上的路径 |
| `point` | {x,y} | trusted 点击/悬停合成的顶层视口坐标 |
| `hitsTarget` | boolean | 点击自校验：元素中心是否命中元素自身（或其子树） |
| `hit` | json | 命中的那个元素描述 `{tag,id,text,n}` |
| `repeat` | integer | 本次连发的重复次数 |

`form_fill` / `form_click` 额外带 `attempts`（同一 `op@frame:n` 的累计失败次数）。

---

## 2. 感知类工具

### form_tabs

列出已通过扩展连接的浏览器与被绑定的标签页。

- **输入**：无。
- **输出**：`{ browsers: [{ browser, bound, tabs: [{ id, url, title }] }] }`；`bound` 标出本会话已绑定的浏览器。

### form_attach

把本会话绑定到一个标签页；之后所有 `form_*` 都作用于该标签页，直到重新绑定。

- **输入**：`tabId`（integer，必填，取自 `form_tabs`）；`browser`（string，可选，同一 `tabId` 有歧义时用）。
- **输出**：`{ browser, tabId, url, title }`。
- **实现**：只写会话状态（`browser` / `tabId`），并清空 `snapshotId`（换页后旧快照作废）。

### form_observe

观察绑定标签页：把**每个 frame 的完整实时 DOM**原样写入文件，并截一张整页图。

- **输入**：`y`（文档 y 偏移，看下方内容）、`n`+`frame`（围绕某元素裁剪）、`timeoutMs`。
- **输出**：
  `{ url, title, documentId, snapshotId, pageHeight, imageId?, frames: [{ frameId, frameUrl, title, path, nodes, error? }] }`
- **实现**：
  - service worker 向每个 frame 要快照并汇总；`snapshotId` 是本轮快照的句柄，后续 act 必须带上它。
  - 截图走 CDP `Page.captureScreenshot`（`captureBeyondViewport`），**非激活标签页会挂起**，
    所以先 `ensureActive` 激活；截图整段走全局锁，避免并发截图互相把对方踢到后台。
  - 快照**不截断**：超大页面文件很大，模型应分段读（offset/limit 或 grep）。
  - 整页图登记为「full」槽（下次整页观测自动覆盖）；`n` 定向时登记为裁剪图。

### form_look

只截图、不取 DOM 快照。比 `form_observe` 便宜，用来读一个标签或复核一小块。

- **输入**：`y` 或 `n`+`frame`，`timeoutMs`。
- **输出**：`{ clip, pageHeight, imageId? }`。

### form_read

按地址读一个元素的当前状态；廉价、无副作用。

- **输入**：`n`（必填）、`frame`（默认 0）、`timeoutMs`。
- **输出**：`ACT_RESULT_SCHEMA`，状态在 `actual` 里（见 §3）。

### form_scan

枚举标签页上所有可填控件，附多来源候选标签。**只枚举、不筛选**。

- **输入**：`frame`（省略则扫最近一次观测的所有 frame）、`kinds`、`maxGapPx`（默认 160）、
  `maxCandidates`（默认 6）、`scope`（CSS 子树）、`offset` / `limit`（默认 200，分页）、`timeoutMs`。
  - `kinds` 取值：`label-for, wrapping, aria, dl, legend, table-cell, prev-text, placeholder, title, row-left, above`。
- **输出**：
  `{ frames: [{ frameId, frameUrl, title, total, offset, count, scopeError?, controls: [...] }] }`
  每个 control：`{ n, tag, role?, name?, id?, ...当前状态, flags:{visible,disabled,readonly}, labels:[{kind,text}] }`。
- **实现**（`form-filler-chrome/src/content/scan.js`）：
  - 选择器覆盖 `input/textarea/select/[contenteditable]` 与 ARIA 型
    `[role=combobox|listbox|radio|checkbox|switch|textbox|spinbutton]、[aria-haspopup]`。
  - **不排除** hidden/file/按钮/禁用控件，只打 `visible/disabled/readonly` flag 由模型取舍。
  - 标签是**带来源的候选**（`kind`），本地不替模型认定"哪个是键"。
  - 依赖活 DOM（可见性靠 `getComputedStyle`、空间邻近靠 `getBoundingClientRect`）。
  - **前置条件**：需先 `form_observe`（要有 `snapshotId`）。

### form_record

把一批动作包起来执行，**只返回这些动作引起的 DOM 变化**。取代"每步之后整页观测"。

- **输入**：
  - `ops`（必填，按序执行）：每项
    `{ op: fill|click|type|hover|scroll|upload|read, n?, value?, text?, key?, repeat?, path?, trusted?, frame? }`。
    不允许嵌套 `record`。
  - `frame`（默认 0，作为各 op 的默认 frame）、`settleMs`（默认 300，DOM 静默多久算收）、
    `maxWaitMs`（默认 2000，上限 10000，永动动画页兜底）、`limit`（默认 40000 字符/帧）、
    `timeoutMs`。
- **输出**：
  `{ ops: [逐 op 回读], frames: [{ frameId, ok?, reason?, truncated?, added:[{n,tag,html}], changed:[{n,tag,changes[],html?}], removed:[{n,tag}], noChange? }], navigated? }`
  - `added`：新插入的子树，**带地址的快照 HTML**——浮层打开后从 `added` 里挑选项地址。
  - `changed`：属性变化的元素（容器级大改动只给地址与属性名，不序列化整棵子树）。
  - `removed`：**本次消失、且已有地址的元素**。浮层关闭、整块消失就靠它看出来。
  - `noChange`：三者皆空时为 `true`，是显式的"这步什么都没变"信号，而非三个空数组。
  - `navigated`：批内文档地址变了（导航了），此差分已不可靠，应重新 observe。
- **实现**（`form-filler-chrome/src/content/record.js`）：
  - **不是常驻观察器**：`record_arm` 时起、`record_collect` 后停，窗口由这批操作自己界定。
  - `MutationObserver` 同时收 `addedNodes` 与 `removedNodes`（属性变化限定在
    `style/class/hidden/aria-expanded/aria-hidden`）。
  - 静默判定：距最后一次变更 ≥ `settleMs` 即收；到 `maxWaitMs` 强制收。
  - 上限保护：窗口内记录项 `CAP=4000`；单元素子树超过 `MAX_ELEM_NODES=1500` 只报地址+属性名。
  - 与 `form_observe` 共用同一套 `data-pa-n` 地址与实时状态序列化。

### form_look / form_observe 的截图通道（images）

- 截图不随工具结果返回，而是进「图像记忆」面板，由系统作为 user 消息统一注入。
- 每张图标 id 与来源；`form_observe`/`form_look`/`form_fill`/`form_click`/`form_type` 的结果里
  回 `imageId`。
- 图像记忆分「full（整页，每 tab 一张，会被下次整页观测覆盖）」与「crops（最近若干张裁剪图）」两槽。

### drop_images

按 id 释放图像记忆里的图，回收上下文。

- **输入**：`ids`（integer[]，必填）。
- **输出**：`{ dropped, remaining: { full, crops } }`。

---

## 3. 元素状态回读（`readState`）

所有动作的 `actual` 都来自 `form-filler-chrome/src/content/act.js` 的统一读法：

| 控件 | 回读字段 |
| --- | --- |
| `input[type=checkbox/radio]` | `checked`、`value` |
| 其他 `input` / `textarea` | `value`（此刻真实值，非 HTML 写死属性） |
| `select` | `value`、`selectedText`、`options:[{value,label,disabled}]` |
| `contenteditable` / 其他 | `text`（去空白，截断到 200 字） |
| **浮层控件（combobox/listbox 等）** | 上述基础上多一个 **`activeOption`**：`{ id, text, n }`＝当前高亮项 |

`activeOption` 的解析规则（**只读、不猜**）：

1. 主通道：读元素自身或邻近祖先（≤6 层）的 `aria-activedescendant`，取其 id 指向的元素文字。
   键盘导航时页面每动一格就换这个 id，因此它精确表示"现在停在第几项"。
2. 兜底：读 `role=listbox` 内 `[role=option][aria-selected=true]` 那一项。
3. 都不命中则不加该字段。

**收窄条件**：只有元素带 `aria-activedescendant`、或 `role=combobox/listbox`、或处在带这些
ARIA 的子树里时才解析；普通文本框的读法一字不变、零额外开销。

> 设计取舍：这是"读某类控件的状态"，所以放在**读侧**（`readState`），而不是塞进
> `form_type` 的发送逻辑。这样 `form_read`、`form_type`（其回读即 `read`）、`form_fill`、
> `form_click` 的回读**对称地**都带上 `activeOption`。
> 它属于"本地替模型**枚举**页面自己写下的事实"，不属于"本地替模型**裁决**"。

---

## 4. 动作类工具

### form_fill

向 `input/textarea/select/radio/checkbox/contenteditable` 写值，然后回读。

- **输入**：`n`（必填）、`value`（必填；checkbox/radio 传 `"true"/"false"`）、`frame`（默认 0）、
  `confirm`（默认 true）、`timeoutMs`。
- **输出**：`ACT_WITH_ATTEMPT_SCHEMA`（动作通用字段 + `attempts`）。
- **实现**：
  - **有内容就拒绝**：控件已有有效值（或 radio 组已选中）→ `already_filled`，不覆盖。
    placeholder、`请选择` 一类不算有效值。
  - 原生 `select`：按 label/value 匹配（空白归一、大小写、唯一包含），**匹配不到不猜**，
    返回 `no_option_match` 并把真实 `options` 回给模型重挑。
  - 受控组件：走原型上的原生 setter 再派发 `input/change`，绕开框架自己的渲染覆盖。
  - `checkbox/radio`：走 `click()`（改 `checked` 属性不会触发站点监听）。
  - **写后回读即判据**：`readback_mismatch` 表示站点把值改掉/清空了（多为格式校验拒绝）。

### form_fill_batch

一次往返写多个值。按 frame 分组，每组一条命令。

- **输入**：`items`（必填，`{n, value, frame?}`）、`frame`（默认 frame）、`timeoutMs`。
- **输出**：`{ results: [{ frame, n, ok, reason? }] }`。
- **实现**：复用 `fill()` 的同一套守卫；**每项的 `box` 被丢弃**以保持精简；不出确认图，
  之后用 `form_observe` 复核。

### form_click

按地址点击任意元素（按钮、链接、选项、自定义控件）。

- **输入**：`n`（必填）、`frame`（默认 0）、`trusted`（默认 false）、`confirm`（默认 true）、`timeoutMs`。
- **输出**：`ACT_WITH_ATTEMPT_SCHEMA`；带 `hitsTarget`、`hit`，trusted 时带 `point`。
- **实现**：
  - **默认 DOM 点击**：`el.click()`（或派发合成 `MouseEvent`），按地址定位，**对 Ant Design
    等自定义浮层普遍有效**。
  - **`hitsTarget` 自校验**：点击前用 `document.elementFromPoint` 测元素中心实际命中谁；
    `true`＝命中元素自身或子树；`false`＝被遮挡/在视口外，这次点击多半没生效。因为点击可能
    改变层叠，校验**在派发前**做，避免把"点中了"误报成"没点中"。
  - **trusted 真事件**：走 CDP，先把地址翻译成 CDP 节点，由浏览器算出它在**顶层视口**的坐标，
    再派发 `mouseMoved → mousePressed → mouseReleased`（跨 iframe 也由坐标路由）。
    若算出的坐标**落在视口外**（虚拟列表常把"测量幽灵行"放在超大负偏移处），直接返回
    `point_offscreen` 而**不派发**，以免点到空处、误触关闭浮层。
  - **推荐策略**：先默认 DOM 点击；只有 `form_record` 差分 `noChange`（控件对 DOM 点击
    完全无反应）时，才升级 `trusted:true`。
  - 返回 `dispatched` 只代表事件已发出，是否生效要用 `form_record`/`form_observe` 确认。

### form_type

聚焦元素（可选）后发真实按键：文本走自动补全/日期控件，或按一个特殊键。

- **输入**：`n`（可选，先聚焦）、`text`（要键入的文本）、`key`（一个特殊键）、
  `repeat`（默认 1，上限 100，同一键连发次数）、`frame`（默认 0）、`confirm`（默认 true，需 n）、
  `timeoutMs`。**`text` 与 `key` 至少给一个**。
- **支持的键**：`Enter, Tab, Escape, ArrowDown, ArrowUp, Home, End, PageUp, PageDown, Backspace, Delete`。
- **输出**：`ACT_RESULT_SCHEMA`。当 `n` 指向 combobox/listbox 时，`actual.activeOption` 给出
  按键后当前高亮项——用来确认"走对格了没有"。
- **实现**：
  - 先 `focus(n)` 把焦点落到目标（CDP `insertText` 只进当前焦点），再经 CDP
    `Input.insertText` / `Input.dispatchKeyEvent` 发真实事件。
  - `repeat` 在扩展侧循环同一个键 N 次（一次往返），配合 `Home/End/PageDown` 可快速定位虚拟列表。
  - 回读走 `read(n)`，因此自带 `activeOption`。

### form_hover

悬停，用于只在 hover 时展开的菜单/提示。

- **输入**：`n`（必填）、`frame`（默认 0）、`trusted`（默认 false）、`timeoutMs`。
- **输出**：`ACT_RESULT_SCHEMA`。`trusted` 走 CDP 真实指针移动，同样受 `point_offscreen` 保护。

### form_scroll

把元素滚进视野、把窗口滚到某文档行、或**滚元素自己的内部容器**。

- **输入**：`n`、`dy`、`y`、`frame`（默认 0）、`timeoutMs`。**`n` 与 `y` 至少给一个**。
- **输出**：`ACT_RESULT_SCHEMA`——窗口模式给 `scrollY`；元素自滚模式给
  `scrolled` / `scrollTop` / `scrollHeight` / `clientHeight`。
- **三种模式**：
  1. `n + dy`：沿 `n` 最近的**可滚动祖先容器**（`overflow-y: auto/scroll/overlay` 且
     `scrollHeight > clientHeight`）滚动 `dy` 像素。这是滚**浮层/虚拟列表自身**的方式
     （`dy` 模式之前，`form_scroll` 只能滚窗口，够不着下拉内部容器）。
  2. `n`：把元素滚进视野中央（可能滚窗口）。
  3. `y`：把窗口滚到文档 `y`。

### form_wait

等 AJAX 渲染或受控组件稳定。

- **输入**：`ms`（必填，上限 30000）。
- **输出**：`{ waitedMs }`。

### form_upload

用调试器把本地文件挂到一个 file input 上。

- **输入**：`n`（必填）、`path`（必填，**绝对路径**）、`frame`（默认 0）、`timeoutMs`。
- **输出**：`ACT_RESULT_SCHEMA`（`files`）。
- **实现**：CDP `DOM.setFileInputFiles`，由 Chrome 进程读盘、**不受沙箱限制**。支持同源/同站
  iframe 内的 file input（先翻译成 CDP 节点）；**跨站 OOPIF** 够不到 → `iframe_unsupported`。

---

## 5. 本轮改动：下拉填报提速

Agent 反馈「求职意向」4 个下拉用了约 40 次调用。定位到 4 个真实能力缺口，按**纯机制**补上
（不新增任何"聪明的选择器"，不把"怎么打开某类控件"的机械知识编码进本地）：

| 缺口 | 现象 | 改动 |
| --- | --- | --- |
| 键盘导航无法确认位置 | 连发 19 个 `ArrowDown` 后落到 34K，纠正又花 6 次 | **P1**：`form_type` 支持 `repeat`（一次连发）；`readState` 带出 `activeOption`；补齐 `Home/End/PageUp/PageDown` |
| `trusted` 点击坐标不可信 | 计算出的 `point` 为 `(-9852,-9979)`，点了等于没点还关掉了浮层 | **P4**：trusted 点击**视口外直接拒绝**（`point_offscreen`）；点击回读加 `hitsTarget`/`hit` 自校验；提示词默认改「先 DOM 点击」 |
| `form_scroll` 滚不动浮层 | 薪资列表高 4920px，`form_scroll` 只滚了窗口（`scrollY: 691`） | **P2**：`form_scroll` 支持 `n + dy` 滚元素自身容器，回 `scrollTop/scrollHeight/clientHeight` |
| 零变更差分无信号 | 关弹窗/点开又开报不出任何东西 | **P3**：`record` 收 `removedNodes` 报 `removed`，并给 `noChange` 显式标记 |

配套的提示词调整（`form-filler-dsh/prompts/system.md`）：点击**先 DOM、无效再升 trusted**；
虚拟列表用 `form_type` 的 `repeat` 与 `form_scroll` 的 `dy`，并按 `activeOption` 核对落点。

**为什么不做 `form_select_option`（"给控件+目标值，内部自己打开/滚动/点中"）**：那要把
Ant Design / Element / bootstrap-select / 级联弹窗各自的"开法"编码进本地，正是这套架构
用 VLM 替代规则式采集层时要避开的东西。改为让模型现有的
「打开 → 找选项 → 点/键 → 回读」四步**变得确定**：每步都有可靠回读，且点击/滚动/按键都是
可泛化的机制原语。

### 变更涉及的文件

| 文件 | 改动 |
| --- | --- |
| `form-filler-chrome/src/content/act.js` | `readState` 增强 `activeOption`；新增命中自校验 `hitTest`；`click` 回带 `hitsTarget/hit`；`scroll` 支持 `dy`；dispatch 增 `hit_test` |
| `form-filler-chrome/src/content/dom.js` | 新增只读地址查询 `numIfKnown`（不分配新地址） |
| `form-filler-chrome/src/content/record.js` | 记录 `removedNodes`，输出 `removed` 与 `noChange` |
| `form-filler-chrome/src/background/cdp.js` | 补 `Home/End/PageUp/PageDown`；新增 `viewportSize` |
| `form-filler-chrome/src/background/bridge.js` | `type` 支持 `repeat`；trusted 点击视口外拒绝 + 附命中自校验；`scroll` 透传 `dy` |
| `form-filler-dsh/src/tools.ts` | `form_type` 加 `repeat`；`form_scroll` 加 `dy`；`record` op 加 `repeat`；输出 schema 增相应字段与 `removed/noChange`；更新工具描述 |
| `form-filler-dsh/src/bridge.ts` | `ActResult` 补类型字段 |
| `form-filler-dsh/prompts/system.md` | DOM-first 点击；虚拟列表用法 |
| `form-filler-chrome/test/verify-dom.mjs` | 新增 9 条针对 P1–P4 的回归断言（该目录被 `.gitignore` 忽略，属本地测试） |

---

## 6. 附：扩展侧 command.op 一览

桥接命令（`command.op`）：`observe`、`shot`、`act`。

`act` 下内容脚本支持的动作（`call.op`）：
`read`、`fill`、`fill_many`、`scan`、`click`、`type`、`hover`、`scroll`、`upload`、`record`，
外加内部辅助：`box`、`focus`、`mark`、`unmark`、`hit_test`、`record_arm`、`record_collect`。

其中仅 `read/fill/fill_many/scan/click/type/hover/scroll/upload/record` 对模型可见
（其余为内部握手，不进入白名单）。协议细节见仓库根 `README.md`。

## 7. 测试

- DSH 插件回归（33 用例）：在 `form-filler-dsh/` 下用 harness 的 vitest 运行。
- 扩展侧 DOM/动作回归：`node form-filler-chrome/test/verify-dom.mjs`（需本机 Edge）。
  直接操纵 `window.__PA.act.dispatch(...)` 断言快照与动作行为。
  注意 `form-filler-chrome/test/` 被 `.gitignore` 忽略，是**本地测试**，不随仓库分发。
  > 现有基线有 7 条历史遗留失败（`force` 覆盖 / 快照截断特性——这些特性在代码里已移除但
  > 断言仍在），与本轮改动无关。本轮新增的 9 条断言全部通过（48 → 57 passed）。
