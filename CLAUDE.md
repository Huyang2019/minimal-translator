# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目概述

极简翻译是一个 Chrome 扩展（Manifest V3），调用用户自定义的 OpenAI 兼容 LLM 接口将网页翻译为简体中文。无构建步骤，所有文件直接运行。

## 开发调试

无构建工具，直接在 Chrome 加载：

1. `chrome://extensions` → 开启开发者模式 → 加载已解压的扩展程序 → 选择本目录
2. 修改代码后，在 `chrome://extensions` 点击扩展的刷新按钮（background.js 改动需刷新；content.js / popup 改动刷新页面即可）

## 架构关键点

### 消息流

```
popup.js  ──sendMessage──▶  content.js   (translate / restore / setHover / getState)
popup.js  ──sendMessage──▶  background.js (bgTranslate / bgTts / shouldAutoTranslate)
content.js──sendMessage──▶  background.js (bgTranslate / bgTts / shouldAutoTranslate)
```

**所有网络请求必须在 background.js 发出**，content script 直接 fetch 会被页面 CSP 拦截。

### content.js 核心机制

- **SENTENCE_SELECTOR**（`h1-h6, blockquote, figcaption, [role="heading"]`）：标题级元素作为整体翻译单元，防止 Webflow stagger 动画把标题拆成逐词 span
- **getText(node)**：`innerText || textContent` 双重回退，处理 `opacity:0` 不可见元素
- **translateNodes()**：去重 → LRU 缓存命中直接应用 → 短文本（≤30字符，50条/批）与长文本（10条/批）分批 → 5路并发
- **startLiveMode()**：同时启动 MutationObserver（监听 childList / characterData / attributes）和 IntersectionObserver（元素进入视口时重新校验是否已翻译），两者共用 `pendingNodes` + `flushPending` 节流队列
- **applyTranslation()**：`originalTexts` Map 仅记录首次原文，防止 stagger 动画重写后丢失真正原文
- **queueNode()**：向上回溯到最近 SENTENCE_SELECTOR 容器再入队；文本节点只检查 `isMostlyChinese`（不检查 `originalTexts.has`），确保被外部 JS 覆盖回英文的节点能重新翻译

### 自动翻译启动逻辑（content.js autoCheck IIFE）

1. 从 `chrome.storage.local` 恢复 `hoverEnabled`
2. 向 background 查询 `shouldAutoTranslate`
3. 若在白名单或 `DEFAULT_ALWAYS_HOSTS`（x.com / twitter.com）→ 直接翻译
4. 否则最多重试 6 次语言检测（延迟递增）再决定是否翻译

### 存储字段（chrome.storage.local）

| 字段 | 默认值 | 说明 |
|------|--------|------|
| `apiUrl` | OpenAI 端点 | LLM API 地址 |
| `apiKey` | `''` | LLM API Key |
| `model` | `gpt-4o-mini` | 模型名 |
| `prompt` | 内置提示词 | 系统提示词 |
| `bilingual` | `false` | 双语对照模式 |
| `hoverTranslate` | `false` | 悬浮取词开关 |
| `autoTranslateEnglish` | `false` | 英文页面自动翻译 |
| `alwaysSites` | `[]` | 白名单域名列表 |
| `ttsEngine` | `'browser'` | 朗读引擎（browser / mimo） |
| `mimoApiKey` | `''` | MiMo TTS API Key |

## 版本规范

每次代码改动都要同步 bump `manifest.json` 的 `version`（patch / minor / major）。
