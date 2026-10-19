// Read the debate aloud with the browser's built-in speech synthesis: free, no key, nothing leaves
// the device except what the OS voice engine does. It reads the short version: each member's stance
// per round, then the chair's verdict, in the most natural voices the device has.

/** Markdown → something a voice can read: no symbols, links read as their text, code dropped. */
export function speakable(md) {
  return md
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+[.)])\s+/gm, '')
    .replace(/^\s*\|?\s*:?-{3,}.*$/gm, '')
    .replace(/[*_~|#]+/g, ' ')
    .replace(/https?:\/\/\S+/g, 'a link')
    .replace(/\s*[·•]\s*/g, ', ')
    .replace(/\s*\n+\s*/g, '. ')
    .replace(/([.!?:])(\s*\.)+/g, '$1')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/**
 * Some browsers (Chrome especially) silently stop a long utterance after ~15 seconds, so speak in
 * sentence-sized pieces.
 */
export function chunks(text, max = 220) {
  const out = [];
  let cur = '';
  for (const s of text.match(/[^.!?]+[.!?]*\s*/g) ?? []) {
    if (cur && (cur + s).length > max) {
      out.push(cur.trim());
      cur = '';
    }
    if (s.length > max) {
      for (const w of s.split(/\s+/)) {
        if (cur && (cur + ' ' + w).length > max) {
          out.push(cur.trim());
          cur = '';
        }
        cur += (cur ? ' ' : '') + w;
      }
    } else cur += s;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

export const canSpeak = () => typeof speechSynthesis !== 'undefined' && typeof SpeechSynthesisUtterance !== 'undefined';

// iPhone/iPad (iPadOS reports itself as a Mac with touch).
export const isAppleMobile = () =>
  typeof navigator !== 'undefined' &&
  (/iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1));

// macOS/iOS novelty and old-style voices (sound effects, singing, the 1990s robot voices).
const NOVELTY =
  /^(Albert|Bad News|Bahh|Bells|Boing|Bubbles|Cellos|Deranged|Eddy|Flo|Fred|Good News|Grandma|Grandpa|Hysterical|Jester|Junior|Kathy|Organ|Pipe Organ|Ralph|Reed|Rocko|Sandy|Shelley|Superstar|Trinoids|Whisper|Wobble|Zarvox)\b/i;

/** Natural-sounding voices first: the device's chosen voice, then Premium/Enhanced/neural ones. */
export function rankVoices(all, language = 'en-US') {
  const lang = language.toLowerCase();
  const score = (v) =>
    (v.default ? 100 : 0) +
    (/premium/i.test(v.name) ? 60 : 0) +
    (/enhanced|neural|natural|siri/i.test(v.name) ? 50 : 0) +
    (/^(Samantha|Ava|Allison|Susan|Zoe|Nicky|Tom|Evan|Nathan|Daniel|Karen|Moira|Serena|Google)\b/i.test(v.name) ? 30 : 0) +
    (v.lang?.toLowerCase() === lang ? 5 : 0) +
    (v.localService ? 2 : 0);
  const base = lang.slice(0, 2);
  const usable = all.filter((v) => !NOVELTY.test(v.name));
  const mine = usable.filter((v) => v.lang?.toLowerCase().replace('_', '-').startsWith(base));
  return (mine.length ? mine : usable).map((v) => ({ v, s: score(v) })).sort((a, b) => b.s - a.s);
}

/**
 * A queue of segments ({ voice: 0-2 for the members, 'chair' for announcements and the verdict, text })
 * that keeps growing while a debate runs. play() reads from the start and keeps up with new segments
 * until stop(); onChange(playing) lets the button follow along.
 */
export function createNarrator({ onChange = () => {} } = {}) {
  let segments = [];
  let cursor = 0; // next segment
  let queue = []; // chunks of the segment being read
  let playing = false;
  let current = null; // the utterance being spoken; held so it isn't garbage-collected mid-sentence (a WebKit bug that drops onend)
  let timer = 0;
  let voices = [];
  let gen = 0; // bumped on play/stop so callbacks from cancelled utterances are ignored

  const bad = new Set(); // voices that never started speaking (listed but not downloaded)
  const loadVoices = () => {
    voices = rankVoices(speechSynthesis.getVoices(), navigator.language || 'en-US');
  };
  if (canSpeak()) {
    loadVoices();
    speechSynthesis.addEventListener?.('voiceschanged', loadVoices);
  }

  // The chair takes the best voice. Members take the next good ones when the device has them, and
  // otherwise share the best one: a natural voice beats telling speakers apart (each line starts
  // with the speaker's name anyway). Pitch is left alone, since shifting it sounds robotic.
  const voiceFor = (seat) => {
    const ok = voices.filter((x) => !bad.has(x.v));
    if (!ok.length) return null;
    const good = ok.filter((x) => x.s >= 30);
    const i = seat === 'chair' ? 0 : seat + 1;
    return (good.length > i ? good[i] : ok[0]).v;
  };

  // Speaks one chunk at a time. A watchdog moves on if the engine never reports the end (Safari can
  // drop onend, or stay silent on a voice it can't load), so the queue never stalls.
  function next() {
    if (!playing || current) return;
    if (!queue.length) {
      if (cursor >= segments.length) return; // wait for more; push() resumes
      const seg = segments[cursor++];
      queue = chunks(seg.text).map((text) => ({ text, seat: seg.voice }));
      return next();
    }
    const item = queue.shift();
    const { text } = item;
    const voice = voiceFor(item.seat);
    const u = new SpeechSynthesisUtterance(text);
    if (voice) u.voice = voice;
    u.lang = voice?.lang || navigator.language || 'en-US';
    u.rate = 1;
    u.volume = 1;
    const mine = gen;
    let started = false;
    const done = () => {
      if (mine !== gen || current !== u) return;
      clearTimeout(timer);
      current = null;
      next();
    };
    const watch = (ms) => {
      clearTimeout(timer);
      timer = setTimeout(done, ms);
    };
    // A voice that never starts is listed but not installed: drop it and say this chunk again.
    const retry = () => {
      if (mine !== gen || current !== u || started || !voice) return done();
      bad.add(voice);
      queue.unshift(item);
      clearTimeout(timer);
      current = null;
      speechSynthesis.cancel();
      setTimeout(next, 250); // speaking straight after cancel() can be dropped by Safari
    };
    u.onstart = () => {
      started = true;
      watch(4000 + text.length * 120); // ~2.5× a normal speaking pace
    };
    u.onend = done;
    u.onerror = () => (started ? done() : retry());
    current = u;
    clearTimeout(timer);
    timer = setTimeout(retry, 4000); // never started
    speechSynthesis.resume?.(); // Safari can be left paused after the page was backgrounded
    speechSynthesis.speak(u);
  }

  return {
    get playing() {
      return playing;
    },
    get length() {
      return segments.length;
    },
    push(voice, text) {
      const t = speakable(text);
      if (!t) return;
      segments.push({ voice, text: t });
      next();
    },
    /** Call straight from the click: iOS only allows speech that starts inside a user gesture. */
    play() {
      if (!canSpeak()) return;
      gen++;
      clearTimeout(timer);
      // cancel() right before speak() can leave Safari silent, so only cancel when something is queued.
      if (speechSynthesis.speaking || speechSynthesis.pending) speechSynthesis.cancel();
      current = null;
      queue = [];
      cursor = 0;
      playing = true;
      onChange(true);
      next();
    },
    stop() {
      gen++;
      clearTimeout(timer);
      playing = false;
      current = null;
      queue = [];
      if (canSpeak()) speechSynthesis.cancel();
      onChange(false);
    },
    reset() {
      this.stop();
      segments = [];
      cursor = 0;
    },
  };
}
