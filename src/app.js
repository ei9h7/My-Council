import { PERSONAS, runCouncil, transcriptMarkdown } from './council.js';
import { listModels, makeComplete } from './openrouter.js';
import { renderMarkdown } from './markdown.js';

const $ = (id) => document.getElementById(id);
const STORE = 'my-council:v1';

const MODELS = {
  claude: 'anthropic/claude-sonnet-5.5',
  chatgpt: 'openai/gpt-6.1-sol',
  gemini: 'google/gemini-3.1-pro-preview',
  claudeCheap: 'anthropic/claude-haiku-5.5',
  chatgptCheap: 'openai/gpt-6-luna',
  geminiCheap: 'google/gemini-3.8-flash',
};

const PRESETS = {
  assistants: [
    { name: 'Claude', model: MODELS.claude, persona: 'balanced' },
    { name: 'ChatGPT', model: MODELS.chatgpt, persona: 'balanced' },
    { name: 'Gemini', model: MODELS.gemini, persona: 'balanced' },
  ],
  personas: [
    { name: 'Claude', model: MODELS.claude, persona: 'money' },
    { name: 'Claude', model: MODELS.claude, persona: 'time' },
    { name: 'Claude', model: MODELS.claude, persona: 'stress' },
  ],
  mixed: [
    { name: 'Claude', model: MODELS.claude, persona: 'money' },
    { name: 'ChatGPT', model: MODELS.chatgpt, persona: 'time' },
    { name: 'Gemini', model: MODELS.gemini, persona: 'stress' },
  ],
  budget: [
    { name: 'Claude', model: MODELS.claudeCheap, persona: 'money' },
    { name: 'ChatGPT', model: MODELS.chatgptCheap, persona: 'time' },
    { name: 'Gemini', model: MODELS.geminiCheap, persona: 'stress' },
  ],
};

let models = [];
let controller = null;
let lastRun = null;

// ---------- persistence ----------

function load() {
  try {
    return JSON.parse(localStorage.getItem(STORE)) ?? {};
  } catch {
    return {};
  }
}
function save() {
  try {
    localStorage.setItem(
      STORE,
      JSON.stringify({
        apiKey: $('apiKey').value.trim(),
        rounds: $('rounds').value,
        earlyStop: $('earlyStop').checked,
        judgeModel: $('judgeModel').value.trim(),
        members: readSeats(),
      }),
    );
  } catch {}
}

// ---------- seats ----------

function nameFor(model) {
  const vendor = model.split('/')[0];
  return { anthropic: 'Claude', openai: 'ChatGPT', google: 'Gemini', 'x-ai': 'Grok' }[vendor] ??
    models.find((m) => m.id === model)?.name.split(':')[0] ?? vendor;
}

function buildSeats() {
  const tpl = $('seatTpl');
  for (let i = 0; i < 3; i++) {
    const seat = tpl.content.firstElementChild.cloneNode(true);
    seat.querySelector('h3').textContent = `Member ${i + 1}`;
    const sel = seat.querySelector('.persona');
    for (const [key, p] of Object.entries(PERSONAS)) sel.add(new Option(p.label, key));
    const custom = seat.querySelector('.customPersona');
    sel.addEventListener('change', () => {
      custom.hidden = sel.value !== 'custom';
      updateEstimate();
      save();
    });
    seat.querySelector('.model').addEventListener('change', () => {
      updateEstimate();
      save();
    });
    custom.addEventListener('change', save);
    $('seats').append(seat);
  }
}

function readSeats() {
  return [...$('seats').children].map((seat) => {
    const model = seat.querySelector('.model').value.trim();
    return {
      name: nameFor(model),
      model,
      persona: seat.querySelector('.persona').value,
      customPersona: seat.querySelector('.customPersona').value,
    };
  });
}

function writeSeats(members) {
  [...$('seats').children].forEach((seat, i) => {
    const m = members[i];
    if (!m) return;
    seat.querySelector('.model').value = m.model;
    seat.querySelector('.persona').value = m.persona in PERSONAS ? m.persona : 'balanced';
    seat.querySelector('.customPersona').value = m.customPersona ?? '';
    seat.querySelector('.customPersona').hidden = m.persona !== 'custom';
  });
}

// ---------- cost estimate ----------

function updateEstimate() {
  const rounds = Number($('rounds').value) || 0;
  const members = readSeats();
  const calls = members.length * (1 + rounds) + 1;
  let text = `Up to ${calls} model calls per question.`;
  // Rough: ~500 output tokens per answer; each later round re-sends the history plus the others' answers.
  const price = (id) => models.find((m) => m.id === id);
  let est = 0;
  let known = true;
  for (const m of members) {
    const p = price(m.model);
    if (!p) { known = false; continue; }
    for (let r = 0; r <= rounds; r++) est += ((300 + r * 1600) * p.prompt + 500 * p.completion) / 1e6;
  }
  const j = price($('judgeModel').value.trim());
  if (j) est += (members.length * (1 + rounds) * 500 * j.prompt + 600 * j.completion) / 1e6;
  else known = false;
  if (models.length && est > 0) text += ` Rough cost: ~$${est.toFixed(est < 0.1 ? 3 : 2)}${known ? '' : ' (some models unpriced)'}.`;
  $('estimate').textContent = text;
}

// ---------- rendering ----------

function roundSection(round) {
  const sec = document.createElement('div');
  sec.className = 'round';
  sec.innerHTML = `<h2>Round ${round}${round === 1 ? ' — opening answers' : ' — responding to each other'}</h2><div class="round-grid"></div>`;
  $('rounds-out').append(sec);
  return sec.querySelector('.round-grid');
}

function card(label, model) {
  const el = document.createElement('article');
  el.className = 'card thinking';
  el.innerHTML = '<header><div class="who"></div><div class="model"></div></header><div class="body"></div>';
  el.querySelector('.who').textContent = label;
  el.querySelector('.model').textContent = model;
  return el;
}

function badge(level) {
  return level ? `<span class="badge ${level}">${level}</span>` : '';
}

function showVerdict(verdict) {
  const box = $('verdict');
  box.hidden = false;
  const v = verdict.parsed;
  if (!v) {
    box.innerHTML = `<h2>Chair's summary</h2><div class="body">${renderMarkdown(verdict.text)}</div>`;
    return;
  }
  const label = { full: 'Consensus reached', partial: 'Partial consensus', none: 'No consensus' }[v.consensus];
  const list = (items) => `<ul>${items.map((i) => `<li>${renderMarkdown(String(i)).replace(/^<p>|<\/p>$/g, '')}</li>`).join('')}</ul>`;
  box.innerHTML = `
    <h2>${label} ${badge(v.consensus)}</h2>
    ${v.recommendation ? `<div class="rec"><strong>Recommendation:</strong> ${renderMarkdown(v.recommendation).replace(/^<p>|<\/p>$/g, '')}</div>` : ''}
    <div class="body">${renderMarkdown(v.summary ?? '')}</div>
    ${v.agreements?.length ? `<h3>Agreed</h3>${list(v.agreements)}` : ''}
    ${v.disagreements?.length ? `<h3>Still contested</h3>${list(v.disagreements)}` : ''}
    ${v.positions?.length ? `<h3>Final positions</h3>${list(v.positions.map((p) => `**${p.member}:** ${p.final_stance}`))}` : ''}`;
}

function setRunning(running) {
  $('go').disabled = running;
  $('stop').hidden = !running;
  for (const el of document.querySelectorAll('#seats input, #seats select, #seats textarea, .presets button')) el.disabled = running;
}

// ---------- run ----------

async function convene() {
  const apiKey = $('apiKey').value.trim();
  const question = $('question').value.trim();
  const members = readSeats();
  if (!apiKey) {
    $('settings').open = true;
    $('apiKey').focus();
    $('status').textContent = 'Add your OpenRouter API key first.';
    return;
  }
  if (!question) return void $('question').focus();
  if (members.some((m) => !m.model)) return void ($('status').textContent = 'Every member needs a model.');
  const judgeModel = $('judgeModel').value.trim() || members[0].model;
  save();

  $('rounds-out').innerHTML = '';
  $('verdict').hidden = true;
  $('export').hidden = true;
  $('cost').textContent = '';
  setRunning(true);
  controller = new AbortController();

  let grid = null;
  let cards = [];
  let buffers = [];
  let judgeChars = 0;

  const onEvent = (e) => {
    switch (e.type) {
      case 'round-start':
        $('status').textContent = `Round ${e.round} of ${e.totalRounds}…`;
        grid = roundSection(e.round);
        cards = [];
        buffers = [];
        break;
      case 'member-start':
        cards[e.index] = card(e.label, members[e.index].model);
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
        c.querySelector('.body').innerHTML = renderMarkdown(e.entry.text);
        if (e.round > 1 && e.entry.agreement) c.querySelector('header').insertAdjacentHTML('beforeend', badge(e.entry.agreement));
        if (e.cost) $('cost').textContent = `Spent so far: $${e.cost.toFixed(4)}`;
        break;
      }
      case 'member-error': {
        const c = cards[e.index];
        c.classList.remove('thinking');
        c.classList.add('error');
        c.querySelector('.body').textContent = e.entry.error;
        break;
      }
      case 'early-stop':
        $('status').textContent = `All three fully agreed after round ${e.round} — skipping the remaining rounds.`;
        break;
      case 'judge-start':
        $('status').textContent = 'The chair is summarising the debate…';
        break;
      case 'judge-token':
        judgeChars += e.token.length;
        $('status').textContent = `The chair is summarising the debate… (${judgeChars} chars)`;
        break;
      case 'verdict':
        showVerdict(e.verdict);
        if (e.cost) $('cost').textContent = `Total cost: $${e.cost.toFixed(4)}`;
        break;
    }
  };

  try {
    const result = await runCouncil({
      question,
      members,
      rounds: Number($('rounds').value) || 0,
      earlyStop: $('earlyStop').checked,
      judgeModel,
      complete: makeComplete(apiKey),
      onEvent,
      signal: controller.signal,
    });
    lastRun = { question, ...result };
    $('status').textContent = 'Done.';
    $('export').hidden = false;
    $('verdict').scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (err) {
    $('status').textContent = err?.name === 'AbortError' ? 'Stopped.' : `Error: ${err?.message ?? err}`;
    for (const c of document.querySelectorAll('.card.thinking')) c.classList.remove('thinking');
  } finally {
    setRunning(false);
    controller = null;
  }
}

function exportTranscript() {
  if (!lastRun) return;
  const md = transcriptMarkdown(lastRun.question, lastRun.transcript, lastRun.verdict);
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([md], { type: 'text/markdown' }));
  a.download = `council-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}.md`;
  a.click();
  URL.revokeObjectURL(a.href);
}

// ---------- init ----------

buildSeats();
const saved = load();
$('apiKey').value = saved.apiKey ?? '';
$('rounds').value = saved.rounds ?? 3;
$('earlyStop').checked = saved.earlyStop ?? true;
$('judgeModel').value = saved.judgeModel ?? MODELS.claude;
writeSeats(saved.members?.length === 3 ? saved.members : PRESETS.mixed);
if (!saved.apiKey) $('settings').open = true;

for (const btn of document.querySelectorAll('[data-preset]')) {
  btn.addEventListener('click', () => {
    writeSeats(PRESETS[btn.dataset.preset]);
    updateEstimate();
    save();
  });
}
for (const id of ['apiKey', 'rounds', 'earlyStop', 'judgeModel']) {
  $(id).addEventListener('change', () => {
    updateEstimate();
    save();
  });
}
$('go').addEventListener('click', convene);
$('stop').addEventListener('click', () => controller?.abort());
$('export').addEventListener('click', exportTranscript);
$('question').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) convene();
});

updateEstimate();
listModels()
  .then((list) => {
    models = list;
    const dl = $('modelList');
    for (const m of list) {
      const price = m.prompt || m.completion ? ` — $${m.prompt.toFixed(2)}/$${m.completion.toFixed(2)} per M tokens` : '';
      dl.append(new Option(`${m.name}${price}`, m.id));
    }
    updateEstimate();
  })
  .catch(() => {
    $('estimate').textContent += ' (Could not load the model list — you can still type model IDs.)';
  });
