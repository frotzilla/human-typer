/* Human Typer: content script.
 * Finds the focused field, runs the keystroke plan with pause/resume/stop, and shows a small overlay. */
(() => {
  if (window.__humanTyper) return;
  window.__humanTyper = true;

  const HT = self.HumanTyper;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let current = null;

  // ---------------------------------------------------------------- focus helpers

  // document.activeElement, followed through shadow roots and same-origin iframes.
  function deepActive() {
    let el = document.activeElement;
    for (;;) {
      if (!el) return null;
      if (el.shadowRoot && el.shadowRoot.activeElement) {
        el = el.shadowRoot.activeElement;
        continue;
      }
      if (el.tagName === 'IFRAME' || el.tagName === 'FRAME') {
        let d = null;
        try {
          d = el.contentDocument;
        } catch (_) {}
        if (d && d.activeElement) {
          el = d.activeElement;
          continue;
        }
      }
      return el;
    }
  }

  const TEXT_INPUT = /^(text|search|url|tel|email|password)$/i;
  const isTextControl = (el) => !!el && (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT');

  function isEditable(el) {
    if (!el) return false;
    if (el.tagName === 'TEXTAREA') return !el.readOnly && !el.disabled;
    if (el.tagName === 'INPUT') return TEXT_INPUT.test(el.type || 'text') && !el.readOnly && !el.disabled;
    if (el.isContentEditable) return true;
    return !!el.ownerDocument && el.ownerDocument.designMode === 'on';
  }

  // ---------------------------------------------------------------- engines

  // Trusted keystrokes: the service worker replays them through chrome.debugger (Input.dispatchKeyEvent).
  function makeCdpEngine(S) {
    return {
      async exec(a) {
        const res = await chrome.runtime.sendMessage({
          type: 'ht:key',
          a: { k: a.k, ch: a.ch, shift: a.k === 'enter' && S.newline === 'shiftEnter' },
        });
        if (res && res.error) throw new Error(res.error);
      },
    };
  }

  function keyMeta(ch) {
    if (/^[a-z]$/i.test(ch)) return { code: 'Key' + ch.toUpperCase(), kc: ch.toUpperCase().charCodeAt(0) };
    if (/^[0-9]$/.test(ch)) return { code: 'Digit' + ch, kc: ch.charCodeAt(0) };
    if (ch === ' ') return { code: 'Space', kc: 32 };
    return { code: '', kc: 0 };
  }

  // Simulated keystrokes: synthetic key events + execCommand, no debugger banner.
  function makeDomEngine(target, S) {
    const doc = target.ownerDocument;
    const fire = (type, key, code, kc, extra) =>
      target.dispatchEvent(
        new KeyboardEvent(type, { key, code, keyCode: kc, which: kc, bubbles: true, cancelable: true, composed: true, ...extra })
      );
    const inputEvent = (inputType, data) =>
      target.dispatchEvent(new InputEvent('input', { bubbles: true, inputType, data: data == null ? null : data }));

    function insert(text) {
      let ok = false;
      try {
        ok = doc.execCommand('insertText', false, text);
      } catch (_) {}
      if (!ok && isTextControl(target)) {
        const s = target.selectionStart ?? target.value.length;
        const e = target.selectionEnd ?? s;
        target.setRangeText(text, s, e, 'end');
        inputEvent('insertText', text);
      }
    }
    function del() {
      let ok = false;
      try {
        ok = doc.execCommand('delete', false);
      } catch (_) {}
      if (!ok && isTextControl(target) && target.selectionStart != null) {
        let s = target.selectionStart;
        const e = target.selectionEnd;
        if (s === e && s > 0) s--;
        target.setRangeText('', s, e, 'end');
        inputEvent('deleteContentBackward');
      }
    }
    function move(dir) {
      if (isTextControl(target) && target.selectionStart != null) {
        const from = dir < 0 ? target.selectionStart : target.selectionEnd;
        const p = Math.max(0, Math.min(target.value.length, from + dir));
        target.setSelectionRange(p, p);
      } else {
        const sel = doc.getSelection();
        if (sel) sel.modify('move', dir < 0 ? 'backward' : 'forward', 'character');
      }
    }
    function newline(shift) {
      if (target.tagName === 'TEXTAREA') return insert('\n');
      if (target.tagName === 'INPUT') return;
      try {
        doc.execCommand(shift ? 'insertLineBreak' : 'insertParagraph', false);
      } catch (_) {}
    }

    return {
      async exec(a) {
        switch (a.k) {
          case 'char': {
            const { code, kc } = keyMeta(a.ch);
            const shiftKey = a.ch !== a.ch.toLowerCase();
            if (fire('keydown', a.ch, code, kc, { shiftKey })) {
              fire('keypress', a.ch, code, a.ch.charCodeAt(0), { shiftKey, charCode: a.ch.charCodeAt(0) });
              insert(a.ch);
            }
            fire('keyup', a.ch, code, kc, { shiftKey });
            break;
          }
          case 'enter': {
            const shiftKey = S.newline === 'shiftEnter';
            if (fire('keydown', 'Enter', 'Enter', 13, { shiftKey })) newline(shiftKey);
            fire('keyup', 'Enter', 'Enter', 13, { shiftKey });
            break;
          }
          case 'back':
            if (fire('keydown', 'Backspace', 'Backspace', 8)) del();
            fire('keyup', 'Backspace', 'Backspace', 8);
            break;
          case 'left':
          case 'right': {
            const key = a.k === 'left' ? 'ArrowLeft' : 'ArrowRight';
            const kc = a.k === 'left' ? 37 : 39;
            if (fire('keydown', key, key, kc)) move(a.k === 'left' ? -1 : 1);
            fire('keyup', key, key, kc);
            break;
          }
        }
      },
    };
  }

  // ---------------------------------------------------------------- overlay

  const HUD = (() => {
    let host = null;
    let el = {};
    let hideT = 0;
    const CSS = `
      :host { all: initial; }
      .hud { --bg:#ffffff; --fg:#151823; --muted:#6b7280; --line:#e6e8ef; --accent:#ff69b4; --on-accent:#2a0a1a; --soft:#ffe6f2; --warn:#d97706;
        font: 500 12.5px/1.35 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; color: var(--fg);
        background: var(--bg); border: 1px solid var(--line); border-radius: 0; padding: 10px 12px 11px;
        width: 260px; box-shadow: 0 10px 30px rgba(15,17,23,.18), 0 2px 6px rgba(15,17,23,.08); }
      @media (prefers-color-scheme: dark) {
        .hud { --bg:#171a23; --fg:#e8eaf2; --muted:#8b92a5; --line:#2a2f3d; --accent:#ff69b4; --on-accent:#2a0a1a; --soft:#3a1c2d; --warn:#f5a524; }
      }
      .top { display:flex; align-items:center; gap:7px; cursor: grab; user-select:none; }
      .top:active { cursor: grabbing; }
      .dot { width:8px; height:8px; border-radius: 0; background: var(--accent); flex:none; }
      .hud[data-state="typing"] .dot { animation: pulse 1s ease-in-out infinite; }
      .hud[data-state="paused"] .dot, .hud[data-state="waiting"] .dot, .hud[data-state="countdown"] .dot { background: var(--warn); }
      .hud[data-state="stopped"] .dot { background: var(--muted); }
      @keyframes pulse { 50% { opacity: .35; } }
      .title { font-weight: 650; }
      .stat { margin-left:auto; color: var(--muted); font-variant-numeric: tabular-nums; font-size: 11.5px; }
      .msg { margin: 6px 0 8px; color: var(--fg); }
      .bar { height: 5px; background: var(--soft); border-radius: 0; overflow: hidden; }
      .bar i { display:block; height:100%; width:0; background: var(--accent); border-radius: 0; transition: width .2s linear; }
      .btns { display:flex; align-items:center; gap:6px; margin-top: 9px; }
      button { font: inherit; font-weight: 600; font-size: 12px; border-radius: 0; padding: 4px 10px; cursor: pointer;
        border: 1px solid var(--line); background: var(--bg); color: var(--fg); }
      button:hover { background: var(--soft); }
      button.pause { background: var(--accent); border-color: var(--accent); color: var(--on-accent); }
      button[hidden] { display:none; }
      .hint { margin-left:auto; color: var(--muted); font-size: 11px; }`;

    function mount() {
      if (host && host.isConnected) return;
      host = document.createElement('div');
      host.style.cssText = 'all:initial;position:fixed;right:16px;bottom:16px;z-index:2147483647;';
      const root = host.attachShadow({ mode: 'closed' });
      root.innerHTML = `<style>${CSS}</style>
        <div class="hud" role="status" aria-live="polite">
          <div class="top"><span class="dot"></span><span class="title">Human Typer</span><span class="stat"></span></div>
          <div class="msg"></div>
          <div class="bar"><i></i></div>
          <div class="btns"><button class="pause" type="button">Pause</button><button class="stop" type="button">Stop</button><span class="hint">Esc to stop</span></div>
        </div>`;
      el = {
        hud: root.querySelector('.hud'),
        top: root.querySelector('.top'),
        stat: root.querySelector('.stat'),
        msg: root.querySelector('.msg'),
        fill: root.querySelector('.bar i'),
        pause: root.querySelector('.pause'),
        stop: root.querySelector('.stop'),
        hint: root.querySelector('.hint'),
      };
      // Never take focus away from the field being typed into.
      for (const b of [el.pause, el.stop]) {
        b.tabIndex = -1;
        b.addEventListener('mousedown', (e) => e.preventDefault());
      }
      el.pause.addEventListener('click', () => current && current.toggle());
      el.stop.addEventListener('click', () => current && current.stop('Stopped'));
      el.top.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        const r = host.getBoundingClientRect();
        const ox = e.clientX - r.left;
        const oy = e.clientY - r.top;
        const move = (ev) => {
          host.style.left = Math.max(0, Math.min(innerWidth - r.width, ev.clientX - ox)) + 'px';
          host.style.top = Math.max(0, Math.min(innerHeight - r.height, ev.clientY - oy)) + 'px';
          host.style.right = host.style.bottom = 'auto';
        };
        const up = () => {
          removeEventListener('pointermove', move, true);
          removeEventListener('pointerup', up, true);
        };
        addEventListener('pointermove', move, true);
        addEventListener('pointerup', up, true);
      });
      document.documentElement.appendChild(host);
    }

    return {
      render(o) {
        clearTimeout(hideT);
        mount();
        el.hud.dataset.state = o.state;
        el.msg.textContent = o.msg || '';
        el.stat.textContent = o.stat || '';
        el.fill.style.width = (Math.max(0, Math.min(1, o.pct || 0)) * 100).toFixed(1) + '%';
        const live = o.state === 'typing' || o.state === 'paused';
        el.pause.hidden = !live;
        el.pause.textContent = o.resumable ? 'Resume' : 'Pause';
        el.stop.hidden = o.state === 'done' || o.state === 'stopped';
        el.hint.hidden = el.stop.hidden;
      },
      hide(delay) {
        clearTimeout(hideT);
        hideT = setTimeout(() => {
          if (host) host.remove();
          host = null;
        }, delay || 0);
      },
    };
  })();

  // ---------------------------------------------------------------- a typing run

  const PAUSE_MSG = {
    user: 'Paused',
    focus: 'Paused. Click back into the field to continue',
    typed: 'Paused because you pressed a key',
  };

  class Run {
    constructor(text, settings, opts) {
      this.raw = text;
      this.S = HT.merge(HT.DEFAULTS, settings || {});
      this.quick = !!(opts && opts.quick);
      this.state = 'countdown';
      this.paused = null; // null | 'user' | 'focus' | 'typed'
      this.stopped = false;
      this.idx = 0;
      this.pct = 0;
      this.pausedMs = 0;
      this.lastRender = 0;
      this.dispatching = false;
      this.lastDispatch = 0;
      this.onKey = this.onKey.bind(this);
    }

    status() {
      return { state: this.state, pct: this.pct, paused: this.paused, msg: this.message() };
    }

    async start() {
      addEventListener('keydown', this.onKey, true);
      try {
        // A simulated-engine run doesn't need the debugger that a previous run may have left attached.
        if (this.S.engine !== 'debugger') chrome.runtime.sendMessage({ type: 'ht:done' }).catch(() => {});

        const secs = this.quick ? 0 : Math.max(0, Math.min(30, Math.round(+this.S.countdown || 0)));
        for (let s = secs; s > 0 && !this.stopped; s--) {
          this.countdown = s;
          this.render(true);
          await sleep(1000);
        }
        if (this.quick) await sleep(250);

        this.state = 'waiting';
        let el = deepActive();
        let waited = false;
        while (!this.stopped && !this.acceptable(el)) {
          waited = true;
          this.render(true);
          await sleep(200);
          el = deepActive();
        }
        if (this.stopped) return;
        if (waited) await sleep(400); // give the click a moment to settle the caret

        this.target = el;
        if (el.ownerDocument !== document) {
          this.tdoc = el.ownerDocument;
          this.tdoc.addEventListener('keydown', this.onKey, true);
        }
        const text = HT.prepareText(this.raw, this.S, { singleLine: el.tagName === 'INPUT' });
        this.plan = HT.buildPlan(text, this.S);
        this.engine = this.S.engine === 'debugger' ? makeCdpEngine(this.S) : makeDomEngine(el, this.S);
        this.state = 'typing';
        this.t0 = performance.now();
        await this.loop();
      } catch (e) {
        this.stopped = true;
        this.stopReason = 'Error: ' + ((e && e.message) || e);
      } finally {
        this.finish();
      }
    }

    acceptable(el) {
      if (isEditable(el)) return true;
      // With trusted keystrokes we can also type into cross-origin frames we can't see into.
      return this.S.engine === 'debugger' && !!el && /^(IFRAME|FRAME|EMBED|OBJECT)$/.test(el.tagName);
    }

    focusOK() {
      return document.hasFocus() && document.visibilityState === 'visible' && deepActive() === this.target;
    }

    async loop() {
      const acts = this.plan.actions;
      const n = acts.length;
      let due = performance.now() + (n ? acts[0].d : 0);
      while (this.idx < n && !this.stopped) {
        if (this.paused) {
          this.state = 'paused';
          this.render(true);
          await this.waitForResume();
          if (this.stopped) break;
          this.state = 'typing';
          this.render(true);
          due = performance.now() + 350;
          continue;
        }
        const wait = due - performance.now();
        if (wait > 0) {
          await sleep(Math.min(wait, 100));
          this.render();
          continue;
        }
        if (this.S.autoPause && !this.focusOK()) {
          this.pause('focus');
          continue;
        }
        const a = acts[this.idx];
        this.dispatching = true;
        try {
          await this.engine.exec(a);
        } finally {
          this.dispatching = false;
          this.lastDispatch = performance.now();
        }
        this.idx++;
        this.pct = this.plan.chars ? Math.max(this.pct, a.p / this.plan.chars) : 1;
        // Stay on schedule, but don't fire a burst of keys to catch up after a slow dispatch.
        if (this.idx < n) due = Math.max(due, performance.now() - 40) + acts[this.idx].d;
        this.render();
      }
    }

    waitForResume() {
      return new Promise((resolve) => {
        const t = performance.now();
        let ok = 0;
        const iv = setInterval(() => {
          if (!this.stopped && this.paused === 'focus') {
            ok = this.focusOK() ? ok + 1 : 0;
            if (ok >= 3) this.paused = null;
          }
          if (this.stopped || !this.paused) {
            clearInterval(iv);
            this.pausedMs += performance.now() - t;
            resolve();
          }
        }, 200);
      });
    }

    pause(reason) {
      if (this.stopped || !(this.state === 'typing' || this.state === 'paused')) return;
      if (this.paused && this.paused !== 'focus' && reason === 'focus') return;
      this.paused = reason;
      this.render(true);
    }

    resume() {
      if (this.paused) this.paused = null;
    }

    toggle() {
      if (this.paused && this.paused !== 'focus') this.resume();
      else this.pause('user');
    }

    stop(reason) {
      if (this.stopped) return;
      this.stopped = true;
      this.stopReason = reason;
    }

    onKey(e) {
      if (!e.isTrusted) return;
      if (e.key === 'Escape') return this.stop('Stopped (Esc)');
      if (this.state !== 'typing' || !this.S.autoPause) return;
      // Our own trusted keystrokes arrive while we're dispatching them.
      if (this.dispatching || performance.now() - this.lastDispatch < 60) return;
      if (['Shift', 'Control', 'Alt', 'Meta', 'CapsLock'].includes(e.key)) return;
      this.pause('typed');
    }

    finish() {
      removeEventListener('keydown', this.onKey, true);
      if (this.tdoc) this.tdoc.removeEventListener('keydown', this.onKey, true);
      if (current !== this) return; // replaced by a newer run, which owns the overlay and debugger now
      current = null;
      if (this.S.engine === 'debugger') chrome.runtime.sendMessage({ type: 'ht:done' }).catch(() => {});
      this.state = this.stopped ? 'stopped' : 'done';
      this.render(true);
      HUD.hide(this.stopped ? 2500 : 4500);
    }

    // ---- display

    wpm() {
      const mins = (performance.now() - this.t0 - this.pausedMs) / 60000;
      return mins > 0.02 ? Math.round((this.pct * this.plan.chars) / 5 / mins) : 0;
    }

    message() {
      switch (this.state) {
        case 'countdown':
          return `Starting in ${this.countdown}… click into the field to type in`;
        case 'waiting':
          return 'Click into a text field to start typing';
        case 'typing':
          return `Typing… ${Math.round(this.pct * 100)}%`;
        case 'paused':
          return PAUSE_MSG[this.paused] || 'Paused';
        case 'done': {
          const secs = (performance.now() - this.t0 - this.pausedMs) / 1000;
          return `Done: ${HT.countWords(this.plan.text)} words in ${HT.formatDuration(secs * 1000)} (${this.wpm()} wpm)`;
        }
        case 'stopped':
          return this.stopReason || 'Stopped';
      }
      return '';
    }

    render(force) {
      if (!this.S.hud) return;
      const now = performance.now();
      if (!force && now - this.lastRender < 200) return;
      this.lastRender = now;
      let stat = '';
      if (this.plan && (this.state === 'typing' || this.state === 'paused')) {
        const doneMs = this.idx ? this.plan.actions[this.idx - 1].at : 0;
        stat = `${this.wpm()} wpm · ${HT.formatDuration(this.plan.totalMs - doneMs)} left`;
      }
      HUD.render({
        state: this.state,
        msg: this.message(),
        stat,
        pct: this.state === 'done' ? 1 : this.pct,
        resumable: !!this.paused && this.paused !== 'focus',
      });
    }
  }

  // ---------------------------------------------------------------- messages

  const status = () => (current ? current.status() : { state: 'idle' });

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    switch (msg && msg.type) {
      case 'ht:start':
        if (current) current.stop('Replaced by a new run');
        current = new Run(msg.text, msg.settings, { quick: msg.quick });
        current.start();
        sendResponse({ ok: true });
        break;
      case 'ht:toggle':
        if (current) current.toggle();
        sendResponse(status());
        break;
      case 'ht:pause':
        if (current) current.pause('user');
        sendResponse(status());
        break;
      case 'ht:resume':
        if (current) current.resume();
        sendResponse(status());
        break;
      case 'ht:stop':
        if (current) current.stop('Stopped');
        sendResponse(status());
        break;
      case 'ht:status':
        sendResponse(status());
        break;
      case 'ht:detached':
        if (current && current.S.engine === 'debugger') current.stop('Stopped because the debugging banner was dismissed');
        break;
    }
  });
})();
