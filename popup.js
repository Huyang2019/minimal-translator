const DEFAULT_PROMPT = '你是专业翻译助手。请把用户提供的文本翻译为简体中文，保持原意和语气，仅返回译文，不要任何解释。如果有多段文本（用 \\n<<<###>>>\\n 分隔），请按相同顺序翻译并用相同分隔符返回。';

const DEFAULTS = {
  apiUrl: 'https://api.openai.com/v1/chat/completions',
  apiKey: '',
  model: 'gpt-4o-mini',
  prompt: DEFAULT_PROMPT,
  bilingual: false,
  hoverTranslate: false,
  alwaysSites: [],
  autoTranslateEnglish: false,
  inlineTts: false,
  ttsEngine: 'browser',
  mimoApiKey: '',
};

const SETTING_FIELDS = ['apiUrl', 'apiKey', 'model', 'prompt', 'mimoApiKey'];

let cfg = { ...DEFAULTS };
let currentHost = '';
let isTranslated = false;

const $ = id => document.getElementById(id);

async function load() {
  cfg = await chrome.storage.local.get(DEFAULTS);
  if (!Array.isArray(cfg.alwaysSites)) cfg.alwaysSites = [];
}

const save = () => chrome.storage.local.set(cfg);

const setStatus = (type, text) => {
  $('dot').className = 'dot ' + (type || '');
  $('statusText').textContent = text;
};

const setTranslateBtn = (label, disabled = false) => {
  const btn = $('btnTranslate');
  btn.textContent = label;
  btn.disabled = disabled;
};

function renderToggles() {
  $('toggleBilingual').classList.toggle('on', cfg.bilingual);
  $('toggleHover').classList.toggle('on', cfg.hoverTranslate);
  $('toggleAutoEn').classList.toggle('on', cfg.autoTranslateEnglish);
  $('toggleInlineTts').classList.toggle('on', cfg.inlineTts);
  $('btnRestore').disabled = !isTranslated;
}

function renderSettings() {
  SETTING_FIELDS.forEach(k => $(k).value = cfg[k]);
  $('ttsEngine').value = cfg.ttsEngine || 'browser';
  $('mimoKeyRow').style.display = cfg.ttsEngine === 'mimo' ? 'block' : 'none';
}

// 从设置面板回写到 cfg
function readSettings() {
  for (const k of SETTING_FIELDS) cfg[k] = $(k).value.trim();
  if (!cfg.prompt) cfg.prompt = DEFAULT_PROMPT;
  cfg.ttsEngine = $('ttsEngine').value;
}

$('ttsEngine').addEventListener('change', () => {
  $('mimoKeyRow').style.display = $('ttsEngine').value === 'mimo' ? 'block' : 'none';
});

async function getTab() {
  const [t] = await chrome.tabs.query({ active: true, currentWindow: true });
  return t;
}

async function send(msg) {
  const t = await getTab();
  return chrome.tabs.sendMessage(t.id, msg);
}

async function doTranslate() {
  setStatus('loading', '正在翻译…');
  setTranslateBtn('翻译中…', true);
  try {
    const res = await send({ action: 'translate', bilingual: cfg.bilingual });
    if (res?.success) {
      isTranslated = true;
      setStatus('ok', `已翻译 ${res.count} 段`);
      setTranslateBtn('重新翻译');
    } else {
      setStatus('err', res?.error || '翻译失败');
      setTranslateBtn('翻译此页面');
    }
  } catch {
    setStatus('err', '请刷新页面后重试');
    setTranslateBtn('翻译此页面');
  }
  renderToggles();
}

$('btnTranslate').addEventListener('click', () => {
  if (!cfg.apiKey || !cfg.apiUrl || !cfg.model) {
    setStatus('err', '请先在「模型设置」中配置 API');
    $('settingsPanel').classList.add('show');
    return;
  }
  doTranslate();
});

$('btnRestore').addEventListener('click', async () => {
  try {
    await send({ action: 'restore' });
    isTranslated = false;
    setStatus('', '已还原原文');
    setTranslateBtn('翻译此页面');
    renderToggles();
  } catch {
    setStatus('err', '操作失败');
  }
});

$('toggleAutoEn').addEventListener('click', () => {
  cfg.autoTranslateEnglish = !cfg.autoTranslateEnglish;
  save();
  renderToggles();
});

$('toggleBilingual').addEventListener('click', () => {
  cfg.bilingual = !cfg.bilingual;
  save();
  renderToggles();
});

$('toggleHover').addEventListener('click', async () => {
  cfg.hoverTranslate = !cfg.hoverTranslate;
  await save();
  renderToggles();
  try { await send({ action: 'setHover', enabled: cfg.hoverTranslate }); } catch {}
});

$('toggleInlineTts').addEventListener('click', async () => {
  cfg.inlineTts = !cfg.inlineTts;
  await save();
  renderToggles();
  try { await send({ action: 'setInlineTts', enabled: cfg.inlineTts }); } catch {}
});

$('btnSettings').addEventListener('click', () => $('settingsPanel').classList.toggle('show'));

$('btnSave').addEventListener('click', async () => {
  readSettings();
  await save();
  setStatus('ok', '设置已保存');
});

$('btnTest').addEventListener('click', async () => {
  readSettings();
  await save();
  setStatus('loading', '测试中…');
  const res = await chrome.runtime.sendMessage({ action: 'bgTranslate', texts: ['Hello, world!'] });
  if (res?.ok) setStatus('ok', '测试成功：' + (res.results[0] || '').slice(0, 20));
  else setStatus('err', '测试失败：' + (res?.error || '未知错误'));
});

(async () => {
  await load();
  const tab = await getTab();
  try {
    currentHost = new URL(tab.url).hostname;
    $('siteText').textContent = currentHost;
  } catch {
    $('siteText').textContent = '此页面不可翻译';
  }
  renderToggles();
  renderSettings();
  try {
    const s = await send({ action: 'getState' });
    if (s?.isTranslated) {
      isTranslated = true;
      setStatus('ok', '页面已翻译');
      renderToggles();
    }
  } catch {}
})();
