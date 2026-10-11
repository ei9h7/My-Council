import { PERSONAS, runCouncil, transcriptMarkdown, sessionSummary } from './council.js';
import { listModels, makeComplete } from './openrouter.js';
import { renderMarkdown } from './markdown.js';
import { ACCEPT, readAttachment } from './attachments.js';

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
let running = false;
let sessions = []; // finished sessions in the current chain: [{title, userQuestion, attachments, transcript, verdict, clarifications, summary}]
let earlierEvidence = []; // ready evidence entries used anywhere in this chain, for "re-attach"

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
        clarify: $('clarify').checked,
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
      refreshEstimates();
      save();
    });
    seat.querySelector('.model').addEventListener('change', () => {
      refreshEstimates();
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
      vision: models.find((x) => x.id === model)?.vision,
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
        ? `Can't see images: ${blind.map((m) => m.model).join(', ')}. ${blind.length === 1 ? 'That member' : 'Those members'} will be told images exist but won't see them — pick an image-capable model to fix.`
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

function estimateText(ready, extraChars, noun) {
  const rounds = Number($('rounds').value) || 0;
  const members = readSeats();
  const calls = members.length * (1 + rounds) + 1;
  let text = `Up to ${calls} model calls per ${noun}.`;
  // Rough: ~500 output tokens per answer; each later round re-sends the history plus the others' answers.
  const price = (id) => models.find((m) => m.id === id);
  let est = 0;
  let known = true;
  const textTokens = (ready.reduce((s, e) => s + e.chars, 0) + extraChars) / 4;
  const imageCount = ready.reduce((s, e) => s + e.images, 0);
  for (const m of members) {
    const p = price(m.model);
    if (!p) { known = false; continue; }
    // Evidence sits in the opening message, so it is re-sent with every round.
    const evidenceTokens = textTokens + (p.vision ? imageCount * 1500 : 0);
    for (let r = 0; r <= rounds; r++) est += ((300 + evidenceTokens + r * 1600) * p.prompt + 500 * p.completion) / 1e6;
  }
  const j = price($('judgeModel').value.trim());
  if (j) est += (members.length * (1 + rounds) * 500 * j.prompt + 600 * j.completion) / 1e6;
  else known = false;
  if (models.length && est > 0) text += ` Rough cost: ~$${est.toFixed(est < 0.1 ? 3 : 2)}${known ? '' : ' (some models unpriced)'}.`;
  if (ready.length || extraChars) text += ` Includes ${textTokens < 1000 ? '<1k' : `~${Math.round(textTokens / 1000)}k`} tokens of evidence${imageCount ? ` and ${imageCount} image${imageCount > 1 ? 's' : ''}` : ''}, re-sent each round.`;
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

// ---------- rendering ----------

function roundSection(parent, round) {
  const sec = document.createElement('div');
  sec.className = 'round';
  sec.innerHTML = `<h2>Round ${round}${round === 1 ? ' — opening answers' : ' — responding to each other'}</h2><div class="round-grid"></div>`;
  parent.append(sec);
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

function showVerdict(box, verdict) {
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

function setRunning(r) {
  running = r;
  $('go').disabled = r;
  $('followGo').disabled = r;
  $('reattach').disabled = r;
  $('followNote').disabled = r;
  for (const el of document.querySelectorAll('#seats input, #seats select, #seats textarea, .presets button')) el.disabled = r;
  mainBox.setDisabled(r);
  followBox.setDisabled(r);
}

function newSession(title, withBar) {
  const el = document.createElement('div');
  el.className = 'session';
  el.innerHTML = `${title ? '<h2 class="session-title"></h2>' : ''}
    <div class="session-bar"${withBar ? '' : ' hidden'}><span class="status hint"></span><span class="cost hint"></span><button type="button" class="stop">Stop</button></div>
    <section class="panel verdict" hidden></section><div class="rounds"></div>`;
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
  const apiKey = $('apiKey').value.trim();
  const members = readSeats();
  if (!apiKey) {
    $('settings').open = true;
    $('apiKey').focus();
    statusEl.textContent = 'Add your OpenRouter API key first.';
    return null;
  }
  if (members.some((m) => !m.model)) {
    statusEl.textContent = 'Every member needs a model.';
    return null;
  }
  return { apiKey, members, judgeModel: $('judgeModel').value.trim() || members[0].model };
}

async function convene() {
  const question = $('question').value.trim();
  const config = readConfig($('status'));
  if (!config) return;
  if (!question) return void $('question').focus();
  if (mainBox.reading()) return void ($('status').textContent = 'Still reading your attachments — try again in a moment.');
  save();

  sessions = [];
  earlierEvidence = [];
  $('sessions').innerHTML = '';
  hideFollowUp();
  $('export').hidden = true;
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
  save();
  $('followStatus').textContent = '';
  hideFollowUpWhileRunning();
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

// The panel stays out of the way while a follow-up streams in, but its draft is kept in case the run fails.
function hideFollowUpWhileRunning() {
  $('followPanel').hidden = true;
}

async function runSession({ config, kind, title, userQuestion, engineQuestion, attachments, evidence, previous }) {
  const { apiKey, members, judgeModel } = config;
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

  // Pauses the run until the user answers (or skips) the members' questions.
  const askUser = (questions, signal) =>
    new Promise((resolve, reject) => {
      const panel = document.createElement('section');
      panel.className = 'panel clarify';
      panel.innerHTML = `<h2></h2>
        <p class="hint">Answer what you can; blank is fine. Every member sees all the questions and answers before the next round.</p>
        <div class="qs"></div>
        <div class="row actions"><button type="button" class="primary send">Send answers</button><button type="button" class="skip">Skip — let them debate</button></div>`;
      panel.querySelector('h2').textContent = questions.length === 1 ? 'The council has a question for you' : 'The council has questions for you';
      const areas = questions.map((q) => {
        const div = document.createElement('div');
        div.className = 'q';
        div.innerHTML = '<div class="asker"></div><div class="text"></div><textarea rows="2" placeholder="Your answer…"></textarea>';
        div.querySelector('.asker').textContent = q.from;
        div.querySelector('.text').textContent = q.question;
        panel.querySelector('.qs').append(div);
        return div.querySelector('textarea');
      });
      roundsEl.append(panel);
      panel.scrollIntoView({ behavior: 'smooth', block: 'center' });
      areas[0].focus({ preventScroll: true });

      const freeze = (answers) => {
        panel.classList.add('done');
        panel.querySelector('h2').textContent = answers ? 'Your answers to the council' : 'You skipped the council’s questions';
        panel.querySelector('.hint').textContent = answers ? '' : 'The members will proceed on their own assumptions.';
        panel.querySelector('.actions').remove();
        panel.querySelectorAll('.q').forEach((div, i) => {
          div.querySelector('textarea').replaceWith(
            Object.assign(document.createElement('p'), { className: 'answer', textContent: answers?.[i] || '(no answer)' }),
          );
          if (!answers) div.querySelector('.answer').remove();
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
        if (e.cost) ui.cost.textContent = `Spent so far: $${e.cost.toFixed(4)}`;
        break;
      }
      case 'member-error': {
        const c = cards[e.index];
        c.classList.remove('thinking');
        c.classList.add('error');
        c.querySelector('.body').textContent = e.entry.error;
        break;
      }
      case 'clarify-start':
        ui.status.textContent = 'Waiting for your answers…';
        break;
      case 'early-stop':
        ui.status.textContent = `All three fully agreed after round ${e.round} — skipping the remaining rounds.`;
        break;
      case 'judge-start':
        ui.status.textContent = 'The chair is summarising the debate…';
        break;
      case 'judge-token':
        judgeChars += e.token.length;
        ui.status.textContent = `The chair is summarising the debate… (${judgeChars} chars)`;
        break;
      case 'verdict':
        showVerdict(verdictEl, e.verdict);
        if (e.cost) ui.cost.textContent = `Total cost: $${e.cost.toFixed(4)}`;
        break;
    }
  };

  try {
    const result = await runCouncil({
      question: engineQuestion,
      members,
      attachments,
      rounds: Number($('rounds').value) || 0,
      earlyStop: $('earlyStop').checked,
      judgeModel,
      complete: makeComplete(apiKey),
      askUser: $('clarify').checked ? askUser : undefined,
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
    for (const c of el.querySelectorAll('.card.thinking')) c.classList.remove('thinking');
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

// ---------- init ----------

buildSeats();
const saved = load();
$('apiKey').value = saved.apiKey ?? '';
$('rounds').value = saved.rounds ?? 3;
$('earlyStop').checked = saved.earlyStop ?? true;
$('clarify').checked = saved.clarify ?? true;
$('judgeModel').value = saved.judgeModel ?? MODELS.claude;
writeSeats(saved.members?.length === 3 ? saved.members : PRESETS.mixed);
if (!saved.apiKey) $('settings').open = true;

for (const btn of document.querySelectorAll('[data-preset]')) {
  btn.addEventListener('click', () => {
    writeSeats(PRESETS[btn.dataset.preset]);
    refreshEstimates();
    save();
  });
}
for (const id of ['apiKey', 'rounds', 'earlyStop', 'clarify', 'judgeModel']) {
  $(id).addEventListener('change', () => {
    refreshEstimates();
    save();
  });
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
    const dl = $('modelList');
    for (const m of list) {
      const price = m.prompt || m.completion ? ` — $${m.prompt.toFixed(2)}/$${m.completion.toFixed(2)} per M tokens` : '';
      dl.append(new Option(`${m.name}${price}`, m.id));
    }
    refreshEstimates();
  })
  .catch(() => {
    $('estimate').textContent += ' (Could not load the model list — you can still type model IDs.)';
  });
