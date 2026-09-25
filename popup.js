/* Human Typer: popup: settings, text box, time estimate, start/pause/stop. */
const HT = self.HumanTyper;
const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

let S = HT.clone(HT.DEFAULTS);
let tab = null;
let saveT = 0;
let etaT = 0;
let pollT = 0;

const getPath = (o, p) => p.split('.').reduce((x, k) => (x == null ? x : x[k]), o);
function setPath(o, p, v) {
  const ks = p.split('.');
  let x = o;
  for (const k of ks.slice(0, -1)) x = x[k] = x[k] && typeof x[k] === 'object' ? x[k] : {};
  x[ks[ks.length - 1]] = v;
}

const FIX_HINT = {
  leave: 'Typos stay in the text, like a quick first draft.',
  backspace: 'Notices the typo, backspaces back to it and retypes.',
  arrows: 'Notices later, arrows back to the typo, fixes it, then arrows forward again.',
  mix: 'A human mix: some backspaced, some arrowed back to, some left in.',
};
const ENGINE_HINT = {
  debugger: 'Real keystrokes via Chrome’s debugger. Works in Google Docs and rich editors. Chrome shows a “started debugging this browser” bar while typing.',
  dom: 'Synthetic events with no banner. Works in normal inputs and most editors, but some sites (e.g. Google Docs) ignore it.',
};

// ---------------------------------------------------------------- init

init();

async function init() {
  const stored = await chrome.storage.local.get(['settings', 'text']);
  S = HT.merge(HT.DEFAULTS, stored.settings || {});
  $('#text').value = stored.text || '';

  const preset = $('#preset');
  for (const [id, p] of Object.entries(HT.PRESETS)) preset.add(new Option(p.label, id));
  const custom = new Option('Custom', 'custom');
  custom.hidden = true;
  preset.add(custom);
  preset.addEventListener('change', () => {
    S = HT.applyPreset(S, preset.value);
    changed();
  });

  const layout = $('#layout');
  for (const [id, l] of Object.entries(HT.LAYOUTS)) layout.add(new Option(l.label, id));

  bind();
  initFolds();
  render();
  estimate();
  showShortcuts();

  [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  pollStatus();
}

function bind() {
  for (const el of $$('[data-k]')) {
    const k = el.dataset.k;
    if (el.classList.contains('seg')) {
      el.addEventListener('click', (e) => {
        const b = e.target.closest('button');
        if (b) update(k, b.value);
      });
    } else if (el.type === 'checkbox') {
      el.addEventListener('change', () => update(k, el.checked));
    } else if (el.type === 'range' || el.type === 'number') {
      el.addEventListener('input', () => {
        const v = parseFloat(el.value);
        if (Number.isFinite(v)) update(k, v);
      });
      el.addEventListener('change', () => {
        const lo = el.min === '' ? -Infinity : +el.min;
        const hi = el.max === '' ? Infinity : +el.max;
        const v = Math.min(hi, Math.max(lo, parseFloat(el.value) || 0));
        el.value = v;
        update(k, v);
      });
    } else {
      el.addEventListener('change', () => update(k, el.value));
    }
  }

  $('#text').addEventListener('input', () => {
    clearTimeout(saveT);
    saveT = setTimeout(save, 300);
    estimate();
  });
  $('#pasteBtn').addEventListener('click', async () => {
    try {
      const t = await navigator.clipboard.readText();
      if (t) {
        $('#text').value = t;
        save();
        estimate();
      }
    } catch (e) {
      showError('Could not read the clipboard. Paste into the box with ⌘/Ctrl+V instead.');
    }
  });
  $('#clearBtn').addEventListener('click', () => {
    $('#text').value = '';
    save();
    estimate();
    $('#text').focus();
  });

  $('#startBtn').addEventListener('click', start);
  $('#pauseBtn').addEventListener('click', async () => {
    const resume = $('#pauseBtn').dataset.action === 'resume';
    await tabMessage({ type: resume ? 'ht:resume' : 'ht:pause' });
    if (resume) window.close(); // hand focus back to the page so typing can continue
    else pollStatus();
  });
  $('#stopBtn').addEventListener('click', async () => {
    await tabMessage({ type: 'ht:stop' });
    pollStatus();
  });
  $('#editShortcuts').addEventListener('click', () => chrome.tabs.create({ url: 'chrome://extensions/shortcuts' }));
}

// Collapsible sections remember whether they were left open.
function initFolds() {
  let open = ['speed'];
  try {
    open = JSON.parse(localStorage.getItem('ht-open')) || open;
  } catch (_) {}
  for (const d of $$('details.fold')) {
    d.open = open.includes(d.dataset.sec);
    d.addEventListener('toggle', () => {
      try {
        localStorage.setItem('ht-open', JSON.stringify($$('details.fold[open]').map((x) => x.dataset.sec)));
      } catch (_) {}
    });
  }
}

const FIX_LABEL = { leave: 'left in', backspace: 'backspaced', arrows: 'arrow-fixed', mix: 'mixed fixes' };

function peek(sec) {
  switch (sec) {
    case 'speed':
      return S.speedMode === 'wpm' ? `${S.wpm} wpm` : `${S.msPerChar} ms / key`;
    case 'timing': {
      const p = [S.variance.on ? `jitter ${S.variance.amount}%` : 'no jitter'];
      if (S.rhythm) p.push('rhythm');
      if (S.drift) p.push('drift');
      if (S.fatigue) p.push(`fatigue ${S.fatigue}%`);
      return p.join(' · ');
    }
    case 'typos':
      return S.typos.on ? `${S.typos.rate}% · ${FIX_LABEL[S.typos.fix]}` : 'off';
    case 'pauses': {
      if (!S.pauses.on) return 'off';
      const P = S.pauses;
      const p = [];
      if (P.thinking) p.push(`thinking ${P.thinkingFreq}%`);
      if (P.punctuation || P.paragraph || P.hesitate) p.push(`length ${P.scale}%`);
      return p.join(' · ') || 'none';
    }
    case 'advanced':
      return `${S.engine === 'debugger' ? 'Trusted' : 'Simulated'} · ${S.newline === 'enter' ? 'Enter' : 'Shift+Enter'} · ${S.countdown}s`;
  }
  return '';
}

function update(k, v) {
  setPath(S, k, v);
  if (HT.TIMING_KEYS.includes(k.split('.')[0])) S.preset = 'custom';
  changed();
}

function changed() {
  render();
  clearTimeout(saveT);
  saveT = setTimeout(save, 200);
  estimate();
}

function save() {
  return chrome.storage.local.set({ settings: S, text: $('#text').value });
}

// ---------------------------------------------------------------- render

function render() {
  for (const el of $$('[data-k]')) {
    const v = getPath(S, el.dataset.k);
    if (el.classList.contains('seg')) {
      for (const b of el.querySelectorAll('button')) b.classList.toggle('on', b.value === String(v));
    } else if (el.type === 'checkbox') el.checked = !!v;
    else if (document.activeElement !== el) el.value = v;
  }
  for (const o of $$('output[data-out]')) o.textContent = getPath(S, o.dataset.out) + (o.dataset.suffix || '');
  for (const el of $$('[data-show]')) {
    const [k, vals] = el.dataset.show.split('=');
    el.hidden = !vals.split('|').includes(String(getPath(S, k)));
  }
  for (const el of $$('[data-dim]')) el.classList.toggle('dim', !getPath(S, el.dataset.dim));

  for (const el of $$('[data-peek]')) el.textContent = peek(el.dataset.peek);

  $('#preset').value = HT.PRESETS[S.preset] ? S.preset : 'custom';
  $('#speedHint').textContent =
    S.speedMode === 'wpm'
      ? `≈ ${Math.round(12000 / Math.max(1, S.wpm))} ms per keystroke on average`
      : `≈ ${Math.round(12000 / Math.max(1, S.msPerChar))} words per minute`;
  $('#fixHint').textContent = FIX_HINT[S.typos.fix] || '';
  $('#engineHint').textContent = ENGINE_HINT[S.engine] || '';
}

function estimate() {
  clearTimeout(etaT);
  etaT = setTimeout(() => {
    const raw = $('#text').value;
    const words = HT.countWords(raw);
    $('#counts').textContent = `${words} word${words === 1 ? '' : 's'} · ${raw.length} chars`;
    if (!raw.trim()) {
      $('#eta').textContent = '';
      return;
    }
    const text = HT.prepareText(raw, S);
    const sample = text.length > 20000 ? text.slice(0, 20000) : text;
    const plan = HT.buildPlan(sample, S, 1234);
    const ms = plan.totalMs * (text.length / Math.max(1, sample.length));
    $('#eta').textContent = `≈ ${HT.formatDuration(ms)} to type`;
  }, 120);
}

async function showShortcuts() {
  const names = {
    _execute_action: 'Open this popup',
    'type-clipboard': 'Type clipboard into focused field',
    'pause-resume': 'Pause / resume',
    stop: 'Stop',
  };
  const list = $('#shortcuts');
  const cmds = await chrome.commands.getAll();
  for (const c of cmds) {
    if (!names[c.name]) continue;
    const li = document.createElement('li');
    const label = document.createElement('span');
    label.textContent = names[c.name];
    const kbd = document.createElement('kbd');
    kbd.textContent = c.shortcut || 'not set';
    li.append(label, kbd);
    list.append(li);
  }
  const esc = document.createElement('li');
  esc.innerHTML = '<span>Stop (on the page)</span><kbd>Esc</kbd>';
  list.append(esc);
}

// ---------------------------------------------------------------- run control

async function tabMessage(msg) {
  if (!tab) return null;
  try {
    return await chrome.tabs.sendMessage(tab.id, msg);
  } catch (_) {
    return null; // content script not injected in this tab
  }
}

async function pollStatus() {
  clearTimeout(pollT);
  const st = await tabMessage({ type: 'ht:status' });
  const running = st && ['countdown', 'waiting', 'typing', 'paused'].includes(st.state);
  $('#runBar').hidden = !running;
  $('#startBar').hidden = !!running;
  if (running) {
    $('#runMsg').textContent = st.msg || 'Typing…';
    $('#runFill').style.width = Math.round((st.pct || 0) * 100) + '%';
    const resumable = st.state === 'paused' && st.paused && st.paused !== 'focus';
    $('#pauseBtn').textContent = resumable ? 'Resume' : 'Pause';
    $('#pauseBtn').dataset.action = resumable ? 'resume' : 'pause';
    $('#pauseBtn').hidden = !(st.state === 'typing' || st.state === 'paused');
  }
  pollT = setTimeout(pollStatus, 600);
}

async function start() {
  hideError();
  const text = $('#text').value;
  if (!text.trim()) {
    showError('Paste some text to type first.');
    $('#text').focus();
    return;
  }
  if (!tab) return showError('No active tab found.');
  const btn = $('#startBtn');
  btn.disabled = true;
  await save();
  let res;
  try {
    res = await chrome.runtime.sendMessage({ type: 'ht:startTab', tabId: tab.id, text, settings: S });
  } catch (e) {
    res = { error: e.message };
  }
  btn.disabled = false;
  if (res && res.error) return showError(res.error);
  window.close(); // the countdown starts on the page; click into your field
}

function showError(m) {
  const el = $('#error');
  el.textContent = m;
  el.hidden = false;
}
function hideError() {
  $('#error').hidden = true;
}
