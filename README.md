# 极简翻译

一个使用自定义大模型（OpenAI 兼容协议）翻译网页的 Chrome 扩展，支持悬浮取词与语音朗读。

## 功能

- 一键将整个网页翻译为简体中文
- 自定义 LLM 后端：兼容 OpenAI / DeepSeek / Kimi / 通义千问 / Ollama 等任意 OpenAI 协议接口
- 英文网站自动翻译：自动检测英文页面并翻译
- 双语对照模式：保留原文，下方显示译文
- 悬浮取词翻译：选中文字弹出译文气泡，支持语音朗读
- 语音朗读：内置智能声音选择（优先 Microsoft / Google 神经网络声音），可选接入小米 MiMo TTS
- 信息流自动跟翻：监听 DOM 变化，无限滚动新内容自动翻译（适配 X / Twitter 等 SPA）
- 弹窗 / 轮播卡片全翻：监听 CSS class / style 属性变化，切换卡片时自动补全翻译
- 智能批处理：短文本（导航/按钮）与长文本（段落）分别成批，5 路并发
- 标题级元素整体翻译：避免被 stagger 动画拆词
- LRU 翻译缓存：相同文本复用，最多 5000 条

## 安装

1. 在 Chrome 地址栏打开 `chrome://extensions`
2. 开启右上角「开发者模式」
3. 点击「加载已解压的扩展程序」
4. 选择本项目根目录

## 配置

点击工具栏插件图标 → 「⚙ 模型设置」，填入：

- **API 地址**：兼容 OpenAI Chat Completions 协议的接口
- **API Key**：对应平台的密钥
- **模型**：模型名（如 `gpt-4o-mini`、`deepseek-chat`）
- **翻译提示词**：可自定义系统提示词（默认提示已优化）
- **朗读引擎**：浏览器内置（免费）或 MiMo TTS（需 API Key，音质更好）

### 常用平台示例

| 平台 | API 地址 | 模型 |
|------|---------|------|
| OpenAI | `https://api.openai.com/v1/chat/completions` | `gpt-4o-mini` |
| DeepSeek | `https://api.deepseek.com/v1/chat/completions` | `deepseek-chat` |
| 月之暗面 Kimi | `https://api.moonshot.cn/v1/chat/completions` | `moonshot-v1-8k` |
| 通义千问 | `https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions` | `qwen-turbo` |
| Ollama 本地 | `http://localhost:11434/v1/chat/completions` | `qwen2.5:7b` |

### MiMo TTS

前往 [platform.xiaomimimo.com](https://platform.xiaomimimo.com) 申请 API Key，在设置面板选择「MiMo TTS」并填入即可。默认使用英文女声 Mia。

## 项目结构

```
chrome-fy/
├── manifest.json     # 扩展清单（MV3）
├── popup.html        # 弹窗 UI
├── popup.js          # 弹窗逻辑
├── content.js        # 内容脚本（DOM 翻译 + 悬浮取词 + 语音朗读）
├── content.css       # 双语对照样式
├── background.js     # Service Worker（LLM 调用 + MiMo TTS + 自动翻译路由）
└── icons/            # 扩展图标
```

## License

MIT
