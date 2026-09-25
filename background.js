/* Human Typer: service worker.
 * Starts runs in tabs, replays trusted keystrokes via chrome.debugger, reads the clipboard,
 * and handles keyboard shortcuts + the right-click menu. */
importScripts('planner.js');
const HT = self.HumanTyper;

const attached = new Set();
const cancelled = new Set(); // tabs where the user dismissed the debugging banner mid-run

// ---------------------------------------------------------------- helpers

async function getSettings() {
  const { settings } = await chrome.storage.local.get('settings');
  return HT.merge(HT.DEFAULTS, settings || {});
}

function friendly(e) {
  const m = (e && e.message) || String(e);
  if (/cannot access|cannot be scripted|chrome:\/\/|chrome-extension:\/\/|extensions gallery|webstore/i.test(m))
    return "Chrome doesn't let extensions type on this page (browser pages and the Web Store are off-limits).";
  if (/another debugger|devtools/i.test(m))
    return 'Could not attach to this tab. Close DevTools for it, or switch the engine to "Simulated" in Advanced.';
  if (/receiving end does not exist|could not establish connection/i.test(m))
    return 'The page is not ready yet. Reload it and try again.';
  return m;
}

async function flashBadge(tabId, text, color) {
  try {
    await chrome.action.setBadgeBackgroundColor({ tabId, color: color || '#e5484d' });
    await chrome.action.setBadgeText({ tabId, text });
    setTimeout(() => chrome.action.setBadgeText({ tabId, text: '' }).catch(() => {}), 4000);
  } catch (_) {}
}

// ---------------------------------------------------------------- starting a run

async function startOnTab(tabId, text, settings, opts = {}) {
  if (!text || !text.trim()) throw new Error('Nothing to type. Paste some text first.');
  settings = HT.merge(HT.DEFAULTS, settings || {});
  await chrome.scripting.executeScript({ target: { tabId }, files: ['planner.js', 'content.js'] });
  cancelled.delete(tabId);
  if (settings.engine === 'debugger') await attach(tabId);
  await chrome.tabs.sendMessage(tabId, { type: 'ht:start', text, settings, quick: !!opts.quick });
}

async function quickStart(tab, getText) {
  try {
    const text = await getText();
    if (!text.trim()) throw new Error('Nothing to type');
    await startOnTab(tab.id, text, await getSettings(), { quick: true });
  } catch (e) {
    console.warn('Human Typer:', friendly(e));
    flashBadge(tab.id, '!');
  }
}

async function savedText() {
  const { text } = await chrome.storage.local.get('text');
  return text || '';
}

// ---------------------------------------------------------------- trusted keystrokes

async function attach(tabId) {
  if (cancelled.has(tabId)) throw new Error('Debugging was cancelled for this tab.');
  if (attached.has(tabId)) return;
  try {
    await chrome.debugger.attach({ tabId }, '1.3');
  } catch (e) {
    // After a service-worker restart we may still be attached from before.
    if (!/already attached/i.test((e && e.message) || '')) throw new Error(friendly(e));
  }
  attached.add(tabId);
}

async function detach(tabId) {
  attached.delete(tabId);
  try {
    await chrome.debugger.detach({ tabId });
  } catch (_) {}
}

chrome.debugger.onDetach.addListener((src, reason) => {
  if (src.tabId == null) return;
  attached.delete(src.tabId);
  if (reason === 'canceled_by_user') cancelled.add(src.tabId);
  chrome.tabs.sendMessage(src.tabId, { type: 'ht:detached', reason }).catch(() => {});
});
chrome.tabs.onRemoved.addListener((tabId) => {
  attached.delete(tabId);
  cancelled.delete(tabId);
});
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status === 'loading' && attached.has(tabId)) detach(tabId); // page navigated away mid-run
});

// US physical key positions for every printable ASCII character.
const US_KEYS = (() => {
  const m = {};
  for (const c of 'abcdefghijklmnopqrstuvwxyz') {
    const up = c.toUpperCase();
    m[c] = { code: 'Key' + up, vk: up.charCodeAt(0), shift: false };
    m[up] = { code: 'Key' + up, vk: up.charCodeAt(0), shift: true };
  }
  const shiftedDigits = ')!@#$%^&*(';
  for (let d = 0; d <= 9; d++) {
    m[String(d)] = { code: 'Digit' + d, vk: 48 + d, shift: false };
    m[shiftedDigits[d]] = { code: 'Digit' + d, vk: 48 + d, shift: true };
  }
  for (const [plain, shifted, code, vk] of [
    ['`', '~', 'Backquote', 192], ['-', '_', 'Minus', 189], ['=', '+', 'Equal', 187],
    ['[', '{', 'BracketLeft', 219], [']', '}', 'BracketRight', 221], ['\\', '|', 'Backslash', 220],
    [';', ':', 'Semicolon', 186], ["'", '"', 'Quote', 222], [',', '<', 'Comma', 188],
    ['.', '>', 'Period', 190], ['/', '?', 'Slash', 191],
  ]) {
    m[plain] = { code, vk, shift: false };
    m[shifted] = { code, vk, shift: true };
  }
  m[' '] = { code: 'Space', vk: 32, shift: false };
  return m;
})();

const SHIFT_KEY = { key: 'Shift', code: 'ShiftLeft', windowsVirtualKeyCode: 16 };
const send = (tabId, method, params) => chrome.debugger.sendCommand({ tabId }, method, params);
const keyEvent = (tabId, params) => send(tabId, 'Input.dispatchKeyEvent', params);

async function press(tabId, def, shift) {
  const modifiers = shift ? 8 : 0;
  if (shift) await keyEvent(tabId, { type: 'rawKeyDown', ...SHIFT_KEY, modifiers: 8 });
  const { text, ...keyDef } = def;
  if (text) await keyEvent(tabId, { type: 'keyDown', ...keyDef, text, unmodifiedText: text, modifiers });
  else await keyEvent(tabId, { type: 'rawKeyDown', ...keyDef, modifiers });
  await keyEvent(tabId, { type: 'keyUp', ...keyDef, modifiers });
  if (shift) await keyEvent(tabId, { type: 'keyUp', ...SHIFT_KEY, modifiers: 0 });
}

async function cdp(tabId, a) {
  await attach(tabId);
  switch (a.k) {
    case 'char': {
      const d = US_KEYS[a.ch];
      if (!d) return send(tabId, 'Input.insertText', { text: a.ch }); // accents, emoji, tabs…
      return press(tabId, { key: a.ch, code: d.code, windowsVirtualKeyCode: d.vk, text: a.ch }, d.shift);
    }
    case 'enter':
      return press(tabId, { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' }, a.shift);
    case 'back':
      return press(tabId, { key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 });
    case 'left':
      return press(tabId, { key: 'ArrowLeft', code: 'ArrowLeft', windowsVirtualKeyCode: 37 });
    case 'right':
      return press(tabId, { key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 });
  }
}

// ---------------------------------------------------------------- clipboard

async function readClipboard() {
  try {
    await chrome.offscreen.createDocument({
      url: 'offscreen.html',
      reasons: ['CLIPBOARD'],
      justification: 'Read clipboard text so it can be typed out',
    });
  } catch (e) {
    if (!/single offscreen|already/i.test((e && e.message) || '')) throw e;
  }
  const res = await chrome.runtime.sendMessage({ type: 'ht:readClipboard' });
  chrome.offscreen.closeDocument().catch(() => {});
  return (res && res.text) || '';
}

// ---------------------------------------------------------------- messages, shortcuts, menus

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const reply = (p) => {
    p.then(
      (r) => sendResponse(r || { ok: true }),
      (e) => sendResponse({ error: friendly(e) })
    );
    return true;
  };
  switch (msg && msg.type) {
    case 'ht:startTab':
      return reply(startOnTab(msg.tabId, msg.text, msg.settings));
    case 'ht:key':
      return sender.tab ? reply(cdp(sender.tab.id, msg.a)) : undefined;
    case 'ht:done':
      if (sender.tab) detach(sender.tab.id);
      return;
  }
});

chrome.commands.onCommand.addListener(async (cmd, tab) => {
  if (!tab) [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;
  if (cmd === 'type-clipboard') return quickStart(tab, readClipboard);
  if (cmd === 'pause-resume') return chrome.tabs.sendMessage(tab.id, { type: 'ht:toggle' }).catch(() => {});
  if (cmd === 'stop') return chrome.tabs.sendMessage(tab.id, { type: 'ht:stop' }).catch(() => {});
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: 'ht-clipboard', title: 'Human-type clipboard here', contexts: ['editable'] });
    chrome.contextMenus.create({ id: 'ht-saved', title: 'Human-type saved text here', contexts: ['editable'] });
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (!tab) return;
  if (info.menuItemId === 'ht-clipboard') quickStart(tab, readClipboard);
  if (info.menuItemId === 'ht-saved') quickStart(tab, savedText);
});
