---
description: "让模型在用户自己的登录浏览器里填写网申表单的工具集与资料提示词，通过回环桥连接 Profile Autocomplete 扩展。"
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-form-filler

## Summary

`dsh-experimental-form-filler` 让模型在用户自己的登录浏览器中填写网页表单。它注册十四个 `form_*` 工具，按每个快照内稳定的元素地址观察实时 DOM 并操作元素，同时注入两段系统提示词：操作规则（可编辑的 `prompts/system.md`）与用户自己的 Markdown 资料。工具通过本包自建的回环 WebSocket 桥与 Profile Autocomplete Chrome/Edge 扩展通信，因此扩展沿用既有的线协议。本包不承担任何编排：由 harness 的 agent loop 决定观察、填写或询问，工具只回报浏览器的真实回读。

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

在 profile 中挂载本插件，然后安装 Profile Autocomplete 扩展，把控制台打印的桥地址填入扩展；扩展默认地址已经匹配。

```yaml
- id: form-filler
  name: '@deepseek-ai/dsh-experimental-form-filler'
  config:
    port: 8765
    knowledgeDir: knowledge
    attachmentsDir: attachments
```

### 配置

| 字段 | 默认值 | 含义 |
|---|---|---|
| `host` | `127.0.0.1` | 回环监听地址 |
| `port` | `8765` | 回环监听端口；`0` 表示由系统分配 |
| `runDir` | `runs` | 存放每次观察所得 DOM 快照的目录，相对会话工作目录 |
| `knowledgeDir` | `knowledge` | 用户自己的 `*.md` 资料目录，相对会话工作目录 |
| `attachmentsDir` | `attachments` | 证书、照片等待上传文件，相对会话工作目录 |

`runDir`、`knowledgeDir` 与 `attachmentsDir` 刻意写成相对路径：它们相对会话的工作目录解析，而该目录也正是文件沙箱的可写根。把一个会话指向自带的 `knowledge/` 与 `attachments/` 的工作目录（每个简历版本或每个人一份），资料与 DOM 快照就跟着这个工作目录走。

激活时会打印实际的监听地址，扩展会自动连接它。

### 工具流程

模型先绑定标签页，再观察，用 `todo_write` 规划要填的各个部分，按需读取 DOM 后操作，收工前自检。

1. `form_tabs` 列出每个已连接浏览器及其 HTTP(S) 标签页；`form_attach` 把本会话绑定到其中一个。
2. `form_observe` 把每个 frame 的实时 DOM 写入 `runDir` 下的文件，并返回逐 frame 的路径索引与一张整页截图。本地不做任何过滤，模型用内置 `read`/`grep` 读取真实 DOM。
3. 看清页面分区后，用 `todo_write` 列出本次要填的任务清单（每个部分一条，先 `pending`），之后整表更新状态。
4. 字段多、且多为标准控件时走快路径：`form_scan` 一次性枚举所有可填控件（地址、当前状态、多来源候选标签），模型据此判断每个控件对应资料里的哪个键，再用 `form_fill_batch` 一条命令批量写入，最后重新 `form_observe` 复核。`form_scan` 只枚举、不筛选，隐藏/禁用/文件/按钮类控件也列出并打 `visible`/`disabled`/`readonly` flag；批量写跳过已有有效值的项，写不了的（自定义下拉、日期控件等）带 `reason` 拒绝。
5. 剩下的用 `form_fill`、`form_click`、`form_type`、`form_hover`、`form_scroll`、`form_wait`、`form_upload` 按元素地址慢填，并返回浏览器的回读。
6. 关键操作后重新观察会刷新地址，因为过期快照会被拒绝。
7. 全部待办完成后收尾自检：核对 `required`/`aria-required`/`*` 标注的必填项有无缺漏（含再保存一次读取网站字段级校验报错），并对照资料确认项目经历、获奖、证书等选填经历已尽力展开；缺漏补回清单逐条清掉后再结束。

`form_read` 与 `form_look` 是廉价的只读路径：前者读值与选项，后者出定向截图。

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>实现细节 — 点击展开</summary>

### 源码结构

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | function plugin：配置、桥生命周期、工具与提示词注册 |
| [`src/bridge.ts`](src/bridge.ts) | 回环 `node:http` + `ws` 监听、hello 握手、命令/结果配对 |
| [`src/tools.ts`](src/tools.ts) | 十四个 `form_*` 工具定义与会话级绑定状态 |
| [`src/prompt.ts`](src/prompt.ts) | 规则段（读取 `prompts/system.md`）与动态资料段 |
| [`prompts/system.md`](prompts/system.md) | 可编辑的填报规则正文；每次组装重读，改完即生效 |
| — | 不发布运行时不变式伴生包；桥的连接状态没有可独立比对的投影。 |

### 桥的所有权

插件自建监听而不使用 `ctx.webServer`，因为后者只由 web 应用 bundle 挂载，而填报会话必须在任意入口下都能工作。监听只绑回环，只接受 `/bridge` 路径，并拒绝 Origin 存在且不是 `chrome-extension://` 的升级请求。

### 线协议

协议镜像已退役的 Python 后端，因此扩展的传输层无需改动：扩展发送 `hello {browser}`，收到 `ready`，随后对每条 `command {id, op, ...}` 回 `result {id, ok, result}`；此外还会推送 `tabs` 与 `ping`。桥为每条命令计时，超时后对被放弃的 id 发送 `cancel`。

### 会话绑定与可观测性

工具状态以 `exec.agent.session.id` 为键：绑定、最近一次快照 id、以及每个动作的失败计数。失败动作只累加计数并回报当前总数，不阻断；由模型决定换手段、升级为真实输入，还是询问用户。

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Browser use 子系统](../../../docs/subsystems/browser-use.zh.md) — harness 自带的浏览器提供方，它们启动干净浏览器，不携带用户登录态。
- [工具目录](../../../docs/tool-catalog.zh.md) — 请求中可见工具的生成 schema。

-----

<a id="model-experience"></a>
## Model Experience

### System-prompt sections

#### What the model sees

两段。规则段读取自包根的 `prompts/system.md`（可编辑、每次组装重读）；资料段是 `knowledgeDir` 下全部 `*.md`，每个文件以 `# 文件：<name>` 为标题拼接，开头两行分别给出可写的资料目录与只读的附件目录。`attachmentsDir` 下的文件随后按绝对路径列出，供 `form_upload` 使用。资料目录不存在时贡献为空；资料超过 100000 字符时截断并附可见告警，而不是直接丢弃（附件清单排在最后，会最先被裁掉）。

##### 填报规则

见 [`prompts/system.md`](prompts/system.md)。该文件是规则段的唯一真源，随包发布、可直接编辑。规则段每次组装都重读，改完存盘即生效、无需重启；读不到时回退为一句显式的读取失败标记并写日志，而不是静默丢弃。

#### Token effect

规则段为固定开销；资料段与用户自己的文件量成正比，上限 100000 字符。

#### KV Cache effect

规则文本与资料文件都不变时前缀稳定。编辑 `prompts/system.md`，或增删改任一资料文件，都会改变相应段的文本，并使从此段开始的复用失效。

### Tool schemas and results

#### What the model sees

十四个工具 schema：感知原语（`form_tabs`、`form_attach`、`form_observe`、`form_look`、`form_read`、`form_scan`）与操作原语（`form_fill`、`form_fill_batch`、`form_click`、`form_type`、`form_hover`、`form_scroll`、`form_wait`、`form_upload`）。`form_observe` 与 `form_look` 以 image block 返回整页截图；`form_fill`、`form_click`、`form_type` 返回裁剪后的确认截图。`form_scan` 只读、不出图，返回控件枚举与候选标签；`form_fill_batch` 一条命令批量写入并返回逐项回读、不带确认截图。每个结果都携带浏览器的结构化回读。确切的 `name`、`description` 与 JSON-Schema 参数见[生成的工具目录](../../../docs/tool-catalog.zh.md#deepseek-aidsh-experimental-form-filler)。

#### Token effect

工具集可见时 schema 为固定开销。结果为数据相关：DOM 快照索引很小，而每张返回的图片是一个按图计费的 image block。

#### KV Cache effect

schema 与可见性不变时前缀稳定。追加的工具结果只让请求追加增长，不使可复用前缀失效；若某张 image block 被服务端降采样或替换改写，则可能使该消息的复用失效。

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **部分工具依赖当前 preset** — 规则要求模型使用 `ask_user_question` 与 `todo_write`：前者由 standard agent preset 的 `@deepseek-ai/dsh-tool-ask-user` 挂载，后者由 `@deepseek-ai/dsh-tool-todo` 挂载；缺少对应包的组合会让模型无法询问或用清单规划与自检。
- **图片需要支持图像的模型路由** — 工具结果直接携带 image block，不像 `read_image` 那样按路由模型声明的输入模态做门控；纯文本路由会在适配器处失败而非降级。
- **跨域与封闭界面仍交给用户** — 扩展读不到封闭 shadow root、无法截取跨域 iframe、跟不上虚拟滚动下拉，也处理不了验证码/滑块；规则把这些交给 `ask_user_question`。
- **截图会带出已填的值** — 文本通道可以做到键值分离，但页面图片是像素通道，会显示已录入的内容。

<a id="dev-note"></a>
### Dev Note

<details>
<summary>维护者工作上下文 — 点击展开</summary>

Profile Autocomplete 仓库中已退役的 Python 后端是桥协议、稳定元素寻址（`data-pa-n`）与不过滤快照的行为来源。请让本包的协议与扩展的 `background/bridge.js` 保持同步。

</details>
