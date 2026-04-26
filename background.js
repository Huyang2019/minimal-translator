const SEP = '\n<<<###>>>\n';
const DEFAULT_PROMPT = '你是专业翻译助手。请把用户提供的文本翻译为简体中文，保持原意和语气，仅返回译文，不要任何解释。如果有多段文本（用 \\n<<<###>>>\\n 分隔），请按相同顺序翻译并用相同分隔符返回。';

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: 'translatePage',
    title: '翻译整个页面',
    contexts: ['page'],
  });
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== 'translatePage' || !tab?.id) return;
  const { bilingual = false } = await chrome.storage.local.get(['bilingual']);
  chrome.tabs.sendMessage(tab.id, { action: 'translate', bilingual });
});

// 流式请求：边接收 token 边按分隔符推送已完成的段落给 content.js
async function chatCompleteStream({ apiUrl, apiKey, model, sysPrompt, userText, tabId, batchId, texts }) {
  const res = await fetch(apiUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: sysPrompt },
        { role: 'user', content: userText },
      ],
      temperature: 0.3,
      stream: true,
    }),
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status} ${errText.slice(0, 100)}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let sseBuffer = '';
  let textBuffer = '';
  let segIdx = 0;

  const pushSegment = (text) => {
    text = text.trim();
    if (!text || segIdx >= texts.length) return;
    chrome.tabs.sendMessage(tabId, {
      action: 'streamSegment',
      batchId,
      index: segIdx,
      original: texts[segIdx],
      text,
    }).catch(() => {});
    segIdx++;
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      sseBuffer += decoder.decode(value, { stream: true });
      const lines = sseBuffer.split('\n');
      sseBuffer = lines.pop();
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const data = line.slice(6).trim();
        if (data === '[DONE]') continue;
        try {
          const delta = JSON.parse(data)?.choices?.[0]?.delta?.content;
          if (delta) textBuffer += delta;
        } catch {}
      }
      // 检测到分隔符就立即推出已完成的段
      let idx;
      while ((idx = textBuffer.indexOf('<<<###>>>')) !== -1) {
        pushSegment(textBuffer.slice(0, idx));
        textBuffer = textBuffer.slice(idx + 9);
      }
    }
  } finally {
    if (textBuffer.trim()) pushSegment(textBuffer);
    chrome.tabs.sendMessage(tabId, { action: 'streamDone', batchId }).catch(() => {});
  }
}

async function chatComplete({ apiUrl, apiKey, model, sysPrompt, userText }) {
  const res = await fetch(apiUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: sysPrompt },
        { role: 'user', content: userText },
      ],
      temperature: 0.3,
      stream: false,
    }),
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status} ${errText.slice(0, 100)}`);
  }
  const data = await res.json();
  const content = data?.choices?.[0]?.message?.content;
  if (!content) throw new Error('模型返回为空');
  return content;
}

async function translateTexts(texts) {
  const { apiUrl, apiKey, model, prompt } = await chrome.storage.local.get([
    'apiUrl', 'apiKey', 'model', 'prompt',
  ]);
  if (!apiUrl) throw new Error('未配置 API 地址');
  if (!apiKey) throw new Error('未配置 API Key');
  if (!model) throw new Error('未配置模型');

  const sysPrompt = prompt || DEFAULT_PROMPT;
  const opts = { apiUrl, apiKey, model, sysPrompt };

  // 单条直接翻译
  if (texts.length === 1) {
    const out = await chatComplete({ ...opts, userText: texts[0] });
    return [out.trim()];
  }

  // 多条合并，模型按分隔符返回
  const content = await chatComplete({ ...opts, userText: texts.join(SEP) });
  const parts = content.split(/\n?<<<###>>>\n?/).map(s => s.trim());
  if (parts.length === texts.length) return parts;

  // 切片不齐，回退为逐条翻译
  const out = [];
  for (const text of texts) {
    try {
      const t = await chatComplete({ ...opts, userText: text });
      out.push(t.trim());
    } catch {
      out.push(text);
    }
  }
  return out;
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.action === 'bgTranslateStream') {
    const tabId = _sender.tab?.id;
    if (!tabId) { sendResponse({ ok: false, error: 'no tabId' }); return; }
    const { batchId, texts } = msg;
    (async () => {
      try {
        const { apiUrl, apiKey, model, prompt } = await chrome.storage.local.get(['apiUrl', 'apiKey', 'model', 'prompt']);
        if (!apiUrl) throw new Error('未配置 API 地址');
        if (!apiKey) throw new Error('未配置 API Key');
        if (!model)  throw new Error('未配置模型');
        const sysPrompt = prompt || DEFAULT_PROMPT;
        const userText = texts.length === 1 ? texts[0] : texts.join(SEP);
        await chatCompleteStream({ apiUrl, apiKey, model, sysPrompt, userText, tabId, batchId, texts });
        sendResponse({ ok: true });
      } catch (e) {
        chrome.tabs.sendMessage(tabId, { action: 'streamDone', batchId, error: e.message }).catch(() => {});
        sendResponse({ ok: false, error: e.message });
      }
    })();
    return true;
  }
  if (msg.action === 'bgTts') {
    (async () => {
      try {
        const { mimoApiKey } = await chrome.storage.local.get(['mimoApiKey']);
        if (!mimoApiKey) { sendResponse({ ok: false, error: '未配置 MiMo API Key' }); return; }
        const res = await fetch('https://api.xiaomimimo.com/v1/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${mimoApiKey}` },
          body: JSON.stringify({
            model: 'mimo-v2.5-tts',
            messages: [{ role: 'assistant', content: msg.text }],
            audio: { format: 'wav', voice: 'Mia' },
          }),
        });
        if (!res.ok) { const t = await res.text().catch(() => ''); throw new Error(`HTTP ${res.status} ${t.slice(0, 80)}`); }
        const data = await res.json();
        const b64 = data?.choices?.[0]?.message?.audio?.data;
        if (!b64) throw new Error('MiMo 返回为空');
        sendResponse({ ok: true, audio: b64 });
      } catch (e) {
        sendResponse({ ok: false, error: e.message });
      }
    })();
    return true;
  }
  if (msg.action === 'bgTranslate') {
    translateTexts(msg.texts)
      .then(results => sendResponse({ ok: true, results }))
      .catch(e => sendResponse({ ok: false, error: e.message }));
    return true;
  }
  if (msg.action === 'shouldAutoTranslate') {
    chrome.storage.local.get([
      'alwaysSites', 'bilingual', 'apiKey', 'autoTranslateEnglish',
    ]).then(s => {
      const sites = Array.isArray(s.alwaysSites) ? s.alwaysSites : [];
      sendResponse({
        hasApi: !!s.apiKey,
        inAlwaysList: sites.includes(msg.host),
        autoEn: !!s.autoTranslateEnglish,
        bilingual: !!s.bilingual,
      });
    });
    return true;
  }
});
