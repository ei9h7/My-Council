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

/**
 * A queue of segments ({ voice: 0-2 for the members, 'chair' for announcements and the verdict, text })
 * that keeps growing while a debate runs. play() reads from the start and keeps up with new segments
 * until stop(); onChange(playing) lets the button follow along.
 */
export function createNarrator({ onChange = () => {} } = {}) {
  let segments = [];
  let cursor = 0;
  let playing = false;
  let speaking = false;
  let voices = [];
  let gen = 0; // bumped on play/stop so callbacks from cancelled utterances are ignored

  const loadVoices = () => {
    const lang = (navigator.language || 'en').slice(0, 2);
    const all = speechSynthesis.getVoices();
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

  function next() {
    if (!playing || speaking) return;
    if (cursor >= segments.length) return; // wait for more; push() resumes
    const seg = segments[cursor++];
    const parts = chunks(seg.text);
    const { voice, pitch } = voiceFor(seg.voice);
    speaking = true;
    let left = parts.length;
    const mine = gen;
    const done = () => {
      if (mine !== gen || --left > 0) return;
      speaking = false;
      next();
    };
    if (!left) return done();
    for (const p of parts) {
      const u = new SpeechSynthesisUtterance(p);
      if (voice) u.voice = voice;
      u.lang = voice?.lang || navigator.language || 'en';
      u.pitch = pitch;
      u.onend = done;
      u.onerror = done;
      speechSynthesis.speak(u);
    }
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
    play() {
      if (!canSpeak()) return;
      gen++;
      speechSynthesis.cancel();
      speaking = false;
      cursor = 0;
      playing = true;
      onChange(true);
      next();
    },
    stop() {
      gen++;
      playing = false;
      speaking = false;
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
