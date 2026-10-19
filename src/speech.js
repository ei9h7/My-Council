// Read the debate aloud with the browser's built-in speech synthesis: free, no key, nothing leaves
// the device except what the OS voice engine does. Each seat gets its own voice (or, when the
// device has few voices, its own pitch) so you can tell the members apart by ear.

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

// iPhone/iPad (iPadOS reports itself as a Mac with touch). Safari there lists voices that aren't
// downloaded and stay silent, so it sticks to the default voice and varies pitch instead.
export const isAppleMobile = () =>
  typeof navigator !== 'undefined' &&
  (/iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1));

// macOS/iOS novelty voices (sound effects, singing, whispering) that make a debate unlistenable.
const NOVELTY = /^(Albert|Bad News|Bahh|Bells|Boing|Bubbles|Cellos|Deranged|Good News|Hysterical|Jester|Organ|Pipe Organ|Superstar|Trinoids|Whisper|Wobble|Zarvox)\b/i;

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

  const loadVoices = () => {
    if (isAppleMobile()) return void (voices = []);
    const lang = (navigator.language || 'en').slice(0, 2);
    const all = speechSynthesis.getVoices().filter((v) => !NOVELTY.test(v.name));
    const mine = all.filter((v) => v.lang?.toLowerCase().startsWith(lang));
    voices = (mine.length ? mine : all).sort((a, b) => Number(b.localService) - Number(a.localService));
  };
  if (canSpeak()) {
    loadVoices();
    speechSynthesis.addEventListener?.('voiceschanged', loadVoices);
  }

  // Seats 0-2 and the chair (3) take distinct voices when there are enough, otherwise distinct pitches.
  const voiceFor = (v) => {
    const i = v === 'chair' ? 3 : v;
    const pitch = [1, 0.8, 1.25, 1][i];
    if (voices.length >= 4) return { voice: voices[i], pitch: 1 };
    if (voices.length) return { voice: voices[i % voices.length], pitch };
    return { voice: null, pitch };
  };

  // Speaks one chunk at a time. A watchdog moves on if the engine never reports the end (Safari can
  // drop onend, or stay silent on a voice it can't load), so the queue never stalls.
  function next() {
    if (!playing || current) return;
    if (!queue.length) {
      if (cursor >= segments.length) return; // wait for more; push() resumes
      const seg = segments[cursor++];
      queue = chunks(seg.text).map((text) => ({ text, ...voiceFor(seg.voice) }));
      return next();
    }
    const { text, voice, pitch } = queue.shift();
    const u = new SpeechSynthesisUtterance(text);
    if (voice) u.voice = voice;
    u.lang = voice?.lang || navigator.language || 'en-US';
    u.pitch = pitch;
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
    u.onstart = () => {
      started = true;
      watch(4000 + text.length * 120); // ~2.5× a normal speaking pace
    };
    u.onend = done;
    u.onerror = done;
    current = u;
    watch(5000); // never started
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
