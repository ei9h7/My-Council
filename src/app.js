import { PERSONAS, runCouncil, transcriptMarkdown, sessionSummary } from './council.js';
import { canSpeak, createNarrator, isAppleMobile } from './speech.js';
import { listModels, makeComplete, checkKey, needsCacheOptIn } from './openrouter.js';
import { renderMarkdown } from './markdown.js';
import { ACCEPT, readAttachment } from './attachments.js';
import {
  BRANDS, CATALOG, CHAIRS, DEFAULT_CHAIR, DEFAULT_MODELS, DEFAULT_PERSONAS, DEFAULT_FIGURES, MODES, brandOf, displayModel,
} from './catalog.js';

const $ = (id) => document.getElementById(id);
const STORE = 'my-council:v2';
const OTHER = '__other';

let models = []; // OpenRouter's live list (prices, vision, caching)
let controller = null;
let running = false;
let sessions = []; // finished sessions in the current chain: [{title, userQuestion, attachments, transcript, verdict, clarifications, summary}]
let earlierEvidence = []; // ready evidence entries used anywhere in this chain, for "re-attach"

// The hosted build (see the hosted branch) points this at its proxy and signs requests with a login token.
export const backend = { hosted: false, endpoint: undefined, getToken: undefined };

// ---------- settings ----------

const DEFAULTS = {
  apiKey: '',
  rounds: 3,
  earlyStop: true,
  clarify: true,
  mergeQuestions: true,
  chair: DEFAULT_CHAIR,
  effort: '',
  anyModel: false,
  cachingOnly: true,
  theme: 'system',
  council: {
    mode: 'ais',
    models: [...DEFAULT_MODELS],
    shared: DEFAULT_MODELS[0],
    personas: [...DEFAULT_PERSONAS],
    figures: [...DEFAULT_FIGURES],
    custom: ['', '', ''],
  },
};

function load() {
  let s = {};
  try {
    s = JSON.parse(localStorage.getItem(STORE)) ?? {};
    if (!localStorage.getItem(STORE)) {
      // Carry over the key and debate settings from the first version.
      const v1 = JSON.parse(localStorage.getItem('my-council:v1')) ?? {};
      s = { apiKey: v1.apiKey, rounds: v1.rounds, earlyStop: v1.earlyStop, clarify: v1.clarify };
    }
  } catch {}
  const out = { ...DEFAULTS, ...Object.fromEntries(Object.entries(s).filter(([, v]) => v != null)) };
  out.council = { ...DEFAULTS.council, ...(s.council ?? {}) };
  if (!(out.council.mode in MODES)) out.council.mode = 'ais'; // "Both" was retired
  out.rounds = Math.min(5, Math.max(0, Number(out.rounds) || 0));
  if (!CHAIRS.some((c) => c.id === out.chair)) out.chair = DEFAULT_CHAIR;
  return out;
}

const settings = load();

function save() {
  try {
    localStorage.setItem(STORE, JSON.stringify(settings));
  } catch {}
}

// ---------- theme ----------

function applyTheme() {
  const t = settings.theme;
  if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t;
  else delete document.documentElement.dataset.theme;
  renderSegmented($('themes'), { system: 'System', light: 'Light', dark: 'Dark' }, t, (v) => {
    settings.theme = v;
    save();
    applyTheme();
  });
}

function isDark() {
  const t = settings.theme;
  return t === 'dark' || (t === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
}

// ---------- shared widgets ----------

function renderSegmented(el, options, value, onPick) {
  el.innerHTML = '';
  for (const [key, label] of Object.entries(options)) {
    const b = document.createElement('button');
    b.type = 'button';
    b.setAttribute('role', 'radio');
    b.setAttribute('aria-checked', String(key === value));
    b.textContent = label;
    b.addEventListener('click', () => onPick(key));
    el.append(b);
  }
}

const price = (id) => models.find((m) => m.id === id);

/** $–$$$$ from a blended price per million tokens (answers are output-heavy). */
function costTier(id) {
  const p = price(id);
  if (!p) return '';
  const blended = p.prompt * 0.3 + p.completion * 0.7;
  return blended < 1.5 ? '$' : blended < 10 ? '$$' : blended < 25 ? '$$$' : '$$$$';
}

function fillModelSelect(select, value) {
  select.innerHTML = '';
  for (const [key, brand] of Object.entries(BRANDS)) {
    const group = document.createElement('optgroup');
    group.label = brand.name;
    for (const m of CATALOG.filter((c) => c.brand === key)) {
      const bits = [m.label, costTier(m.id), m.tag !== 'Recommended' && m.tag].filter(Boolean);
      group.append(new Option(bits.join('  ·  '), m.id));
    }
    select.append(group);
  }
  if (settings.anyModel) select.append(new Option('Other OpenRouter model…', OTHER));
  const known = CATALOG.some((c) => c.id === value);
  select.value = known ? value : settings.anyModel ? OTHER : '';
  return known;
}

function fillDatalist() {
  const dl = $('modelList');
  dl.innerHTML = '';
  for (const m of models) {
    if (settings.cachingOnly && !m.caching) continue;
    const cost = m.prompt || m.completion ? ` — $${m.prompt.toFixed(2)}/$${m.completion.toFixed(2)} per M` : '';
    dl.append(new Option(`${m.name}${cost}${m.caching ? ' · caching' : ''}`, m.id));
  }
}

// ---------- council (seats) ----------

const seatEls = [];

function buildSeats() {
  const tpl = $('seatTpl');
  for (let i = 0; i < 3; i++) {
    const seat = tpl.content.firstElementChild.cloneNode(true);
    const persona = seat.querySelector('.persona');
    const model = seat.querySelector('.model');
    const other = seat.querySelector('.other-model');
    const custom = seat.querySelector('.customPersona');

    model.addEventListener('change', () => {
      if (model.value === OTHER) {
        other.hidden = false;
        other.focus();
        settings.council.models[i] = other.value.trim();
      } else {
        settings.council.models[i] = model.value;
      }
      councilChanged();
    });
    other.addEventListener('change', () => {
      settings.council.models[i] = other.value.trim();
      councilChanged();
    });
    persona.addEventListener('change', () => {
      seatPersonas()[i] = persona.value;
      councilChanged();
    });
    custom.addEventListener('change', () => {
      settings.council.custom[i] = custom.value;
      save();
    });
    seatEls.push(seat);
    $('seats').append(seat);
  }
  $('sharedModel').addEventListener('change', () => {
    const sel = $('sharedModel');
    if (sel.value === OTHER) {
      $('sharedOther').hidden = false;
      $('sharedOther').focus();
      settings.council.shared = $('sharedOther').value.trim();
    } else settings.council.shared = sel.value;
    councilChanged();
  });
  $('sharedOther').addEventListener('change', () => {
    settings.council.shared = $('sharedOther').value.trim();
    councilChanged();
  });
}

function councilChanged() {
  save();
  renderCouncil();
  refreshEstimates();
}

/** The per-seat persona list for the current style: famous figures, or priorities. */
function seatPersonas() {
  const c = settings.council;
  return c.mode === 'personalities' ? c.figures : c.personas;
}

function renderCouncil() {
  const c = settings.council;
  renderSegmented($('modes'), Object.fromEntries(Object.entries(MODES).map(([k, v]) => [k, v.label])), c.mode, (mode) => {
    c.mode = mode;
    councilChanged();
  });
  for (const b of $('modes').children) b.disabled = running;
  $('modeHint').textContent = MODES[c.mode].hint;

  const shared = c.mode !== 'ais';
  const group = MODES[c.mode].group;
  const picks = seatPersonas();
  $('sharedRow').hidden = !shared;
  if (shared) {
    const known = fillModelSelect($('sharedModel'), c.shared);
    $('sharedOther').hidden = known || !settings.anyModel;
    $('sharedOther').value = known ? '' : c.shared;
    if (!known && !settings.anyModel) c.shared = DEFAULT_MODELS[0];
  }

  const members = readSeats();
  seatEls.forEach((seat, i) => {
    const m = members[i];
    const modelSel = seat.querySelector('.model');
    const other = seat.querySelector('.other-model');
    seat.querySelector('.model-field').hidden = shared;
    if (!shared) {
      const known = fillModelSelect(modelSel, c.models[i]);
      other.hidden = known || !settings.anyModel;
      other.value = known ? '' : c.models[i];
      if (!known && !settings.anyModel) {
        c.models[i] = DEFAULT_MODELS[i];
        modelSel.value = c.models[i];
      }
    } else other.hidden = true;

    const showPersona = shared;
    seat.querySelector('.persona-field').hidden = !showPersona;
    seat.querySelector('.persona-label').textContent = group === 'personality' ? 'Personality' : 'Perspective';
    const sel = seat.querySelector('.persona');
    if (showPersona && sel.dataset.group !== group) {
      sel.innerHTML = '';
      for (const [key, p] of Object.entries(PERSONAS)) if ((p.group ?? 'priority') === group) sel.add(new Option(p.label, key));
      sel.dataset.group = group;
    }
    if (showPersona) sel.value = PERSONAS[picks[i]] && (PERSONAS[picks[i]].group ?? 'priority') === group ? picks[i] : sel.options[0].value;
    const custom = seat.querySelector('.customPersona');
    custom.hidden = !showPersona || picks[i] !== 'custom';
    custom.value = c.custom[i] ?? '';

    const brand = brandOf(m.model);
    const avatar = seat.querySelector('.avatar');
    avatar.dataset.brand = brand ?? 'other';
    avatar.textContent = BRANDS[brand]?.initial ?? (m.model.replace(/^~/, '')[0] ?? '?').toUpperCase();
    seat.querySelector('.seat-name').textContent = shared ? `Member ${i + 1}` : m.name;
    seat.querySelector('.seat-sub').textContent = showPersona
      ? (m.persona === 'custom' ? 'Custom priority' : PERSONAS[m.persona]?.label ?? '')
      : m.model ? displayModel(m.model) : 'Pick a model';
    for (const el of seat.querySelectorAll('select, input, textarea')) el.disabled = running;
  });
  $('sharedModel').disabled = running;
  $('sharedOther').disabled = running;
  renderCouncilChip(members);
}

/** The small "who's on the council" button in the composer; opens Settings at the council. */
function renderCouncilChip(members) {
  const chipEl = $('councilChip');
  const avatars = chipEl.querySelector('.avatars');
  avatars.innerHTML = '';
  for (const m of members) {
    const brand = brandOf(m.model);
    const av = document.createElement('span');
    av.className = 'avatar';
    av.dataset.brand = brand ?? 'other';
    av.textContent = BRANDS[brand]?.initial ?? '?';
    avatars.append(av);
  }
  const c = settings.council;
  const label =
    c.mode === 'ais'
      ? members.map((m) => m.name).join(' · ')
      : c.mode === 'personalities'
        ? `${displayModel(c.shared)} as ${members.map((m) => PERSONAS[m.persona]?.label.split(' ').pop()).join(', ')}`
        : `${displayModel(c.shared)} × 3 perspectives`;
  chipEl.querySelector('.label').textContent = label;
  chipEl.disabled = running;
}

function nameFor(model) {
  const brand = brandOf(model);
  return BRANDS[brand]?.name ?? price(model)?.name.split(':').pop().trim() ?? model.split('/').pop() ?? 'Member';
}

/** The three members as the engine wants them, derived from the council style. */
function readSeats() {
  const c = settings.council;
  const seats = [0, 1, 2].map((i) => {
    const model = (c.mode === 'ais' ? c.models[i] : c.shared) || '';
    const picked = seatPersonas()[i];
    const group = MODES[c.mode].group;
    const persona = group && PERSONAS[picked] && (PERSONAS[picked].group ?? 'priority') === group ? picked : group === 'personality' ? DEFAULT_FIGURES[i] : group ? DEFAULT_PERSONAS[i] : 'balanced';
    return { name: nameFor(model), model, vision: price(model)?.vision, persona, customPersona: c.custom[i] ?? '' };
  });
  // Two seats with the same model and persona would get the same label; number them.
  const seen = {};
  for (const s of seats) {
    const key = `${s.name}|${s.persona}|${s.persona === 'custom' ? s.customPersona : ''}`;
    seen[key] = (seen[key] ?? 0) + 1;
    if (seen[key] > 1) s.name = `${s.name} ${seen[key]}`;
  }
  return seats;
}

// ---------- evidence boxes (the question box and the follow-up box each have one) ----------

function createEvidenceBox({ list, warn, input, label, onChange }) {
  let entries = [];
  let nextId = 1;
  let disabled = false;

  function renderList() {
    list.innerHTML = '';
    for (const e of entries) {
      const li = document.createElement('li');
      li.className = e.status;
      li.innerHTML = '<span class="name"></span><span class="note"></span><button type="button" aria-label="Remove">✕</button>';
      li.querySelector('.name').textContent = e.name;
      li.querySelector('.note').textContent =
        e.status === 'reading' ? 'reading…' : e.status === 'error' ? e.note : `${e.note}${e.chars ? ` · ${e.chars < 4000 ? '<1k' : `~${Math.round(e.chars / 4000)}k`} tokens` : ''}`;
      const remove = li.querySelector('button');
      remove.disabled = disabled;
      remove.addEventListener('click', () => {
        entries = entries.filter((x) => x !== e);
        render();
      });
      list.append(li);
    }
  }
  function render() {
    renderList();
    onChange();
  }

  const box = {
    ready: () => entries.filter((e) => e.status === 'ready'),
    reading: () => entries.some((e) => e.status === 'reading'),
    items: () => box.ready().flatMap((e) => e.items),
    has: (name) => entries.some((e) => e.name === name),
    clear() {
      entries = [];
      render();
    },
    addEntries(ready) {
      entries.push(...ready.map((e) => ({ ...e, id: nextId++ })));
      render();
    },
    async addFiles(files) {
      const added = [...files].map((file) => ({ id: nextId++, name: file.name, status: 'reading', file }));
      entries.push(...added);
      render();
      await Promise.all(
        added.map(async (e) => {
          try {
            Object.assign(e, await readAttachment(e.file), { status: 'ready' });
          } catch (err) {
            Object.assign(e, { status: 'error', note: String(err?.message ?? err).replace(`${e.name}: `, '') });
          }
          delete e.file;
          render();
        }),
      );
    },
    setDisabled(d) {
      disabled = d;
      input.disabled = d;
      label.classList.toggle('disabled', d);
      renderList();
    },
    updateWarn() {
      const images = box.ready().some((e) => e.images);
      const blind = images ? readSeats().filter((m) => m.vision === false) : [];
      warn.textContent = blind.length
        ? `Can't see images: ${blind.map((m) => displayModel(m.model)).join(', ')}. ${blind.length === 1 ? 'That member' : 'Those members'} will be told images exist but won't see them — pick an image-capable model to fix.`
        : '';
    },
  };
  input.accept = ACCEPT;
  input.addEventListener('change', () => {
    box.addFiles(input.files);
    input.value = '';
  });
  return box;
}

const mainBox = createEvidenceBox({
  list: $('attachList'),
  warn: $('attachWarn'),
  input: $('files'),
  label: document.querySelector('label[for="files"]'),
  onChange: () => refreshEstimates(),
});
const followBox = createEvidenceBox({
  list: $('followAttachList'),
  warn: $('followAttachWarn'),
  input: $('followFiles'),
  label: document.querySelector('label[for="followFiles"]'),
  onChange: () => refreshEstimates(),
});

function wireDrop(panel, box) {
  panel.addEventListener('dragover', (e) => {
    if (!e.dataTransfer?.types.includes('Files') || running) return;
    e.preventDefault();
    panel.classList.add('dragging');
  });
  panel.addEventListener('dragleave', (e) => {
    if (!panel.contains(e.relatedTarget)) panel.classList.remove('dragging');
  });
  panel.addEventListener('drop', (e) => {
    panel.classList.remove('dragging');
    if (!e.dataTransfer?.files.length || running) return;
    e.preventDefault();
    box.addFiles(e.dataTransfer.files);
  });
}

// ---------- cost estimate ----------

const money = (x) => `$${x.toFixed(x < 0.1 ? 3 : 2)}`;

/**
 * Rough per-run cost with and without prompt caching. Assumes ~500 visible output tokens per answer
 * (plus ~1,000 thinking tokens on reasoning models) and that each round re-sends the history.
 * With caching, everything up to the previous round is a cache read.
 */
function estimateCost(ready, extraChars) {
  const rounds = settings.rounds;
  const members = readSeats();
  const textTokens = (ready.reduce((s, e) => s + e.chars, 0) + extraChars) / 4;
  const imageCount = ready.reduce((s, e) => s + e.images, 0);
  let cached = 0;
  let plain = 0;
  let known = true;
  for (const m of members) {
    const p = price(m.model);
    if (!p) {
      known = false;
      continue;
    }
    const evidence = textTokens + (p.vision ? imageCount * 1500 : 0);
    const out = 500 + (p.efforts.length ? 1000 : 0);
    const write = needsCacheOptIn(m.model) ? p.cacheWrite || p.prompt : p.prompt;
    let prev = 0;
    for (let r = 0; r <= rounds; r++) {
      const input = 300 + evidence + r * 1600; // each round adds the others' two answers plus this member's reply
      const outputCost = (out * p.completion) / 1e6;
      plain += (input * p.prompt) / 1e6 + outputCost;
      cached += p.caching ? (prev * p.cacheRead + (input - prev) * write) / 1e6 + outputCost : (input * p.prompt) / 1e6 + outputCost;
      prev = input;
    }
  }
  const j = price(settings.chair);
  if (j) {
    const chair = (members.length * (1 + rounds) * 500 * j.prompt + 700 * j.completion) / 1e6;
    plain += chair;
    cached += chair;
  } else known = false;
  return { cached, plain, known, textTokens, imageCount, calls: members.length * (1 + rounds) + 1 };
}

function estimateText(ready, extraChars, noun) {
  const e = estimateCost(ready, extraChars);
  let text = `Up to ${e.calls} model calls per ${noun}.`;
  if (models.length && e.cached > 0) {
    text += ` Rough cost ~${money(e.cached)}`;
    const pct = Math.round((1 - e.cached / e.plain) * 100);
    if (pct >= 3) text += ` (prompt caching saves ~${pct}%)`;
    text += e.known ? '.' : ' — some models unpriced.';
  }
  if (ready.length || extraChars) {
    text += ` Includes ${e.textTokens < 1000 ? '<1k' : `~${Math.round(e.textTokens / 1000)}k`} tokens of evidence${e.imageCount ? ` and ${e.imageCount} image${e.imageCount > 1 ? 's' : ''}` : ''}.`;
  }
  return text;
}

function refreshEstimates() {
  $('estimate').textContent = estimateText(mainBox.ready(), 0, 'question');
  mainBox.updateWarn();
  if (!$('followPanel').hidden) {
    $('followEstimate').textContent = estimateText(followBox.ready(), sessions.at(-1)?.summary.length ?? 0, 'follow-up');
    followBox.updateWarn();
  }
}

function costText(cost, saved, final) {
  if (!cost) return '';
  let t = `${final ? 'Total' : 'Spent so far'}: $${cost.toFixed(4)}`;
  if (saved > 0.00005) t += ` · caching saved $${saved.toFixed(4)}`;
  return t;
}

// ---------- rendering ----------

function roundSection(parent, round) {
  const sec = document.createElement('div');
  sec.className = 'round';
  sec.innerHTML = `<div class="round-head"><h3>Round ${round}</h3><span>${round === 1 ? 'Opening answers, written independently' : 'Responding to each other'}</span></div><div class="round-grid"></div>`;
  parent.append(sec);
  return sec.querySelector('.round-grid');
}

function answerCard(label, model) {
  const el = document.createElement('article');
  el.className = 'answer thinking';
  el.innerHTML = '<header><span class="avatar small"></span><div><div class="who"></div><div class="model"></div></div></header><div class="body"></div>';
  const brand = brandOf(model);
  const av = el.querySelector('.avatar');
  av.dataset.brand = brand ?? 'other';
  av.textContent = BRANDS[brand]?.initial ?? '?';
  el.querySelector('.who').textContent = label;
  el.querySelector('.model').textContent = displayModel(model);
  return el;
}

// Long answers collapse once finished so a round fits on screen.
function collapsible(cardEl) {
  const body = cardEl.querySelector('.body');
  if (body.scrollHeight < 300) return;
  cardEl.classList.add('collapsed');
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'btn text small more';
  btn.textContent = 'Show more';
  btn.addEventListener('click', () => {
    const open = cardEl.classList.toggle('collapsed');
    btn.textContent = open ? 'Show more' : 'Show less';
  });
  cardEl.append(btn);
}

// The protocol lines (STANCE / AGREEMENT / QUESTION) are for the engine; the card shows the stance as a footer instead.
const PROTOCOL_LINE = /^\s*\**(STANCE|AGREEMENT|QUESTION)\**\s*:.*$/gim;
const stripProtocol = (text) => text.replace(PROTOCOL_LINE, '').trim();

const AGREE = { full: 'Agrees', partial: 'Partly agrees', none: 'Disagrees' };
const chip = (level, text) => (level ? `<span class="chip ${level}">${text ?? level}</span>` : '');
const inlineMd = (s) => renderMarkdown(String(s)).replace(/^<p>|<\/p>$/g, '');

function showVerdict(box, verdict) {
  box.hidden = false;
  const v = verdict.parsed;
  box.className = `card verdict ${v?.consensus ?? ''}`;
  if (!v) {
    box.innerHTML = `<div class="verdict-head"><span class="eyebrow">The chair's verdict</span><h2>Summary</h2></div><div class="body">${renderMarkdown(verdict.text)}</div>`;
    return;
  }
  const label = { full: 'Consensus reached', partial: 'Partial consensus', none: 'No consensus' }[v.consensus];
  const list = (items) => `<ul>${items.map((i) => `<li>${inlineMd(i)}</li>`).join('')}</ul>`;
  box.innerHTML = `
    <div class="verdict-head"><span class="eyebrow">The chair's verdict</span><h2>${label}</h2>${chip(v.consensus, { full: 'Full', partial: 'Partial', none: 'None' }[v.consensus])}</div>
    ${v.recommendation ? `<div class="rec"><strong>Recommendation</strong>${inlineMd(v.recommendation)}</div>` : ''}
    <div class="body">${renderMarkdown(v.summary ?? '')}</div>
    <div class="cols">
      ${v.agreements?.length ? `<div><h3>Agreed</h3>${list(v.agreements)}</div>` : ''}
      ${v.disagreements?.length ? `<div><h3>Still contested</h3>${list(v.disagreements)}</div>` : ''}
    </div>
    ${v.positions?.length ? `<h3>Final positions</h3>${list(v.positions.map((p) => `**${p.member}:** ${p.final_stance}`))}` : ''}`;
}

function setRunning(r) {
  running = r;
  $('go').disabled = r;
  $('followGo').disabled = r;
  $('reattach').disabled = r;
  $('followNote').disabled = r;
  $('question').disabled = r;
  mainBox.setDisabled(r);
  followBox.setDisabled(r);
  renderCouncil();
}

function newSession(title, withBar) {
  const el = document.createElement('div');
  el.className = 'session';
  el.innerHTML = `${title ? '<h2 class="session-title"></h2>' : ''}
    <div class="session-bar"${withBar ? '' : ' hidden'}><span class="status hint"></span><span class="cost hint"></span><button type="button" class="btn outlined small stop">Stop</button></div>
    <section class="card verdict" hidden></section><div class="rounds"></div>`;
  if (title) el.querySelector('.session-title').textContent = title;
  el.querySelector('.stop').addEventListener('click', () => controller?.abort());
  $('sessions').append(el);
  return el;
}

// ---------- follow-up panel ----------

function showFollowUp(verdict, reset) {
  const panel = $('followPanel');
  panel.hidden = false;
  panel.classList.toggle('attention', verdict?.parsed?.consensus !== 'full');
  if (reset) {
    $('followNote').value = '';
    $('followStatus').textContent = '';
    followBox.clear();
  }
  $('summaryText').textContent = sessions.at(-1).summary;
  const n = earlierEvidence.filter((e) => !followBox.has(e.name)).length;
  $('reattach').hidden = n === 0;
  $('reattach').textContent = `Re-attach earlier files (${n})`;
  refreshEstimates();
}

function hideFollowUp() {
  $('followPanel').hidden = true;
  $('followNote').value = '';
  followBox.clear();
}

// ---------- run ----------

function readConfig(statusEl) {
  const members = readSeats();
  if (!backend.hosted && !settings.apiKey) {
    openSettings(true);
    statusEl.textContent = 'Connect your OpenRouter account first.';
    return null;
  }
  if (members.some((m) => !m.model)) {
    statusEl.textContent = 'Every member needs a model.';
    return null;
  }
  const complete = makeComplete({
    apiKey: settings.apiKey,
    endpoint: backend.endpoint,
    getToken: backend.getToken,
    pricing: (id) => price(id),
  });
  return { members, judgeModel: settings.chair || DEFAULT_CHAIR, complete };
}

// ---------- listening ----------

const narrator = createNarrator({
  onChange: (playing) => {
    $('listen').textContent = playing ? 'Stop listening' : 'Listen';
    $('listen').setAttribute('aria-pressed', String(playing));
    // iPhone's silent switch mutes web speech even though other sounds may play.
    $('listenHint').hidden = !(playing && isAppleMobile());
  },
});

function verdictSpeech(verdict) {
  const v = verdict.parsed;
  if (!v) return `The chair's verdict. ${verdict.text}`;
  const label = { full: 'Consensus reached', partial: 'Partial consensus', none: 'No consensus' }[v.consensus] ?? '';
  const parts = [`The chair's verdict: ${label}.`];
  if (v.recommendation) parts.push(`Recommendation: ${v.recommendation}`);
  if (v.summary) parts.push(v.summary);
  if (v.disagreements?.length) parts.push(`Still contested: ${v.disagreements.join('. ')}`);
  return parts.join('\n');
}

async function convene() {
  const question = $('question').value.trim();
  const config = readConfig($('status'));
  if (!config) return;
  if (!question) return void $('question').focus();
  if (mainBox.reading()) return void ($('status').textContent = 'Still reading your attachments — try again in a moment.');

  document.body.classList.add('started');
  sessions = [];
  earlierEvidence = [];
  $('sessions').innerHTML = '';
  hideFollowUp();
  $('export').hidden = true;
  narrator.reset();
  $('listen').hidden = !canSpeak();
  $('cost').textContent = '';
  await runSession({
    config,
    kind: 'new',
    userQuestion: question,
    engineQuestion: question,
    attachments: mainBox.items(),
    evidence: mainBox.ready(),
    previous: null,
  });
}

async function conveneFollowUp() {
  const config = readConfig($('followStatus'));
  if (!config) return;
  if (followBox.reading()) return void ($('followStatus').textContent = 'Still reading your attachments — try again in a moment.');
  const previous = sessions.at(-1);
  if (!previous) return;
  const note = $('followNote').value.trim();
  $('followStatus').textContent = '';
  // The panel stays out of the way while a follow-up streams in, but its draft is kept in case the run fails.
  $('followPanel').hidden = true;
  await runSession({
    config,
    kind: 'follow',
    title: `Follow-up ${sessions.length}`,
    userQuestion: note || '(no note)',
    engineQuestion:
      'This continues an earlier council session; a summary of it is attached as "previous-session.md". ' +
      (note
        ? `The user's follow-up: ${note}`
        : 'The user gave no reason for the follow-up; focus on whatever was still contested or unresolved.'),
    attachments: [{ name: 'previous-session.md', kind: 'text', text: previous.summary }, ...followBox.items()],
    evidence: followBox.ready(),
    previous: previous.summary,
  });
}

async function runSession({ config, kind, title, userQuestion, engineQuestion, attachments, evidence, previous }) {
  const { members, judgeModel, complete } = config;
  const el = newSession(title, kind === 'follow');
  const ui =
    kind === 'new'
      ? { status: $('status'), cost: $('cost') }
      : { status: el.querySelector('.status'), cost: el.querySelector('.cost') };
  const stopBtn = kind === 'new' ? $('stop') : el.querySelector('.stop');
  const roundsEl = el.querySelector('.rounds');
  const verdictEl = el.querySelector('.verdict');
  stopBtn.hidden = false;
  setRunning(true);
  controller = new AbortController();
  if (kind === 'follow') el.scrollIntoView({ behavior: 'smooth', block: 'start' });

  let grid = null;
  let cards = [];
  let buffers = [];
  let judgeChars = 0;
  let labels = [];
  let askedBy = []; // the members' original questions, when the chair merged them

  // Pauses the run until the user answers (or skips) the council's question(s).
  const askUser = (questions, signal) =>
    new Promise((resolve, reject) => {
      const merged = askedBy.length > 1 && questions.length === 1;
      const panel = document.createElement('section');
      panel.className = 'card clarify';
      panel.innerHTML = `<h2></h2>
        <p class="hint"></p>
        <div class="qs"></div>
        <div class="ask-footer"><div class="actions"><button type="button" class="btn text skip">Skip — let them debate</button><button type="button" class="btn filled send">Send answer</button></div></div>`;
      panel.querySelector('h2').textContent = questions.length === 1 ? 'The council has a question for you' : 'The council has questions for you';
      panel.querySelector('.hint').textContent = questions.length === 1
        ? 'Every member sees your answer before the next round. Blank is fine.'
        : 'Answer what you can; blank is fine. Every member sees all the questions and answers before the next round.';
      if (questions.length > 1) panel.querySelector('.send').textContent = 'Send answers';
      const areas = questions.map((q) => {
        const div = document.createElement('div');
        div.className = 'q';
        div.innerHTML = '<div class="asker"></div><div class="text"></div><textarea rows="2" placeholder="Your answer…"></textarea>';
        div.querySelector('.asker').textContent = merged ? `Combined from ${askedBy.length} members' questions` : q.from;
        div.querySelector('.text').textContent = q.question;
        if (merged) {
          const det = document.createElement('details');
          det.className = 'origin';
          det.innerHTML = '<summary>What each member asked</summary><ul></ul>';
          for (const a of askedBy) {
            const li = document.createElement('li');
            li.textContent = `${a.from}: ${a.question}`;
            det.querySelector('ul').append(li);
          }
          div.querySelector('.text').after(det);
        }
        panel.querySelector('.qs').append(div);
        return div.querySelector('textarea');
      });
      roundsEl.append(panel);
      panel.scrollIntoView({ behavior: 'smooth', block: 'center' });
      areas[0].focus({ preventScroll: true });
      for (const a of areas) {
        a.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) panel.querySelector('.send').click();
        });
      }

      const freeze = (answers) => {
        panel.classList.add('done');
        panel.querySelector('h2').textContent = answers ? 'Your answer to the council' : 'You skipped the council’s questions';
        panel.querySelector('.hint').textContent = answers ? '' : 'The members will proceed on their own assumptions.';
        panel.querySelector('.ask-footer').remove();
        panel.querySelectorAll('.q').forEach((div, i) => {
          div.querySelector('textarea').replaceWith(
            Object.assign(document.createElement('p'), { className: 'answered', textContent: answers?.[i] || '(no answer)' }),
          );
          if (!answers) div.querySelector('.answered').remove();
        });
      };
      const onAbort = () => {
        freeze(null);
        reject(new DOMException('Aborted', 'AbortError'));
      };
      const done = (answers) => {
        signal?.removeEventListener('abort', onAbort);
        freeze(answers);
        resolve(answers);
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      panel.querySelector('.send').addEventListener('click', () => done(areas.map((a) => a.value.trim())));
      panel.querySelector('.skip').addEventListener('click', () => done(null));
    });

  const onEvent = (e) => {
    switch (e.type) {
      case 'round-start':
        ui.status.textContent = `Round ${e.round} of ${e.totalRounds}…`;
        grid = roundSection(roundsEl, e.round);
        narrator.push('chair', `${kind === 'follow' && e.round === 1 ? `${title}. ` : ''}Round ${e.round}.`);
        cards = [];
        buffers = [];
        break;
      case 'member-start':
        cards[e.index] = answerCard(e.label, members[e.index].model);
        labels[e.index] = e.label;
        buffers[e.index] = '';
        grid.append(cards[e.index]);
        break;
      case 'token':
        buffers[e.index] += e.token;
        cards[e.index].querySelector('.body').innerHTML = renderMarkdown(buffers[e.index]);
        break;
      case 'member-done': {
        const c = cards[e.index];
        c.classList.remove('thinking');
        c.querySelector('.body').innerHTML = renderMarkdown(stripProtocol(e.entry.text));
        if (e.entry.stance) {
          const st = document.createElement('div');
          st.className = 'stance';
          st.innerHTML = `<strong>Stance</strong>${inlineMd(e.entry.stance.replace(/\*+$/, ''))}`;
          c.append(st);
        }
        if (e.round > 1 && e.entry.agreement) c.querySelector('header').insertAdjacentHTML('beforeend', chip(e.entry.agreement, AGREE[e.entry.agreement]));
        collapsible(c);
        narrator.push(
          e.index,
          `${labels[e.index]}.\n${stripProtocol(e.entry.text)}${e.entry.stance ? `\nStance: ${e.entry.stance}` : ''}`,
        );
        ui.cost.textContent = costText(e.cost, e.saved);
        break;
      }
      case 'member-error': {
        const c = cards[e.index];
        c.classList.remove('thinking');
        c.classList.add('error');
        c.querySelector('.body').textContent = e.entry.error;
        break;
      }
      case 'merge-start':
        ui.status.textContent = 'The chair is combining the members’ questions…';
        break;
      case 'clarify-start':
        askedBy = e.asked ?? [];
        ui.status.textContent = 'Waiting for your answer…';
        break;
      case 'early-stop':
        ui.status.textContent = `All three fully agreed after round ${e.round} — skipping the remaining rounds.`;
        break;
      case 'judge-start':
        ui.status.textContent = 'The chair is writing the verdict…';
        break;
      case 'judge-token':
        judgeChars += e.token.length;
        ui.status.textContent = `The chair is writing the verdict… (${judgeChars} chars)`;
        break;
      case 'verdict':
        showVerdict(verdictEl, e.verdict);
        narrator.push('chair', verdictSpeech(e.verdict));
        ui.cost.textContent = costText(e.cost, e.saved, true);
        break;
    }
  };

  try {
    const result = await runCouncil({
      question: engineQuestion,
      members,
      attachments,
      rounds: settings.rounds,
      earlyStop: settings.earlyStop,
      judgeModel,
      complete,
      askUser: settings.clarify ? askUser : undefined,
      mergeQuestions: settings.mergeQuestions,
      effort: settings.effort || undefined,
      onEvent,
      signal: controller.signal,
    });
    const summary = sessionSummary({
      question: userQuestion,
      clarifications: result.clarifications,
      transcript: result.transcript,
      verdict: result.verdict,
      attachments,
      previous,
    });
    sessions.push({ title, userQuestion, attachments, ...result, summary });
    for (const e of evidence) if (!earlierEvidence.some((x) => x.name === e.name)) earlierEvidence.push(e);
    ui.status.textContent = 'Done.';
    $('export').hidden = false;
    verdictEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
    showFollowUp(result.verdict, true);
  } catch (err) {
    ui.status.textContent = err?.name === 'AbortError' ? 'Stopped.' : `Error: ${err?.message ?? err}`;
    for (const c of el.querySelectorAll('.answer.thinking')) c.classList.remove('thinking');
    // A failed follow-up leaves the panel open again with the draft intact.
    if (sessions.length) showFollowUp(sessions.at(-1).verdict, false);
  } finally {
    setRunning(false);
    stopBtn.hidden = true;
    controller = null;
    refreshEstimates();
  }
}

function exportTranscript() {
  if (!sessions.length) return;
  const md = sessions
    .map((s, i) => {
      const t = transcriptMarkdown(i === 0 ? s.userQuestion : `Follow-up: ${s.userQuestion}`, s.transcript, s.verdict, s.attachments, s.clarifications);
      return i === 0 ? t : t.replace('# Council transcript', `# Follow-up ${i}`);
    })
    .join('\n\n---\n\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([md], { type: 'text/markdown' }));
  a.download = `council-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}.md`;
  a.click();
  URL.revokeObjectURL(a.href);
}

// ---------- settings dialog ----------

function openSettings(focusKey = false, section = null) {
  const d = $('settings');
  if (!d.open) d.showModal();
  if (section) {
    d.querySelector('form').scrollTop = 0;
    $(section).scrollIntoView({ block: 'start' });
  }
  if (focusKey && !backend.hosted) {
    $('connectSection').scrollIntoView({ block: 'start' });
    $('apiKey').focus();
  }
}

function syncSettingsForm() {
  $('apiKey').value = settings.apiKey;
  $('rounds').value = String(settings.rounds);
  $('earlyStop').checked = settings.earlyStop;
  $('clarify').checked = settings.clarify;
  $('mergeQuestions').checked = settings.mergeQuestions;
  $('mergeQuestions').disabled = !settings.clarify;
  $('effort').value = settings.effort;
  $('anyModel').checked = settings.anyModel;
  $('cachingOnly').checked = settings.cachingOnly;
  $('cachingOnly').disabled = !settings.anyModel;
  const chair = $('chair');
  chair.innerHTML = '';
  for (const c of CHAIRS) chair.add(new Option(`${c.label} — ${c.tag}`, c.id));
  chair.value = settings.chair;
}

async function verifyKey() {
  const key = settings.apiKey;
  const out = $('keyStatus');
  out.className = 'hint';
  if (!key) {
    out.textContent = '';
    return;
  }
  out.textContent = 'Checking…';
  try {
    const k = await checkKey(key);
    if (settings.apiKey !== key) return;
    out.className = 'hint ok';
    out.textContent = k.limit_remaining != null
      ? `Connected · $${Number(k.limit_remaining).toFixed(2)} left on this key`
      : `Connected · $${Number(k.usage ?? 0).toFixed(2)} used so far`;
  } catch (err) {
    if (settings.apiKey !== key) return;
    out.className = 'hint bad';
    out.textContent = err.message;
  }
}

function wireSettings() {
  $('settingsBtn').addEventListener('click', () => openSettings());
  $('councilChip').addEventListener('click', () => openSettings(false, 'councilSection'));
  $('welcomeBtn').addEventListener('click', () => openSettings(true));
  $('themeBtn').addEventListener('click', () => {
    settings.theme = isDark() ? 'light' : 'dark';
    save();
    applyTheme();
  });
  $('settings').addEventListener('click', (e) => {
    if (e.target === $('settings')) $('settings').close(); // click on the backdrop
  });
  $('settings').addEventListener('close', () => {
    updateWelcome();
    refreshEstimates();
  });
  $('apiKey').addEventListener('change', () => {
    settings.apiKey = $('apiKey').value.trim();
    save();
    updateWelcome();
    verifyKey();
  });
  $('checkKey').addEventListener('click', verifyKey);
  $('rounds').addEventListener('change', () => {
    settings.rounds = Number($('rounds').value);
    save();
  });
  for (const id of ['earlyStop', 'clarify', 'mergeQuestions', 'anyModel', 'cachingOnly']) {
    $(id).addEventListener('change', () => {
      settings[id] = $(id).checked;
      save();
      syncSettingsForm();
      if (id === 'anyModel' || id === 'cachingOnly') {
        fillDatalist();
        renderCouncil();
      }
    });
  }
  $('effort').addEventListener('change', () => {
    settings.effort = $('effort').value;
    save();
  });
  $('chair').addEventListener('change', () => {
    settings.chair = $('chair').value;
    save();
  });
}

function updateWelcome() {
  $('welcome').hidden = backend.hosted || Boolean(settings.apiKey);
}

// ---------- init ----------

/**
 * Invite links: https://…/My-Council/#key=sk-or-… saves that OpenRouter key and connects the tester
 * in one click. The part after # never leaves the browser (it isn't sent to the web server), and it
 * is removed from the address bar straight away.
 */
function acceptInvite() {
  const key = new URLSearchParams(location.hash.slice(1)).get('key')?.trim();
  if (!key) return false;
  history.replaceState(null, '', location.pathname + location.search);
  if (!/^sk-or-[\w-]{10,}$/.test(key) || backend.hosted) return false;
  settings.apiKey = key;
  save();
  return true;
}

export function start() {
  const invited = acceptInvite();
  buildSeats();
  applyTheme();
  syncSettingsForm();
  wireSettings();
  renderCouncil();
  updateWelcome();
  if (backend.hosted) {
    // The hosted proxy holds the key and only accepts the curated models.
    $('connectSection').hidden = true;
    settings.anyModel = false;
    for (const id of ['anyModel', 'cachingOnly']) $(id).closest('.switch').hidden = true;
    renderCouncil();
  } else if (settings.apiKey) verifyKey();
  if (invited) {
    $('status').textContent = 'You’re connected with an invite key. Ask the council anything.';
    $('question').focus();
  }

  wireDrop($('askPanel'), mainBox);
  wireDrop($('followPanel'), followBox);
  $('reattach').addEventListener('click', () => {
    followBox.addEntries(earlierEvidence.filter((e) => !followBox.has(e.name)));
    $('reattach').hidden = true;
  });
  $('go').addEventListener('click', convene);
  $('followGo').addEventListener('click', conveneFollowUp);
  $('stop').addEventListener('click', () => controller?.abort());
  $('export').addEventListener('click', exportTranscript);
  $('listen').addEventListener('click', () => (narrator.playing ? narrator.stop() : narrator.play()));
  $('question').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) convene();
  });
  $('followNote').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) conveneFollowUp();
  });

  refreshEstimates();
  listModels()
    .then((list) => {
      models = list;
      fillDatalist();
      renderCouncil();
      refreshEstimates();
    })
    .catch(() => {
      $('estimate').textContent += ' (Could not load prices from OpenRouter.)';
    });
}

// The hosted build sets window.MY_COUNCIL_DEFER and calls start() itself after login.
if (!window.MY_COUNCIL_DEFER) start();
