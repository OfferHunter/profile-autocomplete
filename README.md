# Profile Autocomplete

轻量 Chromium / Edge 扩展（Manifest V3），只负责**网页感知与操作**：读取页面 DOM、截图、填值、点击、上传文件。

模型、知识库、任务编排全部由 DSH 的 `form-filler` 插件负责。扩展通过一条本地 WebSocket 桥接连到 DSH，本身不含模型调用、不存资料、不保留聊天历史。

```text
DSH form-filler 插件 ── WebSocket ── 扩展后台 ── content script / CDP ── 网页
```

## 加载扩展

1. 在 Edge/Chrome 打开 `chrome://extensions`（Edge 为 `edge://extensions`），打开“开发者模式”。
2. 点“加载已解压的扩展程序”，选择 **`form-filler-chrome/`** 目录（含 `manifest.json`）。
3. 扩展更新后，在扩展管理页对该扩展点“重新加载”，并刷新要填写的网页。

## 连接 DSH

1. 启动 DSH 的 `form-filler` 插件，控制台会打印：

   ```text
   form-filler: bridge listening on 127.0.0.1:8765
   ```

2. 扩展默认连接 `http://127.0.0.1:8765`，无需配置。端口不同时，在侧边栏“连接设置”里改地址并保存。
3. 连接成功后侧边栏会显示“已连接本地服务”，并列出当前所有 HTTP(S) 标签页。

桥只绑回环，并拒绝 Origin 存在且不是 `chrome-extension://` 的网页连接；身份（`browser`）由扩展首次运行时随机生成并持久化。

## 桥接协议

扩展后台 `src/background/bridge.js` 与 `form-filler-dsh/src/bridge.ts` 一一对应：

| 方向 | 消息 |
| --- | --- |
| 扩展 → DSH | `hello { browser }`（连接后）；`tabs { tabs: [{id,url,title}] }`（连接建立后与心跳时）；`result { id, ok, result \| error }`；`ping` |
| DSH → 扩展 | `ready`（握手通过）；`cancel { id }`；`command { id, op, ... }`；`pong` |
| `command.op` | `observe`（DOM + 截图 + 分帧）、`shot`（重截图）、`act`（`read/fill/fill_many/scan/click/type/hover/scroll/upload`） |

身份非法（首帧不是 `hello`、身份为空/过长/重复）时 DSH 会以 `1008` 关闭连接。

## 结构

```text
form-filler-chrome/        浏览器扩展（感知与操作）
  manifest.json            扩展清单（加载该目录）
  src/background/
    service-worker.js      MV3 service worker，装载桥接
    bridge.js              WebSocket 桥接与 command 分发
    cdp.js                 chrome.debugger：截图、真实输入、文件上传
  src/content/
    dom.js                 页面快照（生成带 data-pa-n 地址的 HTML）
    scan.js                枚举可填控件与多来源候选标签（只读，不筛选）
    act.js                 在页面上下文执行 read/fill/fill_many/click/...
    main.js                content script 入口，串起 dom/scan/act
  src/sidepanel/
    sidepanel.html/.css/.js 侧边栏：连接设置、状态、标签页列表
    connection.js          面板 ↔ 后台的端口通道
    diagnostics.js         清单版本自检
form-filler-dsh/           DSH 插件（模型、知识库、任务编排），经 --patch 绝对路径加载，不再挂回 deepseek-harness
```

## 边界

- 截图、文件上传与 trusted 真实鼠标事件走 `chrome.debugger`：会与 DevTools 互斥，attach 后浏览器显示一条调试提示条。
- 非激活标签页上 `captureBeyondViewport` 会挂起，扩展会先激活标签页再截图（会切换当前标签页）。
- 多个会话可同时填**不同标签页**：命令按标签页分道并行。但截图要独占前台标签页，所以截图之间仍是串行、且会切换前台标签页。同一标签页上的两个会话不可并行——各自的 `observe` 会作废对方的快照，且会在同一个活 DOM 上互相覆盖。
- 文件上传、trusted 点击/悬停、定向裁剪都支持 iframe 内元素（同源或同站的 iframe）：先把元素地址翻译成 CDP 节点，由浏览器算出它在顶层视口的位置。只有**跨站（第三方域名）iframe** 是独立渲染进程，主调试会话够不到，会返回 `iframe_unsupported`。
- DOM 快照不截断：完整 DOM（含所有 frame）原样写入本地文件，超大页面的文件会很大。
- 扩展只做操作，不决定填什么、填完是否达标——这些由 DSH 侧的模型与任务逻辑判断。

## 测试

桥接回归测试是纯 JavaScript，无第三方依赖：

```bash
node tests/bridge-message.mjs
# 或
npm test
```

它覆盖：清单版本自检、面板消息来源判定、后台冷启动期间请求排队、初始化失败上报。
