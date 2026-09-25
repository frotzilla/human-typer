/* Human Typer: planning engine.
 * Turns text + settings into a timed list of keystrokes (chars, backspaces, arrows).
 * Pure JS with no DOM access: the popup uses it for time estimates, the content script to execute. */
(function (root) {
  'use strict';
  const HT = (root.HumanTyper = root.HumanTyper || {});

  // ---------------------------------------------------------------- settings

  HT.DEFAULTS = {
    preset: 'natural',
    speedMode: 'wpm', // 'wpm' | 'ms'
    wpm: 65,
    msPerChar: 180,
    variance: { on: true, amount: 40 }, // % jitter on every keystroke
    rhythm: true, // key-pair aware timing (hand alternation, common bigrams, shift…)
    drift: true, // speed slowly wanders up and down
    warmup: true, // first few words a bit slower
    fatigue: 0, // % slower by the end of the text
    typos: {
      on: true,
      rate: 4, // % of words that get a typo
      fix: 'backspace', // 'leave' | 'backspace' | 'arrows' | 'mix'
      leavePct: 25, // mix mode: share of typos left in
      noticeMin: 0, // chars typed after a typo before it's noticed
      noticeMax: 5,
      kinds: { adjacent: true, misspell: true, transpose: true, omit: true, double: true, caseSlip: true, space: true },
    },
    pauses: {
      on: true,
      punctuation: true,
      paragraph: true,
      hesitate: true,
      thinking: true,
      thinkingFreq: 3, // % of words preceded by a thinking pause
      thinkingMin: 600,
      thinkingMax: 2000,
      scale: 100, // % multiplier for punctuation / paragraph / hesitation pauses
    },
    layout: 'qwerty',
    engine: 'debugger', // 'debugger' (trusted keystrokes) | 'dom' (simulated events)
    newline: 'enter', // 'enter' | 'shiftEnter'
    countdown: 3,
    normalize: true,
    stripIndent: false,
    autoPause: true,
    hud: true,
  };

  // Keys a preset controls; everything else (engine, layout, newline…) is left alone.
  HT.TIMING_KEYS = ['speedMode', 'wpm', 'msPerChar', 'variance', 'rhythm', 'drift', 'warmup', 'fatigue', 'typos', 'pauses'];

  HT.PRESETS = {
    natural: { label: 'Natural', s: {} },
    pro: {
      label: 'Fast typist',
      s: { wpm: 105, variance: { amount: 25 }, typos: { rate: 2, noticeMax: 2 }, pauses: { thinkingFreq: 1, scale: 60 } },
    },
    casual: {
      label: 'Casual',
      s: { wpm: 45, variance: { amount: 45 }, typos: { rate: 5, fix: 'mix', leavePct: 10, noticeMin: 1, noticeMax: 8 }, pauses: { thinkingFreq: 5, scale: 120 } },
    },
    hunt: {
      label: 'Hunt & peck',
      s: { wpm: 22, variance: { amount: 70 }, typos: { rate: 8, noticeMax: 1 }, pauses: { thinkingFreq: 8, scale: 150 } },
    },
    editor: {
      label: 'Careful editor',
      s: { wpm: 55, typos: { rate: 5, fix: 'arrows', noticeMin: 3, noticeMax: 12 }, pauses: { thinkingFreq: 6, scale: 130 } },
    },
    sloppy: {
      label: 'Sloppy',
      s: { wpm: 80, variance: { amount: 50 }, typos: { rate: 10, fix: 'mix', leavePct: 45, noticeMax: 10 }, pauses: { thinkingFreq: 2, scale: 80 } },
    },
    robot: {
      label: 'Robot (steady)',
      s: { speedMode: 'ms', msPerChar: 40, variance: { on: false }, rhythm: false, drift: false, warmup: false, typos: { on: false }, pauses: { on: false } },
    },
  };

  HT.clone = (o) => JSON.parse(JSON.stringify(o));

  HT.merge = function merge(base, over) {
    const out = { ...base };
    if (!over || typeof over !== 'object') return out;
    for (const k of Object.keys(over)) {
      const v = over[k];
      const b = base ? base[k] : undefined;
      out[k] = v && typeof v === 'object' && !Array.isArray(v) && b && typeof b === 'object' ? merge(b, v) : v;
    }
    return out;
  };

  HT.applyPreset = function (S, name) {
    const p = HT.PRESETS[name];
    if (!p) return S;
    const reset = {};
    for (const k of HT.TIMING_KEYS) reset[k] = HT.clone(HT.DEFAULTS[k]);
    return HT.merge(HT.merge(S, reset), { ...HT.clone(p.s), preset: name });
  };

  // ---------------------------------------------------------------- text prep

  HT.prepareText = function (raw, S, opts) {
    let t = String(raw == null ? '' : raw).replace(/\r\n?/g, '\n');
    if (S.normalize) {
      t = t
        .replace(/[‘’‚′]/g, "'")
        .replace(/[“”„″]/g, '"')
        .replace(/\u2014/g, '--')
        .replace(/[\u2013\u2212]/g, '-')
        .replace(/…/g, '...')
        .replace(/•/g, '-')
        .replace(/[   ]/g, ' ')
        .replace(/[​-‍⁠﻿]/g, '');
    }
    if (S.stripIndent) t = t.replace(/\n[ \t]+/g, '\n');
    if (opts && opts.singleLine) t = t.replace(/[ \t]*\n+[ \t]*/g, ' ');
    return t;
  };

  HT.countWords = (t) => (String(t).match(/\S+/g) || []).length;

  HT.formatDuration = function (ms) {
    const s = Math.max(0, Math.round(ms / 1000));
    if (s < 60) return s + 's';
    const m = Math.floor(s / 60);
    if (m < 60) return m + 'm ' + String(s % 60).padStart(2, '0') + 's';
    return Math.floor(m / 60) + 'h ' + String(m % 60).padStart(2, '0') + 'm';
  };

  // ---------------------------------------------------------------- randomness

  function rng(seed) {
    let a = seed >>> 0 || 0x9e3779b9;
    const next = () => {
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    return {
      next,
      range: (lo, hi) => lo + (hi - lo) * next(),
      int: (lo, hi) => Math.floor(lo + (hi - lo + 1) * next()),
      chance: (p) => next() < p,
      pick: (arr) => arr[Math.floor(next() * arr.length)],
      normal: () => {
        let u = 0;
        while (u === 0) u = next();
        return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * next());
      },
      weighted: (items) => {
        let total = 0;
        for (const it of items) total += it[0];
        let r = next() * total;
        for (const it of items) if ((r -= it[0]) < 0) return it[1];
        return items[items.length - 1][1];
      },
    };
  }

  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const LETTER = /\p{L}/u;
  const isLetter = (c) => !!c && LETTER.test(c);

  // ---------------------------------------------------------------- keyboards

  HT.LAYOUTS = {
    qwerty: { label: 'QWERTY', rows: ['`1234567890-=', 'qwertyuiop[]\\', "asdfghjkl;'", 'zxcvbnm,./'] },
    qwertz: { label: 'QWERTZ', rows: ['^1234567890ß´', 'qwertzuiopü+', 'asdfghjklöä#', 'yxcvbnm,.-'] },
    azerty: { label: 'AZERTY', rows: ['²&é"\'(-è_çà)=', 'azertyuiop^$', 'qsdfghjklmù*', 'wxcvbn,;:!'] },
    dvorak: { label: 'Dvorak', rows: ['`1234567890[]', "',.pyfgcrl/=\\", 'aoeuidhtns-', ';qjkxbmwvz'] },
    colemak: { label: 'Colemak', rows: ['`1234567890-=', 'qwfpgjluy;[]\\', "arstdhneio'", 'zxcvbkm,./'] },
  };
  const ROW_OFFSET = [0, 1.5, 1.75, 2.25]; // physical stagger of each row, in key widths
  const kbCache = {};

  function keyboard(name) {
    if (kbCache[name]) return kbCache[name];
    const rows = (HT.LAYOUTS[name] || HT.LAYOUTS.qwerty).rows;
    const map = {};
    const keys = [];
    rows.forEach((row, r) =>
      [...row].forEach((ch, col) => {
        const f = r === 0 ? col - 1 : col; // column relative to the home-row fingers
        const finger = f <= 0 ? 0 : f === 1 ? 1 : f === 2 ? 2 : f <= 4 ? 3 : f <= 6 ? 6 : f === 7 ? 7 : f === 8 ? 8 : 9;
        const k = { ch, r, x: ROW_OFFSET[r] + col, finger, hand: finger <= 3 ? 'L' : 'R', near: [] };
        map[ch] = k;
        keys.push(k);
      })
    );
    for (const k of keys) {
      for (const o of keys) {
        if (o === k || !isLetter(o.ch)) continue;
        const dr = Math.abs(o.r - k.r);
        const dx = Math.abs(o.x - k.x);
        if (dr === 0 && dx <= 1.01) k.near.push(o.ch, o.ch); // same-row slips are twice as likely
        else if (dr === 1 && dx <= 0.8) k.near.push(o.ch);
      }
    }
    return (kbCache[name] = { map });
  }

  function neighbor(c, R, K) {
    const k = K.map[c.toLowerCase()];
    if (!k || !k.near.length) return null;
    const n = R.pick(k.near);
    return c === c.toLowerCase() ? n : n.toUpperCase();
  }

  // ---------------------------------------------------------------- timing

  const BIGRAMS = new Set(
    'th he in er an re on at en nd ti es or te of ed is it al ar st to nt ng se ha as ou io le ve co me de hi ri ro ic ne ea ra ce li ch ll be ma si om ur'.split(' ')
  );
  const SHIFTED = '~!@#$%^&*()_+{}|:"<>?';

  // Relative cost of typing `c` right after `prev` (1 = average keystroke).
  function rhythm(prev, c, K) {
    let m = 1;
    const lc = c.toLowerCase();
    const lp = prev.toLowerCase();
    if (c === ' ') m *= 0.85;
    else if (c === '\n') m *= 1.4;
    else if (!prev || prev === ' ' || prev === '\n') m *= 1.15; // starting a word
    const kc = K.map[lc];
    const kp = K.map[lp];
    if (kc && kp && isLetter(lc) && isLetter(lp)) {
      if (lc === lp) m *= 0.88; // double letter
      else if (kc.hand !== kp.hand) m *= 0.86; // hand alternation is fast
      else {
        m *= 1.07;
        if (kc.finger === kp.finger) m *= 1.15; // same finger, different key is slow
      }
      if (BIGRAMS.has(lp + lc)) m *= 0.8;
    }
    if (c !== lc || SHIFTED.includes(c)) m *= 1.3;
    if (c >= '0' && c <= '9') m *= 1.25;
    else if (!isLetter(lc) && c !== ' ' && c !== '\n') m *= 1.3;
    if ('qzxj'.includes(lc)) m *= 1.12;
    return m;
  }

  function wordLenAt(text, i) {
    let j = i;
    while (j < text.length && isLetter(text[j])) j++;
    return j - i;
  }

  // Extra delay before typing text[i] (only at the start of a word).
  function pauseBefore(text, i, P, R) {
    if (i === 0 || /\s/.test(text[i]) || !/\s/.test(text[i - 1])) return 0;
    const sc = clamp(+P.scale || 0, 0, 1000) / 100;
    let j = i - 1;
    let nl = 0;
    while (j >= 0 && /\s/.test(text[j])) {
      if (text[j] === '\n') nl++;
      j--;
    }
    const before = j >= 0 ? text[j] : '';
    let d = 0;
    if (P.paragraph && nl >= 2) d += R.range(900, 2600) * sc;
    else if (P.paragraph && nl === 1) d += R.range(350, 1000) * sc;
    else if (P.punctuation && /[.!?]/.test(before)) d += R.range(350, 1100) * sc;
    else if (P.punctuation && /[,;:)]/.test(before)) d += R.range(120, 420) * sc;
    if (P.hesitate && wordLenAt(text, i) >= 9 && R.chance(0.45)) d += R.range(150, 500) * sc;
    if (P.thinking && R.chance(clamp(+P.thinkingFreq || 0, 0, 100) / 100)) {
      const lo = Math.max(0, +P.thinkingMin || 0);
      d += R.range(lo, Math.max(lo, +P.thinkingMax || 0));
    }
    return d;
  }

  // ---------------------------------------------------------------- typos

  const MISSPELL = {
    the: ['teh', 'hte'], and: ['adn', 'nad'], that: ['taht', 'thta'], with: ['wiht', 'wtih'],
    have: ['ahve', 'hvae'], this: ['tihs', 'thsi'], from: ['form', 'fomr'], they: ['tehy', 'thye'],
    what: ['waht', 'whta'], your: ['yuor', 'yoru'], you: ['yuo', 'oyu'], just: ['jsut', 'juts'],
    about: ['abotu', 'aobut'], because: ['becuase', 'becasue', 'beacuse'], which: ['whcih', 'wich'],
    their: ['thier', 'theri'], there: ['tehre', 'theer'], would: ['woudl', 'wuold'], could: ['coudl', 'cuold'],
    should: ['shoudl', 'sholud'], know: ['konw', 'knwo'], think: ['thikn', 'tihnk'], people: ['poeple', 'peopel'],
    really: ['realy', 'relaly'], also: ['aslo'], some: ['soem'], time: ['tiem'], like: ['liek'], make: ['amke'],
    more: ['mroe'], other: ['ohter'], into: ['itno'], only: ['olny'], over: ['voer'], very: ['vrey'],
    after: ['afetr'], before: ['befroe'], first: ['frist'], little: ['littel'], world: ['wrold'], still: ['stil'],
    something: ['somethign'], going: ['goign'], thing: ['thign'], things: ['thigns'], thanks: ['thansk'],
    please: ['plese'], again: ['agian'], against: ['agaisnt'], around: ['aroudn'], between: ['bewteen'],
    important: ['improtant', 'importnat'], problem: ['porblem'], system: ['sytem'], information: ['infromation'],
    actually: ['acutally'], when: ['wehn'], where: ['wehre'], while: ['whiel'], thought: ['thougth'], though: ['thouhg'],
    receive: ['recieve'], believe: ['beleive'], achieve: ['acheive'], definitely: ['definately', 'definatly'],
    separate: ['seperate'], occurred: ['occured'], occurrence: ['occurence'], necessary: ['neccessary', 'necesary'],
    accommodate: ['accomodate'], embarrass: ['embarass'], until: ['untill'], tomorrow: ['tommorow', 'tomorow'],
    beginning: ['begining'], government: ['goverment'], environment: ['enviroment'], restaurant: ['restaraunt'],
    calendar: ['calender'], conscious: ['concious'], existence: ['existance'], experience: ['experiance'],
    independent: ['independant'], maintenance: ['maintainance'], noticeable: ['noticable'], occasion: ['ocassion', 'occassion'],
    recommend: ['reccomend', 'recomend'], referred: ['refered'], relevant: ['relevent'], rhythm: ['rythm'],
    schedule: ['schedual'], successful: ['succesful', 'successfull'], surprise: ['suprise'], truly: ['truely'],
    weird: ['wierd'], friend: ['freind'], friends: ['freinds'], piece: ['peice'], foreign: ['foriegn'], address: ['adress'],
    argument: ['arguement'], basically: ['basicly'], business: ['buisness', 'busines'], committee: ['commitee'],
    completely: ['completly'], different: ['diffrent', 'differnt'], disappear: ['dissapear'], disappoint: ['dissapoint'],
    especially: ['especialy'], finally: ['finaly'], forward: ['foward'], further: ['futher'], grammar: ['grammer'],
    guarantee: ['garantee'], happened: ['happend'], immediately: ['immediatly'], interesting: ['intresting'],
    knowledge: ['knowlege'], library: ['libary'], official: ['offical'], opportunity: ['oppurtunity'],
    probably: ['probaly', 'propably'], question: ['questoin'], remember: ['remeber', 'rember'], sentence: ['sentance'],
    similar: ['similiar'], strength: ['strenght'], through: ['throught', 'thru'], together: ['togehter'],
    tongue: ['tounge'], unfortunately: ['unfortunatly'], usually: ['usualy'], writing: ['writting'], written: ['writen'],
    "don't": ['dont'], "doesn't": ['doesnt'], "can't": ['cant'], "won't": ['wont'], "it's": ['its'], "i'm": ['im'],
    "you're": ['youre'], "they're": ['theyre'], "wasn't": ['wasnt'], "didn't": ['didnt'], "isn't": ['isnt'],
    "that's": ['thats'], "i've": ['ive'], "let's": ['lets'],
  };

  function matchCase(orig, v) {
    if (orig.length > 1 && orig === orig.toUpperCase()) return v.toUpperCase();
    if (orig[0] !== orig[0].toLowerCase()) return v[0].toUpperCase() + v.slice(1);
    return v;
  }

  // One typo = "type `w` instead of text[a..b)".
  function makeTypo(text, a, w, kinds, R, K) {
    const opts = [];
    const lower = w.toLowerCase().replace(/’/g, "'");
    const lo = w.length > 3 ? 1 : 0; // mid-word slips are more common than first-letter ones
    const pos = () => R.int(lo, w.length - 1);

    if (kinds.misspell && MISSPELL[lower]) {
      opts.push([6, () => ({ a, b: a + w.length, w: matchCase(w, R.pick(MISSPELL[lower])) })]);
    }
    if (kinds.adjacent) {
      opts.push([4, () => {
        const j = pos();
        const c = w[j];
        const n = neighbor(c, R, K);
        if (!n) return null;
        if (R.chance(0.7)) return { a: a + j, b: a + j + 1, w: n }; // hit the wrong key
        return { a: a + j, b: a + j + 1, w: R.chance(0.5) ? c + n : n + c }; // fat finger: hit two keys
      }]);
    }
    if (kinds.transpose && w.length >= 3) {
      opts.push([2.5, () => {
        const j = R.int(0, w.length - 2);
        if (w[j].toLowerCase() === w[j + 1].toLowerCase()) return null;
        return { a: a + j, b: a + j + 2, w: w[j + 1] + w[j] };
      }]);
    }
    if (kinds.omit && w.length >= 4) {
      opts.push([2, () => {
        const dbl = [];
        for (let j = 1; j < w.length; j++) if (w[j].toLowerCase() === w[j - 1].toLowerCase()) dbl.push(j);
        const j = dbl.length && R.chance(0.7) ? R.pick(dbl) : pos(); // "occurred" -> "ocurred"
        return { a: a + j, b: a + j + 1, w: '' };
      }]);
    }
    if (kinds.double) {
      opts.push([1.5, () => {
        const j = pos();
        return { a: a + j, b: a + j + 1, w: w[j] + w[j] };
      }]);
    }
    if (kinds.caseSlip && /^\p{Lu}\p{Ll}/u.test(w)) {
      opts.push([1.5, () =>
        R.chance(0.6)
          ? { a: a + 1, b: a + 2, w: w[1].toUpperCase() } // held shift too long: "THe"
          : { a, b: a + 1, w: w[0].toLowerCase() }, // missed shift: "the"
      ]);
    }
    const e = a + w.length;
    if (kinds.space && text[e] === ' ' && isLetter(text[e + 1])) {
      opts.push([1.5, () => {
        const r = R.next();
        if (r < 0.5) return { a: e, b: e + 1, w: '' }; // "ofthe"
        if (r < 0.75 && w.length >= 3) return { a: e - 1, b: e + 1, w: ' ' + w[w.length - 1] }; // "o fthe"
        return { a: e, b: e + 2, w: text[e + 1] + ' ' }; // "oft he"
      }]);
    }
    for (let tries = 0; tries < 4 && opts.length; tries++) {
      const ty = R.weighted(opts)();
      if (ty && ty.w !== text.slice(ty.a, ty.b)) return ty;
    }
    return null;
  }

  function genTypos(text, TY, R, K) {
    const map = new Map();
    const p = clamp(+TY.rate || 0, 0, 100) / 100;
    const kinds = TY.kinds || {};
    let blocked = 0;
    for (const m of text.matchAll(/\p{L}+(?:['’]\p{L}+)*/gu)) {
      const w = m[0];
      if (m.index < blocked || w.length < 2 || /[\uD800-\uDFFF]/.test(w)) continue;
      if (!R.chance(p)) continue;
      const ty = makeTypo(text, m.index, w, kinds, R, K);
      if (ty) {
        map.set(ty.a, ty);
        blocked = ty.b;
      }
    }
    return map;
  }

  function pickFix(TY, R) {
    if (TY.fix !== 'mix') return TY.fix;
    if (R.chance(clamp(+TY.leavePct || 0, 0, 100) / 100)) return 'leave';
    return R.chance(0.5) ? 'backspace' : 'arrows';
  }

  // ---------------------------------------------------------------- planner

  /**
   * @returns {{actions: {k:'char'|'enter'|'back'|'left'|'right', ch?:string, d:number, p:number, at:number}[],
   *            totalMs:number, chars:number, final:string, stats:object}}
   *   d  = delay in ms before the keystroke, p = chars of the source text done, at = cumulative ms.
   */
  HT.buildPlan = function (text, settings, seed) {
    const S = HT.merge(HT.DEFAULTS, settings || {});
    const R = rng(seed == null ? (Math.random() * 4294967296) >>> 0 : seed);
    const K = keyboard(S.layout);
    const n = text.length;
    const base = S.speedMode === 'ms' ? clamp(+S.msPerChar || 150, 1, 60000) : 12000 / clamp(+S.wpm || 60, 1, 2000);
    const sigma = S.variance.on ? (clamp(+S.variance.amount || 0, 0, 200) / 100) * 0.6 : 0;
    const TY = S.typos;
    const typos = TY.on && TY.rate > 0 ? genTypos(text, TY, R, K) : new Map();
    let nMin = Math.max(0, TY.noticeMin | 0);
    let nMax = Math.max(0, TY.noticeMax | 0);
    if (nMin > nMax) [nMin, nMax] = [nMax, nMin];

    // Normalise rhythm so the average keystroke still matches the requested speed.
    let meanR = 1;
    if (S.rhythm && n) {
      let sum = 0;
      for (let i = 0; i < n; i++) sum += rhythm(text[i - 1] || '', text[i], K);
      meanR = sum / n;
    }

    const actions = [];
    const stats = { typos: 0, fixes: 0, left: 0 };
    let total = 0;
    let extra = 0; // pending pause, folded into the next keystroke's delay
    let drift = 0;
    let typed = 0;
    let prev = '';
    const T = []; // what is actually in the field (relative to where we started)
    const A = []; // what should be in the field (source text + typos we chose to leave)
    let pending = null; // an unnoticed typo: { start, mode, at }

    const emit = (k, ch, d, p) => {
      d = Math.max(0, Math.round(d + extra));
      extra = 0;
      total += d;
      actions.push({ k, ch, d, p, at: total });
    };
    const keyDelay = (c, i) => {
      let m = S.rhythm ? rhythm(prev, c, K) / meanR : 1;
      if (S.drift) {
        drift = clamp(drift * 0.985 + R.normal() * 0.018, -0.3, 0.3);
        m *= 1 + drift;
      }
      if (S.warmup && typed < 30) m *= 1 + 0.5 * (1 - typed / 30);
      if (S.fatigue) m *= 1 + (clamp(+S.fatigue, 0, 500) / 100) * (i / Math.max(1, n));
      if (sigma) m *= Math.exp(R.normal() * sigma - (sigma * sigma) / 2);
      return Math.max(6, base * m);
    };
    const key = (c, p) => {
      emit(c === '\n' ? 'enter' : 'char', c, keyDelay(c, p), p);
      prev = c;
    };
    const type = (c, p) => {
      key(c, p);
      T.push(c);
      typed++;
    };

    // Bring T back in line with A, the way a person would.
    const correct = (p) => {
      const { start, mode } = pending;
      pending = null;
      let pre = start;
      while (pre < T.length && pre < A.length && T[pre] === A[pre]) pre++;
      if (pre === T.length && pre === A.length) return;
      let suf = 0;
      if (mode === 'arrows') {
        const max = Math.min(T.length, A.length) - pre;
        while (suf < max && T[T.length - 1 - suf] === A[A.length - 1 - suf]) suf++;
      }
      stats.fixes++;
      extra += R.range(220, 650); // "wait, that's wrong"
      for (let s = 0; s < suf; s++) emit('left', null, R.range(70, 140), p);
      const del = T.length - suf - pre;
      for (let d = 0; d < del; d++) emit('back', null, d < 3 ? R.range(80, 150) : R.range(45, 95), p);
      if (del) extra += R.range(60, 160);
      const ins = A.slice(pre, A.length - suf);
      prev = A[pre - 1] || '';
      for (const c of ins) key(c, p);
      if (suf) extra += R.range(80, 200);
      for (let s = 0; s < suf; s++) emit('right', null, R.range(60, 120), p);
      T.splice(pre, T.length - suf - pre, ...ins);
      prev = A[A.length - 1] || '';
      extra += R.range(120, 350);
    };

    let i = 0;
    while (i < n) {
      if (S.pauses.on) extra += pauseBefore(text, i, S.pauses, R);
      if (text[i] === '\n' && pending) correct(i); // never carry a fix across a line break
      const ty = typos.get(i);
      if (ty) {
        stats.typos++;
        const mode = pickFix(TY, R);
        const start = T.length;
        for (let j = 0; j < ty.w.length; j++) type(ty.w[j], i);
        const right = mode === 'leave' ? ty.w : text.slice(ty.a, ty.b);
        for (let j = 0; j < right.length; j++) A.push(right[j]);
        if (mode === 'leave') stats.left++;
        else if (!pending) pending = { start, mode, at: typed + R.int(nMin, nMax) };
        i = ty.b;
      } else {
        // keep surrogate pairs (emoji etc.) together as one keystroke
        const cp = text.codePointAt(i);
        const c = cp > 0xffff ? text.slice(i, i + 2) : text[i];
        type(c, i + c.length);
        A.push(c);
        i += c.length;
      }
      if (pending && typed >= pending.at) correct(i);
    }
    if (pending) correct(n);

    return { text, actions, totalMs: total, chars: n, final: A.join(''), stats };
  };
})(typeof self !== 'undefined' ? self : globalThis);
