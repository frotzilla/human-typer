# Human Typer

A Chromium extension that types pasted text into any field the way a person would.

Built and tested in **[Vivaldi](https://vivaldi.com)**, the GOAT browser. It also works in Chrome, Edge, Brave, Arc and any other Chromium browser.

## Install

1. Download `human-typer-x.y.z.zip` from the [latest release](https://github.com/frotzilla/human-typer/releases/latest) and unzip it.
   (Or clone this repo.)
2. Open `vivaldi://extensions` (or `chrome://extensions`, `edge://extensions`, `brave://extensions`).
3. Turn on **Developer mode**.
4. Click **Load unpacked** and pick the unzipped `human-typer` folder.
5. Pin the extension so it's easy to reach.

To update, replace the folder with the new release and click the reload arrow on the extension's card.

## Use

- **Popup:** paste your text, adjust settings, click **Start typing**, then click into the target field during the countdown.
- **Shortcut:** copy text, click into a field, press **Alt+Shift+V**. It types your clipboard right away.
- **Right-click** in any text field and choose **Human-type clipboard here** or **Human-type saved text here**.
- **Controls:** use the on-page overlay, **Alt+Shift+P** to pause or resume, **Alt+Shift+X** or **Esc** to stop.
  Change shortcuts at `vivaldi://extensions/shortcuts` (or `chrome://extensions/shortcuts`).

## Features

| | |
|---|---|
| **Speed** | Set it in WPM or ms per keystroke |
| **Variable latency** | Log-normal jitter on each keystroke, with adjustable strength |
| **Natural rhythm** | Common bigrams (th, er, in…) and hand alternation are faster. Same-finger reaches, capitals, numbers and symbols are slower. Starting a word is slower too. Speed is normalized so the average still matches your WPM |
| **Speed drift / warm-up / fatigue** | Pace wanders slowly, starts a bit slow, and can slow down toward the end |
| **Smart typos** | Neighboring keys for your layout (QWERTY, QWERTZ, AZERTY, Dvorak, Colemak), about 150 real misspellings (*recieve*, *definately*, *teh*), swapped letters, missed letters (especially doubles: *ocurred*), double taps, shift slips (*THe*), space slips (*ofthe*, *oft he*) |
| **Corrections** | **Leave** them in. **Backspace** back to the typo and retype. **Arrow keys**: notice later, press ← to reach the typo, fix it, press → to return. **Mix** combines all three. You also set how many keys go by before a typo is noticed |
| **Pauses** | After punctuation, between paragraphs, before long words, plus random "thinking" pauses |
| **Safety** | Auto-pauses if the field loses focus or you press a key, and auto-resumes when you click back in. Esc always stops |
| **Chat-app mode** | Uses Shift+Enter for new lines so a message isn't sent halfway through |
| **Code-editor mode** | Strips indentation after newlines so auto-indenting editors don't double it |
| **Plain punctuation** | Converts curly quotes, em dashes and ellipses to characters you can type on a keyboard |
| **Presets** | Natural, Fast typist, Casual, Hunt & peck, Careful editor, Sloppy, Robot |

## Engines (Advanced)

- **Trusted keystrokes (default):** real key events sent through `chrome.debugger`. Works in Google Docs, Notion, VS Code web and other rich editors. While it runs, Chrome shows a "started debugging this browser" bar. Dismissing that bar stops the run.
- **Simulated events:** synthetic key events plus `execCommand`. No banner, and it works in normal inputs and most editors. Some apps, such as Google Docs, ignore it.

Chrome blocks every extension on `chrome://` pages and the Web Store, so typing won't work there.

## Files

- `planner.js`: pure planning engine. Turns text and settings into a timed keystroke list.
- `content.js`: runs the plan on the page and draws the overlay.
- `background.js`: service worker. Handles trusted keystrokes, shortcuts, the context menu and clipboard access.
- `popup.*`: the settings UI.
- `offscreen.*`: reads the clipboard for the shortcut and the context menu.

## Releasing

```bash
./package.sh
```

This reads the version from `manifest.json` and builds two zips in `dist/`: `human-typer-<version>.zip` for people to download and load unpacked, and `human-typer-<version>-webstore.zip` for uploading to the Chrome Web Store.

## License

[MIT](LICENSE)
