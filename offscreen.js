/* Human Typer: offscreen page used only to read the clipboard for the keyboard shortcut / menu. */
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.type !== 'ht:readClipboard') return;
  const ta = document.getElementById('clip');
  ta.value = '';
  ta.focus();
  document.execCommand('paste');
  sendResponse({ text: ta.value });
});
