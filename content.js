(() => {
  // 防止重复注入
  if (window.__daFanYiLoaded) return;
  window.__daFanYiLoaded = true;

  const state = {
    isTranslated: false,
    bilingual: false,              // 当前翻译模式（首次 translatePage 时设置）
    hoverEnabled: false,
    originalTexts: new Map(),      // node -> originalText（element 存 innerHTML）
    hoverTooltip: null,
    hoverTimer: null,
    mutationObserver: null,
    intersectionObserver: null,    // 监视句子级容器进入视口时重新校验
    pendingNodes: new Set(),
    flushTimer: null,
    inflight: new WeakSet(),       // 正在翻译队列中的节点，避免重复入队
  };

  // 不翻译的标签
  const SKIP_TAGS = new Set([
    'SCRIPT', 'STYLE', 'NOSCRIPT', 'IFRAME', 'CANVAS', 'SVG',
    'CODE', 'PRE', 'KBD', 'SAMP', 'VAR', 'MATH',
  ]);

  // 句子级容器：整体作为一个翻译单元（避免被内部 span 拆词翻译，
  // 比如 Webflow stagger 动画把 h1 拆成每个单词一个 span 的情况）
  const SENTENCE_SELECTOR = 'h1, h2, h3, h4, h5, h6, blockquote, figcaption, [role="heading"]';

  // 取节点文本：element 优先 innerText（接近视觉），为空回退 textContent
  // （stagger 动画初始 opacity:0 时 innerText 返回空，会漏掉标题）
  function getText(node) {
    if (node.nodeType === Node.ELEMENT_NODE) {
      return (node.innerText || node.textContent || '').trim();
    }
    return (node.textContent || '').trim();
  }

  // 收集页面中所有需要翻译的单元（text node + 句子级 element）
  function collectTextNodes(root) {
    root = root || document.body;
    const nodes = [];

    // 1) 先收集句子级元素，作为整体翻译单元
    const containerEls = root.matches && root.matches(SENTENCE_SELECTOR)
      ? [root, ...root.querySelectorAll(SENTENCE_SELECTOR)]
      : [...root.querySelectorAll(SENTENCE_SELECTOR)];

    for (const el of containerEls) {
      if (el.closest('script,style,noscript')) continue;
      // 嵌套：若已被外层 sentence 容器包含则跳过（避免重复翻译）
      if (el.parentElement && el.parentElement.closest(SENTENCE_SELECTOR)) continue;
      const text = getText(el);
      if (!text || text.length < 2) continue;
      if (isMostlyChinese(text)) continue;
      nodes.push(el);
    }

    // 2) 再收集普通文本节点，跳过句子级容器的子树
    const walker = document.createTreeWalker(
      root,
      NodeFilter.SHOW_TEXT,
      {
        acceptNode(node) {
          const parent = node.parentElement;
          if (!parent) return NodeFilter.FILTER_REJECT;
          if (SKIP_TAGS.has(parent.tagName)) return NodeFilter.FILTER_REJECT;
          if (parent.closest('script,style,noscript')) return NodeFilter.FILTER_REJECT;
          if (parent.closest(SENTENCE_SELECTOR)) return NodeFilter.FILTER_REJECT;
          const text = node.textContent.trim();
          if (!text || text.length < 2) return NodeFilter.FILTER_REJECT;
          if (isMostlyChinese(text)) return NodeFilter.FILTER_REJECT;
          return NodeFilter.FILTER_ACCEPT;
        }
      }
    );
    let n;
    while ((n = walker.nextNode())) nodes.push(n);
    return nodes;
  }

  function isMostlyChinese(text) {
    const chineseChars = (text.match(/[一-鿿㐀-䶿]/g) || []).length;
    return chineseChars / text.length > 0.3;
  }

  // 检测页面语言：返回 'en' / 'zh' / 'other' / 'unknown'（'unknown' 表示 DOM 还太空）
  function detectPageLang() {
    const lang = (document.documentElement.lang || '').toLowerCase();
    // <html lang> 不绝对可信（x.com 即使中文用户也写 lang="en"），仅作弱信号
    if (lang.startsWith('zh') && document.body.innerText.length > 200) return 'zh';

    // 采样可见文本
    let sampled = '';
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let n;
    while ((n = walker.nextNode()) && sampled.length < 2000) {
      const p = n.parentElement;
      if (!p || SKIP_TAGS.has(p.tagName)) continue;
      const t = n.textContent.trim();
      if (t.length >= 2) sampled += t + ' ';
    }
    if (sampled.length < 80) return 'unknown';

    const chinese = (sampled.match(/[一-鿿]/g) || []).length;
    const letters = (sampled.match(/[a-zA-Z]/g) || []).length;
    const total = sampled.length;
    if (chinese / total > 0.2) return 'zh';
    if (letters / total > 0.35 && chinese / total < 0.05) return 'en';
    return 'other';
  }

  // 翻译缓存：text -> translated（页面级，跨批次复用，LRU 淘汰）
  const translationCache = new Map();
  const CACHE_MAX = 5000;         // 缓存上限：约 5000 条文本
  const CONCURRENCY = 5;          // 并发请求数
  const SHORT_THRESHOLD = 30;     // 短文本字符数阈值
  const SHORT_BATCH_SIZE = 50;    // 短文本批次（导航/按钮，单批可塞很多）
  const LONG_BATCH_SIZE = 10;     // 长文本批次（段落，token 多）

  function cacheGet(text) {
    if (!translationCache.has(text)) return undefined;
    // LRU：取出后重新插入，移到 Map 末尾（最新使用）
    const v = translationCache.get(text);
    translationCache.delete(text);
    translationCache.set(text, v);
    return v;
  }

  function cacheSet(text, translated) {
    if (translationCache.has(text)) translationCache.delete(text);
    translationCache.set(text, translated);
    // 超出上限时淘汰最旧的（Map 迭代器按插入顺序）
    while (translationCache.size > CACHE_MAX) {
      const oldestKey = translationCache.keys().next().value;
      translationCache.delete(oldestKey);
    }
  }

  function chunk(arr, size) {
    const out = [];
    for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
    return out;
  }

  // 优先级排序：标题/视口内的优先翻译，结果先呈现
  // 顺序：① 视口内标题 → ② 视口内正文 → ③ 视口外标题 → ④ 视口外正文
  function sortByViewport(nodes) {
    const vh = window.innerHeight;
    const buckets = [[], [], [], []];
    for (const node of nodes) {
      const isEl = node.nodeType === Node.ELEMENT_NODE;
      const target = isEl ? node : node.parentElement;
      let inView = false;
      if (target) {
        const rect = target.getBoundingClientRect();
        inView = rect.bottom > 0 && rect.top < vh;
      }
      const idx = isEl ? (inView ? 0 : 2) : (inView ? 1 : 3);
      buckets[idx].push(node);
    }
    return [...buckets[0], ...buckets[1], ...buckets[2], ...buckets[3]];
  }

  // 非流式：单条文本（悬浮取词）
  async function translateBatch(texts) {
    const response = await chrome.runtime.sendMessage({ action: 'bgTranslate', texts });
    if (!response) throw new Error('插件未响应');
    if (!response.ok) throw new Error(response.error || '翻译失败');
    return response.results;
  }

  // 流式注册表：batchId → { texts, text2nodes, bilingual, resolve, reject }
  const streamRegistry = new Map();

  // 流式批翻译：每段完成立即应用，无需等整批返回
  function translateBatchStream(batch, text2nodes, bilingual) {
    const batchId = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      streamRegistry.set(batchId, { texts: batch, text2nodes, bilingual, resolve, reject });
      chrome.runtime.sendMessage({ action: 'bgTranslateStream', texts: batch, batchId })
        .catch(e => { streamRegistry.delete(batchId); reject(e); });
    });
  }

  // 并发限流执行：tasks 是返回 Promise 的函数数组
  async function runWithConcurrency(tasks, limit) {
    const results = new Array(tasks.length);
    let cursor = 0;
    const workers = Array.from({ length: Math.min(limit, tasks.length) }, async () => {
      while (true) {
        const idx = cursor++;
        if (idx >= tasks.length) return;
        try { results[idx] = await tasks[idx](); }
        catch (e) { results[idx] = { __error: e }; }
      }
    });
    await Promise.all(workers);
    return results;
  }

  // 应用翻译结果（element 存 innerHTML、text node 存 textContent）
  function applyTranslation(node, translated, bilingual) {
    const isEl = node.nodeType === Node.ELEMENT_NODE;
    // 仅首次记录原文；如果已存在（说明节点之前被翻译过、又被外部覆盖回英文），保留最初的原文
    if (!state.originalTexts.has(node)) {
      state.originalTexts.set(node, isEl ? node.innerHTML : node.textContent);
    }

    if (bilingual) {
      const span = document.createElement('span');
      span.className = '__dfy-translated';
      span.textContent = translated;
      span.style.cssText = 'display:block;color:#a78bfa;font-size:0.9em;margin-top:2px;';
      node.parentNode?.insertBefore(span, node.nextSibling);
    } else {
      node.textContent = translated;
    }
  }

  // 翻译给定的一组文本节点（核心：去重 + 缓存 + 并发 + 可视优先 + 短/长分批）
  async function translateNodes(nodeList, bilingual) {
    if (!nodeList || nodeList.length === 0) return { count: 0, failed: 0 };

    nodeList = sortByViewport(nodeList);

    // 去重
    const text2nodes = new Map();
    for (const node of nodeList) {
      if (!node.isConnected) continue;
      if (state.inflight.has(node)) continue;               // 正在翻译队列里
      const t = getText(node);
      if (!t || isMostlyChinese(t)) continue;               // 当前已是中文则跳过
      // 注意：已翻译过的节点（state.originalTexts.has）若当前内容仍是英文，
      // 说明被外部覆盖（如 stagger 动画 JS），需要重新应用译文（缓存零成本）
      if (!text2nodes.has(t)) text2nodes.set(t, []);
      text2nodes.get(t).push(node);
      state.inflight.add(node);
    }
    if (text2nodes.size === 0) return { count: 0, failed: 0 };

    // 命中缓存的直接应用，未命中的收集起来
    const pending = [];
    for (const [text, nodes] of text2nodes) {
      const cached = cacheGet(text);
      if (cached === undefined) { pending.push(text); continue; }
      if (cached === text) continue;
      for (const node of nodes) {
        if (node.isConnected) applyTranslation(node, cached, bilingual);
      }
    }

    // 按长度拆分批次，短批次塞更多 + 排前面
    const shortTexts = [], longTexts = [];
    for (const t of pending) (t.length <= SHORT_THRESHOLD ? shortTexts : longTexts).push(t);
    const batches = [
      ...chunk(shortTexts, SHORT_BATCH_SIZE),
      ...chunk(longTexts, LONG_BATCH_SIZE),
    ];

    // 流式：每段到达即应用，无需等批次全部完成
    const tasks = batches.map(batch => () => translateBatchStream(batch, text2nodes, bilingual));

    const outcomes = await runWithConcurrency(tasks, CONCURRENCY);
    let failed = 0;
    for (const o of outcomes) if (o && o.__error) failed++;

    // 统一清理 inflight（成功/失败/缓存命中都走这一步）
    for (const nodes of text2nodes.values()) {
      for (const n of nodes) state.inflight.delete(n);
    }

    return { count: state.originalTexts.size, failed };
  }

  // 全文翻译入口（首屏优先：先翻译视口内节点，屏外节点后台并行）
  async function translatePage(bilingual) {
    if (state.isTranslated) restorePage();
    state.bilingual = bilingual;

    const allNodes = collectTextNodes();
    const vh = window.innerHeight;
    const viewportNodes = [], offscreenNodes = [];
    for (const node of allNodes) {
      const el = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
      const rect = el?.getBoundingClientRect();
      if (rect && rect.bottom > 0 && rect.top < vh) viewportNodes.push(node);
      else offscreenNodes.push(node);
    }

    // 首屏：等待完成后立即标记已翻译并开启 live 模式
    const { count, failed } = await translateNodes(viewportNodes, bilingual);
    if (viewportNodes.length > 0 && count === 0 && failed > 0) {
      return { success: false, error: '翻译请求失败，请检查 API 配置' };
    }

    state.isTranslated = true;
    startLiveMode();

    // 屏外：后台翻译，不阻塞返回
    if (offscreenNodes.length > 0) {
      translateNodes(offscreenNodes, bilingual).catch(e => console.error('[极简翻译]', e));
    }

    return { success: true, count: allNodes.length, failed };
  }

  // === Live 模式：监听 DOM 变化，自动翻译新内容（无限滚动、SPA 路由切换等） ===
  function isInsideSkip(el) {
    return !el || !!el.closest?.('script,style,noscript,#__dfy-tooltip');
  }

  function queueNode(node) {
    if (!node) return;
    const isText = node.nodeType === Node.TEXT_NODE;
    const isEl = node.nodeType === Node.ELEMENT_NODE;
    if (!isText && !isEl) return;

    const startEl = isEl ? node : node.parentElement;
    if (!startEl || isInsideSkip(startEl)) return;
    if (isText && SKIP_TAGS.has(startEl.tagName)) return;

    // 优先回溯到句子级容器整体翻译，避免被拆词
    const sentence = startEl.closest(SENTENCE_SELECTOR);
    if (sentence) {
      if (state.inflight.has(sentence)) return;  // 已在翻译队列里
      const t = getText(sentence);
      if (!t || t.length < 2 || isMostlyChinese(t)) return;
      // 已翻译过但被外部覆盖回英文（如 stagger 动画 JS 重写 innerHTML）→ 重新入队
      // 缓存命中时零成本，二次 applyTranslation 不会覆盖最初记录的原文
      state.pendingNodes.add(sentence);
      return;
    }

    if (isText) {
      if (state.inflight.has(node)) return;
      const t = node.textContent.trim();
      if (t && t.length >= 2 && !isMostlyChinese(t)) state.pendingNodes.add(node);
    } else {
      // element 子树：collectTextNodes 内部已识别句子级容器
      for (const tn of collectTextNodes(node)) {
        if (!state.inflight.has(tn)) state.pendingNodes.add(tn);
      }
    }
  }

  async function flushPending() {
    if (state.pendingNodes.size === 0) return;
    const batch = [...state.pendingNodes];
    state.pendingNodes.clear();
    try { await translateNodes(batch, state.bilingual); }
    catch (e) { console.error('[极简翻译] live flush 失败:', e); }
  }

  // 让句子级容器进入视口时重新检查：用于对抗 stagger 动画 JS 持续把译文重写回英文
  function observeSentences(root) {
    if (!state.intersectionObserver) return;
    const els = root.matches?.(SENTENCE_SELECTOR)
      ? [root, ...root.querySelectorAll(SENTENCE_SELECTOR)]
      : [...root.querySelectorAll(SENTENCE_SELECTOR)];
    for (const el of els) state.intersectionObserver.observe(el);
  }

  function startLiveMode() {
    if (state.mutationObserver) return;

    state.intersectionObserver = new IntersectionObserver(entries => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const el = entry.target;
        if (state.inflight.has(el)) continue;
        const t = getText(el);
        if (t && t.length >= 2 && !isMostlyChinese(t)) state.pendingNodes.add(el);
      }
      if (state.pendingNodes.size > 0) {
        clearTimeout(state.flushTimer);
        state.flushTimer = setTimeout(flushPending, 100);  // 视口触发更紧凑
      }
    }, { rootMargin: '200px' });
    observeSentences(document.body);

    state.mutationObserver = new MutationObserver(mutations => {
      for (const m of mutations) {
        if (m.type === 'childList') {
          for (const node of m.addedNodes) {
            queueNode(node);
            if (node.nodeType === Node.ELEMENT_NODE) observeSentences(node);
          }
        } else if (m.type === 'characterData') {
          queueNode(m.target);
        } else if (m.type === 'attributes') {
          // class/style/hidden 变化可能意味着隐藏的卡片/面板变为可见
          const el = m.target;
          if (el.nodeType === Node.ELEMENT_NODE && !isInsideSkip(el)) {
            queueNode(el);
          }
        }
      }
      if (state.pendingNodes.size > 0) {
        clearTimeout(state.flushTimer);
        state.flushTimer = setTimeout(flushPending, 250);
      }
    });
    state.mutationObserver.observe(document.body, {
      childList: true, subtree: true, characterData: true,
      attributes: true, attributeFilter: ['class', 'style', 'hidden', 'aria-hidden'],
    });
  }

  function stopLiveMode() {
    state.mutationObserver?.disconnect();
    state.mutationObserver = null;
    state.intersectionObserver?.disconnect();
    state.intersectionObserver = null;
    clearTimeout(state.flushTimer);
    state.pendingNodes.clear();
  }

  function restorePage() {
    stopLiveMode();
    for (const [node, original] of state.originalTexts) {
      if (!node.isConnected) continue;
      if (node.nodeType === Node.ELEMENT_NODE) node.innerHTML = original;
      else node.textContent = original;
    }
    state.originalTexts.clear();
    document.querySelectorAll('.__dfy-translated').forEach(el => el.remove());
    state.isTranslated = false;
  }

  // === 悬浮取词翻译 ===
  const TOOLTIP_WRAP_STYLE = [
    'position:fixed', 'z-index:2147483647',
    'background:#ffffff', 'color:#111827',
    'border:1px solid #e5e7eb', 'border-radius:10px',
    'padding:10px 14px', 'font-size:14px', 'line-height:1.55',
    'font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Segoe UI",sans-serif',
    'max-width:340px', 'box-shadow:0 10px 28px rgba(0,0,0,.18),0 2px 6px rgba(0,0,0,.08)',
    'display:none', 'word-break:break-word',
  ].join(';');

  // 当前正在朗读的原文（用于按钮状态切换）
  let _ttsText = '';

  // 智能选取最优英语声音（首次调用后缓存）
  let _enVoice = null;
  function pickEnVoice() {
    if (_enVoice) return _enVoice;
    const voices = speechSynthesis.getVoices();
    const prefer = ['Microsoft Ava', 'Microsoft Jenny', 'Google US English', 'Samantha', 'Karen'];
    for (const name of prefer) {
      const v = voices.find(v => v.name.includes(name));
      if (v) { _enVoice = v; return v; }
    }
    _enVoice = voices.find(v => v.lang.startsWith('en')) || null;
    return _enVoice;
  }
  speechSynthesis.addEventListener('voiceschanged', () => { _enVoice = null; });

  function setBtnActive(btn, active) {
    if (!btn) return;
    btn.dataset.active = active ? '1' : '0';
    btn.style.background = active ? '#ede9fe' : '#f3f4f6';
    btn.style.color = active ? '#7c3aed' : '#6b7280';
  }

  async function speakText(text, btn) {
    window.speechSynthesis.cancel();
    const { ttsEngine } = await chrome.storage.local.get({ ttsEngine: 'browser' });

    if (ttsEngine === 'mimo') {
      setBtnActive(btn, true);
      let res;
      try { res = await chrome.runtime.sendMessage({ action: 'bgTts', text }); }
      catch { setBtnActive(btn, false); return; }
      if (!res?.ok) { setBtnActive(btn, false); return; }
      const bytes = Uint8Array.from(atob(res.audio), c => c.charCodeAt(0));
      const blob = new Blob([bytes], { type: 'audio/wav' });
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      audio.onended = audio.onerror = () => { URL.revokeObjectURL(url); setBtnActive(btn, false); };
      audio.play();
    } else {
      const utt = new SpeechSynthesisUtterance(text);
      utt.lang = 'en-US';
      utt.rate = 1;
      const voice = pickEnVoice();
      if (voice) utt.voice = voice;
      setBtnActive(btn, true);
      utt.onend = utt.onerror = () => setBtnActive(btn, false);
      speechSynthesis.speak(utt);
    }
  }

  function getTooltip() {
    if (state.hoverTooltip) return state.hoverTooltip;
    const wrap = document.createElement('div');
    wrap.id = '__dfy-tooltip';
    wrap.style.cssText = TOOLTIP_WRAP_STYLE;

    // 顶部行：译文 + 朗读按钮
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;align-items:flex-start;gap:8px;';

    const textEl = document.createElement('span');
    textEl.className = '__dfy-tip-text';
    textEl.style.cssText = 'flex:1;';

    const btn = document.createElement('button');
    btn.className = '__dfy-tip-play';
    btn.title = '朗读原文';
    btn.style.cssText = [
      'flex-shrink:0', 'width:28px', 'height:28px', 'border:none',
      'border-radius:6px', 'background:#f3f4f6', 'cursor:pointer',
      'display:flex', 'align-items:center', 'justify-content:center',
      'padding:0', 'color:#6b7280', 'transition:background .15s',
    ].join(';');
    btn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3A4.5 4.5 0 0 0 14 7.97v8.05c1.48-.73 2.5-2.25 2.5-4.02z"/></svg>';

    btn.addEventListener('mousedown', e => {
      e.stopPropagation(); // 不触发 document mousedown → hideTooltip
    });
    btn.addEventListener('click', e => {
      e.stopPropagation();
      if (window.speechSynthesis.speaking) {
        window.speechSynthesis.cancel();
        setBtnActive(btn, false);
        return;
      }
      if (_ttsText) speakText(_ttsText, btn);
    });

    row.appendChild(textEl);
    row.appendChild(btn);
    wrap.appendChild(row);
    document.body.appendChild(wrap);
    return state.hoverTooltip = wrap;
  }

  function showTooltip(text, x, y) {
    _ttsText = text;
    const wrap = getTooltip();
    const textEl = wrap.querySelector('.__dfy-tip-text');
    const btn = wrap.querySelector('.__dfy-tip-play');

    // 停止上次朗读，重置按钮
    window.speechSynthesis.cancel();
    setBtnActive(btn, false);

    textEl.textContent = '翻译中…';
    textEl.style.color = '#6b7280';
    wrap.style.display = 'block';
    wrap.style.left = Math.min(x + 14, window.innerWidth - 360) + 'px';
    wrap.style.top = (y + 20) + 'px';

    translateBatch([text]).then(([result]) => {
      if (wrap.style.display === 'none') return;
      textEl.textContent = result || text;
      textEl.style.color = '#111827';
    }).catch(() => {
      if (wrap.style.display !== 'none') {
        textEl.textContent = '翻译失败';
        textEl.style.color = '#dc2626';
      }
    });
  }

  function hideTooltip() {
    if (state.hoverTooltip) {
      state.hoverTooltip.style.display = 'none';
      window.speechSynthesis.cancel();
    }
  }

  document.addEventListener('mouseup', e => {
    if (!state.hoverEnabled) return;
    if (state.hoverTooltip?.contains(e.target)) return; // 悬浮框内部点击不触发重定位
    clearTimeout(state.hoverTimer);
    const sel = window.getSelection()?.toString().trim() || '';
    // 单字母名词（"AI"、"I" 等）和已含中文的术语都强制翻译；只过滤空选择和过长选择
    if (sel.length >= 1 && sel.length < 500) {
      state.hoverTimer = setTimeout(() => showTooltip(sel, e.clientX, e.clientY), 400);
    } else {
      hideTooltip();
    }
  });

  document.addEventListener('mousedown', () => {
    clearTimeout(state.hoverTimer);
    hideTooltip();
  });

  // 监听来自 popup / background 的消息
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    switch (msg.action) {
      case 'streamSegment': {
        const reg = streamRegistry.get(msg.batchId);
        if (reg) {
          const { text2nodes, bilingual } = reg;
          const { original, text: translated } = msg;
          if (translated && original && translated !== original) {
            cacheSet(original, translated);
            for (const node of text2nodes.get(original) || []) {
              if (node.isConnected) applyTranslation(node, translated, bilingual);
            }
          }
        }
        break;
      }
      case 'streamDone': {
        const reg = streamRegistry.get(msg.batchId);
        if (reg) {
          streamRegistry.delete(msg.batchId);
          if (msg.error) reg.reject(new Error(msg.error));
          else reg.resolve();
        }
        break;
      }
      case 'translate':
        translatePage(msg.bilingual)
          .then(res => sendResponse(res))
          .catch(e => sendResponse({ success: false, error: e.message }));
        return true; // 异步响应

      case 'restore':
        restorePage();
        sendResponse({ success: true });
        break;

      case 'setHover':
        state.hoverEnabled = !!msg.enabled;
        sendResponse({ success: true });
        break;

      case 'getState':
        sendResponse({ isTranslated: state.isTranslated, hoverEnabled: state.hoverEnabled });
        break;
    }
  });

  // 内置默认必翻域名：这些站点 SPA 渲染慢、用 lang="en" 但用户明确要中文，直接强制翻译
  const DEFAULT_ALWAYS_HOSTS = new Set([
    'x.com', 'twitter.com', 'mobile.x.com', 'mobile.twitter.com',
  ]);

  function hostMatches(host, set) {
    if (set.has(host)) return true;
    // 子域名匹配（如 m.x.com）
    for (const h of set) if (host.endsWith('.' + h)) return true;
    return false;
  }

  // 启动时询问 background：当前域名是否需要自动翻译
  (async function autoCheck() {
    if (window.top !== window) return; // 跳过 iframe

    // 恢复悬浮取词开关（页面刷新后 state.hoverEnabled 默认 false，需从存储读取）
    try {
      const stored = await chrome.storage.local.get({ hoverTranslate: false });
      state.hoverEnabled = !!stored.hoverTranslate;
    } catch {}

    let res;
    try {
      res = await chrome.runtime.sendMessage({
        action: 'shouldAutoTranslate',
        host: location.hostname,
      });
    } catch (e) {
      console.warn('[极简翻译] 自动翻译检查失败:', e);
      return;
    }
    if (!res?.hasApi) return;

    // 用户显式白名单 或 内置默认必翻域名 → 直接翻译，不做语言检测
    if (res.inAlwaysList || hostMatches(location.hostname, DEFAULT_ALWAYS_HOSTS)) {
      setTimeout(() => translatePage(res.bilingual), 300);
      return;
    }
    if (!res.autoEn) return;

    // 英文检测：SPA 首屏 DOM 可能还很空，重试最多 6 次
    const delays = [300, 800, 1500, 2000, 2000, 2000];
    for (const d of delays) {
      await new Promise(r => setTimeout(r, d));
      if (state.isTranslated) return;
      const lang = detectPageLang();
      if (lang === 'en') { translatePage(res.bilingual); return; }
      if (lang === 'zh' || lang === 'other') return;
    }
  })();
})();
