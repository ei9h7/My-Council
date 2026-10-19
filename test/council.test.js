import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  runCouncil, parseStance, parseVerdict, systemPrompt, openingMessage, transcriptMarkdown,
  parseQuestion, clarificationsBlock, sessionSummary, CLARIFY_INSTRUCTION, parseMerged,
} from '../src/council.js';
import { requestBody, cacheSavings, needsCacheOptIn } from '../src/openrouter.js';
import { renderMarkdown } from '../src/markdown.js';

const members = [
  { name: 'Claude', model: 'a/claude', persona: 'money' },
  { name: 'ChatGPT', model: 'b/gpt', persona: 'time' },
  { name: 'Gemini', model: 'c/gemini', persona: 'stress' },
];
const verdictJson = JSON.stringify({ consensus: 'full', summary: 's', recommendation: 'r', agreements: [], disagreements: [] });

function fakeComplete(agreementByRound = () => 'partial') {
  const calls = [];
  const complete = async ({ model, messages }) => {
    calls.push({ model, messages: structuredClone(messages) });
    if (messages[0].content.startsWith('You are the chair')) return { text: verdictJson, cost: 0.01 };
    const round = messages.filter((m) => m.role === 'user').length;
    return { text: `answer r${round}\nSTANCE: do X\nAGREEMENT: ${round === 1 ? 'n/a' : agreementByRound(round)}`, cost: 0.001 };
  };
  return { complete, calls };
}

test('runs opening + N debate rounds, then the chair', async () => {
  const { complete, calls } = fakeComplete();
  const res = await runCouncil({ question: 'Q?', members, rounds: 3, earlyStop: true, judgeModel: 'j', complete });
  assert.equal(res.transcript.length, 4);
  assert.equal(calls.length, 3 * 4 + 1);
  assert.equal(res.verdict.parsed.consensus, 'full');
  assert.ok(Math.abs(res.cost - (12 * 0.001 + 0.01)) < 1e-9);
});

test('each member sees the other two answers, not its own, as a follow-up', async () => {
  const { complete, calls } = fakeComplete();
  await runCouncil({ question: 'Q?', members, rounds: 1, judgeModel: 'j', complete });
  const claudeR2 = calls.find((c) => c.model === 'a/claude' && c.messages.length === 4);
  const followUp = claudeR2.messages[3].content;
  assert.match(followUp, /ChatGPT · Save me time/);
  assert.match(followUp, /Gemini · Save me stress/);
  assert.doesNotMatch(followUp, /Claude · Save me money/);
  assert.deepEqual(claudeR2.messages.map((m) => m.role), ['system', 'user', 'assistant', 'user']);
});

test('stops early once everyone reports full agreement', async () => {
  const { complete, calls } = fakeComplete(() => 'full');
  const events = [];
  const res = await runCouncil({ question: 'Q?', members, rounds: 3, earlyStop: true, judgeModel: 'j', complete, onEvent: (e) => events.push(e.type) });
  assert.equal(res.transcript.length, 2);
  assert.equal(calls.length, 3 * 2 + 1);
  assert.ok(events.includes('early-stop'));
});

test('does not stop early when disabled', async () => {
  const { complete } = fakeComplete(() => 'full');
  const res = await runCouncil({ question: 'Q?', members, rounds: 3, earlyStop: false, judgeModel: 'j', complete });
  assert.equal(res.transcript.length, 4);
});

test('a failing member is reported and the others carry on', async () => {
  const { complete: base } = fakeComplete();
  const complete = async (req) => {
    if (req.model === 'b/gpt') throw new Error('HTTP 404');
    return base(req);
  };
  const res = await runCouncil({ question: 'Q?', members, rounds: 1, judgeModel: 'j', complete });
  assert.equal(res.transcript[0][1].text, null);
  assert.match(res.transcript[0][1].error, /404/);
  assert.ok(res.transcript[1][0].text);
});

test('throws if every member fails', async () => {
  const complete = async () => { throw new Error('401'); };
  await assert.rejects(runCouncil({ question: 'Q?', members, rounds: 1, judgeModel: 'j', complete }), /Every council member failed/);
});

test('abort propagates', async () => {
  const ac = new AbortController();
  const complete = async () => { ac.abort(); throw new DOMException('Aborted', 'AbortError'); };
  await assert.rejects(runCouncil({ question: 'Q?', members, rounds: 1, judgeModel: 'j', complete, signal: ac.signal }), { name: 'AbortError' });
});

test('parseStance handles plain and bolded forms', () => {
  assert.deepEqual(parseStance('blah\nSTANCE: Buy it.\nAGREEMENT: partial'), { stance: 'Buy it.', agreement: 'partial' });
  assert.deepEqual(parseStance('**STANCE:** Wait.\n**AGREEMENT:** Full — mostly'), { stance: 'Wait.', agreement: 'full' });
  assert.deepEqual(parseStance('no markers'), { stance: null, agreement: null });
  assert.equal(parseStance('AGREEMENT: n/a').agreement, null);
});

test('parseVerdict accepts bare or fenced JSON and rejects junk', () => {
  assert.equal(parseVerdict(verdictJson).consensus, 'full');
  assert.equal(parseVerdict('Here:\n```json\n' + verdictJson + '\n```').recommendation, 'r');
  assert.equal(parseVerdict('not json'), null);
  assert.equal(parseVerdict('{"consensus":"maybe"}'), null);
});

test('custom persona text is used', () => {
  assert.match(systemPrompt({ persona: 'custom', customPersona: 'Think like a plumber.' }), /Think like a plumber\./);
});

test('markdown renderer escapes HTML', () => {
  const html = renderMarkdown('<script>alert(1)</script>\n**bold** and `x<y`\n- one\n- two');
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /<strong>bold<\/strong>/);
  assert.match(html, /<code>x&lt;y<\/code>/);
  assert.match(html, /<ul><li>one<\/li><li>two<\/li><\/ul>/);
});

const textDoc = { name: 'quote.pdf', kind: 'text', text: '[Page 1]\nFurnace replacement: $6,400' };
const photo = { name: 'label.jpg', kind: 'image', dataUrl: 'data:image/jpeg;base64,AAAA' };
const scan = { name: 'scan.pdf', kind: 'image', page: 2, dataUrl: 'data:image/jpeg;base64,BBBB' };

test('no attachments leaves the question as a plain string', () => {
  assert.equal(openingMessage('Q?', []), 'Q?');
});

test('text evidence is inlined and tagged with its file name', () => {
  const msg = openingMessage('Q?', [textDoc]);
  assert.equal(typeof msg, 'string');
  assert.match(msg, /<evidence name="quote\.pdf">\n\[Page 1\]\nFurnace replacement: \$6,400\n<\/evidence>/);
  assert.match(msg, /one file/);
});

test('images become image parts for vision models', () => {
  const msg = openingMessage('Q?', [textDoc, photo, scan], true);
  assert.ok(Array.isArray(msg));
  assert.match(msg[0].text, /3 files/);
  assert.match(msg[0].text, /Furnace replacement/);
  const imgs = msg.filter((p) => p.type === 'image_url').map((p) => p.image_url.url);
  assert.deepEqual(imgs, [photo.dataUrl, scan.dataUrl]);
  assert.ok(msg.some((p) => p.text === 'Image evidence: scan.pdf, page 2'));
});

test('non-vision models get text plus a note about the images they cannot see', () => {
  const msg = openingMessage('Q?', [textDoc, photo, scan], false);
  assert.equal(typeof msg, 'string');
  assert.match(msg, /Furnace replacement/);
  assert.match(msg, /2 images — label\.jpg, scan\.pdf, page 2 — could not be shown/);
  assert.doesNotMatch(msg, /base64/);
});

test('every member gets the evidence in its opening message; the chair gets only file names', async () => {
  const { complete, calls } = fakeComplete();
  const mixed = [{ ...members[0], vision: true }, { ...members[1], vision: false }, members[2]];
  await runCouncil({ question: 'Q?', members: mixed, attachments: [textDoc, photo], rounds: 1, judgeModel: 'j', complete });
  const opening = (model) => calls.find((c) => c.model === model).messages[1].content;
  assert.ok(Array.isArray(opening('a/claude')));
  assert.equal(typeof opening('b/gpt'), 'string');
  assert.ok(Array.isArray(opening('c/gemini')), 'unknown vision defaults to sending images');
  // Round 2 history still carries the evidence.
  const r2 = calls.find((c) => c.model === 'b/gpt' && c.messages.length === 4);
  assert.match(r2.messages[1].content, /Furnace replacement/);
  const judge = calls.at(-1).messages[1].content;
  assert.match(judge, /Evidence attached: quote\.pdf, label\.jpg/);
  assert.doesNotMatch(judge, /Furnace replacement/);
});

test('transcript lists each attached file once', () => {
  const md = transcriptMarkdown('Q?', [], null, [scan, { ...scan, page: 3 }, textDoc]);
  assert.match(md, /_Evidence attached: scan\.pdf, quote\.pdf_/);
});

// ---------- clarifying questions ----------

// Round-1 replies carry a QUESTION line for the members named in `asks`; everything else is as fakeComplete.
function askingComplete(asks = {}, merged = null) {
  const calls = [];
  const complete = async ({ model, messages, session }) => {
    calls.push({ model, session, messages: structuredClone(messages) });
    if (messages[0].content.startsWith('You are the chair')) return { text: verdictJson, cost: 0 };
    if (messages[0].content.startsWith('You are the council secretary')) {
      if (merged instanceof Error) throw merged;
      return { text: JSON.stringify({ question: merged }), cost: 0.0001 };
    }
    const round = messages.filter((m) => m.role === 'user').length;
    const q = round === 1 ? `QUESTION: ${asks[model] ?? 'none'}\n` : '';
    return { text: `answer r${round}\n${q}STANCE: do X (${model})\nAGREEMENT: ${round === 1 ? 'n/a' : 'partial'}`, cost: 0 };
  };
  return { complete, calls };
}

test('parseQuestion reads the QUESTION line and ignores none', () => {
  assert.equal(parseQuestion('x\nQUESTION: Which model number do you have?\nSTANCE: y'), 'Which model number do you have?');
  assert.equal(parseQuestion('**QUESTION:** What is your budget?**'), 'What is your budget?');
  for (const none of ['QUESTION: none', 'QUESTION: None.', 'QUESTION: n/a', 'question: No questions', 'no marker here'])
    assert.equal(parseQuestion(none), null, none);
});

test('the clarify instruction is only added to round 1 when the user can be asked', async () => {
  assert.equal(openingMessage('Q?', [], true, true), 'Q?' + CLARIFY_INSTRUCTION);
  assert.match(openingMessage('Q?', [textDoc], true, true), /QUESTION: <your question>/);
  const off = askingComplete();
  await runCouncil({ question: 'Q?', members, rounds: 1, judgeModel: 'j', complete: off.complete });
  assert.equal(off.calls[0].messages[1].content, 'Q?');
  const on = askingComplete();
  await runCouncil({ question: 'Q?', members, rounds: 1, judgeModel: 'j', complete: on.complete, askUser: async () => null });
  assert.match(on.calls[0].messages[1].content, /clarifying question/);
  const r2 = on.calls.find((c) => c.messages.length === 4);
  assert.doesNotMatch(r2.messages[3].content, /clarifying question/);
});

test('pauses after round 1 with only the real questions, then shares Q&A with every member', async () => {
  const { complete, calls } = askingComplete({ 'a/claude': 'Which model number?', 'c/gemini': 'What is your budget?' });
  let asked;
  const events = [];
  const res = await runCouncil({
    question: 'Q?', members, rounds: 2, judgeModel: 'j', complete, mergeQuestions: false,
    askUser: async (qs) => { asked = qs; return ['A3065', '']; },
    onEvent: (e) => events.push(e.type),
  });
  assert.deepEqual(asked.map((q) => q.question), ['Which model number?', 'What is your budget?']);
  assert.deepEqual(asked.map((q) => q.from), ['Claude · Save me money', 'Gemini · Save me stress']);
  for (const model of ['a/claude', 'b/gpt', 'c/gemini']) {
    const r2 = calls.find((c) => c.model === model && c.messages.length === 4).messages[3].content;
    assert.match(r2, /Question \(asked by Claude · Save me money\): Which model number\?\n {2}Answer: A3065/);
    assert.match(r2, /asked by Gemini · Save me stress\): What is your budget\?\n {2}Answer: \(not answered/);
    const r3 = calls.find((c) => c.model === model && c.messages.length === 6).messages[5].content;
    assert.doesNotMatch(r3, /asked by/, 'Q&A is shared once, with round 2');
  }
  assert.ok(events.indexOf('clarify-start') < events.indexOf('clarify-done'));
  assert.equal(res.clarifications.items[0].answer, 'A3065');
  assert.equal(res.clarifications.skipped, false);
  assert.match(calls.at(-1).messages[1].content, /## Clarifications from the user[\s\S]*\*\*Answer:\*\* A3065/, 'the chair sees them too');
});

test('skipping or answering nothing tells the members to proceed on assumptions', async () => {
  for (const reply of [null, ['', '  ']]) {
    const { complete, calls } = askingComplete({ 'a/claude': 'Which model?' });
    const res = await runCouncil({ question: 'Q?', members, rounds: 1, judgeModel: 'j', complete, askUser: async () => reply });
    const r2 = calls.find((c) => c.model === 'b/gpt' && c.messages.length === 4).messages[3].content;
    assert.match(r2, /chose not to answer\. Proceed on your best assumptions/);
    assert.equal(res.clarifications.skipped, true);
  }
});

test('no pause when nobody asks, when disabled, or when there is no debate round', async () => {
  let called = 0;
  const askUser = async () => { called++; return []; };
  const quiet = askingComplete();
  const a = await runCouncil({ question: 'Q?', members, rounds: 1, judgeModel: 'j', complete: quiet.complete, askUser });
  assert.equal(called, 0);
  assert.equal(a.clarifications, null);
  assert.equal(quiet.calls.length, 3 * 2 + 1);
  const asking = askingComplete({ 'a/claude': 'Q?' });
  await runCouncil({ question: 'Q?', members, rounds: 1, judgeModel: 'j', complete: asking.complete });
  const zero = askingComplete({ 'a/claude': 'Q?' });
  await runCouncil({ question: 'Q?', members, rounds: 0, judgeModel: 'j', complete: zero.complete, askUser });
  assert.equal(called, 0);
});

test('stopping while waiting for the user aborts the run', async () => {
  const { complete } = askingComplete({ 'a/claude': 'Which model?' });
  const askUser = async () => { throw new DOMException('Aborted', 'AbortError'); };
  await assert.rejects(runCouncil({ question: 'Q?', members, rounds: 1, judgeModel: 'j', complete, askUser }), { name: 'AbortError' });
});

test('a member whose call failed cannot ask a question', async () => {
  const { complete: base } = askingComplete({ 'b/gpt': 'ignored' });
  const complete = async (req) => (req.model === 'b/gpt' ? Promise.reject(new Error('boom')) : base(req));
  let asked;
  await runCouncil({ question: 'Q?', members, rounds: 1, judgeModel: 'j', complete, askUser: async (q) => { asked = q; return null; } });
  assert.equal(asked, undefined);
});

test('clarificationsBlock formats answered, unanswered and skipped', () => {
  assert.equal(clarificationsBlock(null), '');
  assert.equal(clarificationsBlock({ skipped: false, items: [] }), '');
  const b = clarificationsBlock({ skipped: false, items: [{ from: 'X', question: 'Q1?', answer: 'yes' }] });
  assert.match(b, /override assumptions[\s\S]*Question \(asked by X\): Q1\?\n {2}Answer: yes/);
});

// ---------- follow-up summary ----------

const finished = {
  question: 'Is it the furnace?',
  clarifications: { skipped: false, items: [{ from: 'Claude', question: 'Model?', answer: 'A3065' }] },
  transcript: [
    [{ label: 'Claude', text: 'LONG OPENING ANSWER one', stance: 'Replace' }, { label: 'GPT', text: 'LONG OPENING ANSWER two', stance: 'Wait' }],
    [{ label: 'Claude', text: 'LONG LATER ANSWER', stance: 'Replace this fall' }, { label: 'GPT', text: null, error: 'boom' }],
  ],
  verdict: { parsed: { consensus: 'partial', summary: 'Close.', recommendation: 'Replace soon', agreements: ['Age matters'], disagreements: ['Timing'] } },
  attachments: [{ name: 'quote.pdf', kind: 'text' }, { name: 'quote.pdf', kind: 'image', page: 2 }, { name: 'previous-session.md', kind: 'text' }],
};

test('session summary keeps stances, verdict and Q&A but not the full answers', () => {
  const s = sessionSummary(finished);
  assert.match(s, /^# Previous council session\n\n\*\*Question:\*\* Is it the furnace\?/);
  assert.match(s, /Claude asked: Model\?\n {2}Answer: A3065/);
  assert.match(s, /\*\*Evidence used:\*\* quote\.pdf\n/);
  assert.doesNotMatch(s, /previous-session/);
  assert.match(s, /- Claude: Replace this fall/);
  assert.match(s, /- GPT: Wait/, 'falls back to the last round in which the member answered');
  assert.match(s, /partial consensus\. Close\./);
  assert.match(s, /Recommendation:\*\* Replace soon/);
  assert.match(s, /Still contested:\*\*\n- Timing/);
  assert.doesNotMatch(s, /LONG/);
  assert.ok(s.length < 1200);
});

test('a follow-up summary nests the earlier one', () => {
  const first = sessionSummary(finished);
  const second = sessionSummary({ ...finished, question: 'Timing?', clarifications: null, previous: first });
  assert.match(second, /^# Previous council session\n\n\*\*Question:\*\* Timing\?/);
  assert.match(second, /## Before that\n\n\*\*Question:\*\* Is it the furnace\?/);
  assert.equal(second.match(/# Previous council session/g).length, 1);
});

test('summary falls back to unstructured verdict text', () => {
  const s = sessionSummary({ ...finished, verdict: { text: 'The chair rambled', parsed: null } });
  assert.match(s, /Chair's verdict \(unstructured\):\*\* The chair rambled/);
});

test('transcript lists clarifications after round 1', () => {
  const md = transcriptMarkdown('Q?', finished.transcript, null, [], finished.clarifications);
  assert.match(md, /## Round 1[\s\S]*## Clarifications from the user[\s\S]*\*\*Claude asked:\*\* Model\?[\s\S]*## Round 2/);
  assert.match(transcriptMarkdown('Q?', finished.transcript, null, [], { skipped: true, items: finished.clarifications.items }), /chose not to answer/);
});

// ---------- one combined clarifying question ----------

test('two or more questions are merged by the chair into one, answered once', async () => {
  const { complete, calls } = askingComplete(
    { 'a/claude': 'Which model number?', 'c/gemini': 'What is your budget?' },
    'What is the furnace model number, and what is your budget?',
  );
  let asked;
  const res = await runCouncil({
    question: 'Q?', members, rounds: 1, judgeModel: 'j', complete,
    askUser: async (qs) => { asked = qs; return ['A3065, about $5k']; },
  });
  assert.equal(asked.length, 1);
  assert.equal(asked[0].question, 'What is the furnace model number, and what is your budget?');
  const merge = calls.find((c) => c.messages[0].content.startsWith('You are the council secretary'));
  assert.equal(merge.model, 'j', 'the chair model does the merge');
  assert.match(merge.messages[1].content, /Claude · Save me money: Which model number\?[\s\S]*Gemini · Save me stress: What is your budget\?/);
  assert.equal(res.clarifications.merged, true);
  assert.equal(res.clarifications.asked.length, 2);
  const r2 = calls.find((c) => c.model === 'b/gpt' && c.messages.length === 4).messages[3].content;
  assert.match(r2, /combined into one[\s\S]*from Claude · Save me money, Gemini · Save me stress\): What is the furnace model number[\s\S]*Answer: A3065, about \$5k/);
  assert.match(sessionSummary({ question: 'Q?', ...res }), /The council asked: What is the furnace/);
  assert.match(transcriptMarkdown('Q?', res.transcript, null, [], res.clarifications), /combined into one question/);
});

test('a single question is not merged, and a failed merge falls back to separate questions', async () => {
  const one = askingComplete({ 'a/claude': 'Which model?' }, 'unused');
  let asked;
  await runCouncil({ question: 'Q?', members, rounds: 1, judgeModel: 'j', complete: one.complete, askUser: async (q) => { asked = q; return null; } });
  assert.equal(asked[0].from, 'Claude · Save me money');
  assert.ok(!one.calls.some((c) => c.messages[0].content.startsWith('You are the council secretary')));

  const broken = askingComplete({ 'a/claude': 'Which model?', 'b/gpt': 'Budget?' }, new Error('chair down'));
  const res = await runCouncil({ question: 'Q?', members, rounds: 1, judgeModel: 'j', complete: broken.complete, askUser: async (q) => { asked = q; return ['x', 'y']; } });
  assert.equal(asked.length, 2);
  assert.equal(res.clarifications.merged, false);
});

test('parseMerged reads bare or fenced JSON', () => {
  assert.equal(parseMerged('{"question":"  A and B?  "}'), 'A and B?');
  assert.equal(parseMerged('```json\n{"question":"X?"}\n```'), 'X?');
  assert.equal(parseMerged('nope'), null);
  assert.equal(parseMerged('{"question":""}'), null);
});

// ---------- prompt caching ----------

test('each member keeps one sticky session across rounds; the chair has its own', async () => {
  const calls = [];
  const complete = async (req) => {
    calls.push(req);
    if (req.messages[0].content.startsWith('You are the chair')) return { text: verdictJson, cost: 0.01, saved: 0 };
    return { text: 'x\nSTANCE: s\nAGREEMENT: partial', cost: 0.002, saved: 0.0005 };
  };
  const res = await runCouncil({ question: 'Q?', members, rounds: 2, judgeModel: 'j', complete, sessionId: 'abc', effort: 'low' });
  const sessionsFor = (model) => new Set(calls.filter((c) => c.model === model).map((c) => c.session));
  assert.deepEqual([...sessionsFor('a/claude')], ['abc-m0']);
  assert.deepEqual([...sessionsFor('c/gemini')], ['abc-m2']);
  assert.equal(calls.at(-1).session, 'abc-chair');
  assert.ok(calls.filter((c) => c.model !== 'j').every((c) => c.effort === 'low'));
  assert.equal(calls.at(-1).effort, undefined, 'the chair runs at its default effort');
  assert.ok(Math.abs(res.saved - 9 * 0.0005) < 1e-12);
});

test('member histories only grow, so each round re-sends the previous round as a cacheable prefix', async () => {
  const { complete, calls } = fakeComplete();
  await runCouncil({ question: 'Q?', members, rounds: 2, judgeModel: 'j', complete });
  const claude = calls.filter((c) => c.model === 'a/claude').map((c) => c.messages);
  for (let r = 1; r < claude.length; r++) assert.deepEqual(claude[r].slice(0, claude[r - 1].length), claude[r - 1]);
});

test('requests opt Claude into caching and pin a session; others cache automatically', () => {
  const claude = requestBody({ model: '~anthropic/claude-sonnet-latest', messages: [], session: 's-m0', effort: 'low' });
  assert.deepEqual(claude.cache_control, { type: 'ephemeral' });
  assert.equal(claude.session_id, 's-m0');
  assert.deepEqual(claude.reasoning, { effort: 'low' });
  const gpt = requestBody({ model: 'openai/gpt-6.1-sol', messages: [] });
  assert.equal(gpt.cache_control, undefined);
  assert.equal(gpt.session_id, undefined);
  assert.equal(gpt.reasoning, undefined);
  assert.ok(needsCacheOptIn('anthropic/claude-haiku-5.5'));
  assert.ok(!needsCacheOptIn('google/gemini-2.5-pro'));
});

test('cache savings use the reported discount, else token counts and prices', () => {
  assert.equal(cacheSavings({}, 0.0123, null), 0.0123);
  const p = { prompt: 2, cacheRead: 0.2, cacheWrite: 2.5 };
  // 10k tokens read at $0.20 instead of $2.00 saves $0.018; 2k written at $2.50 instead of $2.00 costs $0.001.
  const s = cacheSavings({ prompt_tokens_details: { cached_tokens: 10000, cache_write_tokens: 2000 } }, undefined, p);
  assert.ok(Math.abs(s - 0.017) < 1e-12);
  assert.equal(cacheSavings(undefined, undefined, p), 0);
  assert.equal(cacheSavings({ prompt_tokens_details: { cached_tokens: 5 } }, undefined, undefined), 0);
});

test('speech: markdown becomes plain sentences and long text is chunked', async () => {
  const { speakable, chunks } = await import('../src/speech.js');
  assert.equal(speakable('## Plan\n\n**Buy** the [car](http://x.com).\n- cheap\n\nClaude · Steve Jobs'), 'Plan. Buy the car. cheap. Claude, Steve Jobs');
  const parts = chunks('word '.repeat(200) + '. Short.', 100);
  assert.ok(parts.every((p) => p.length <= 100));
  assert.equal(parts.join(' ').split(/\s+/).filter((w) => w === 'word' || w === 'word.').length, 200);
});

test('speech: natural voices rank above robot and novelty voices', async () => {
  const { rankVoices } = await import('../src/speech.js');
  const v = (name, extra = {}) => ({ name, lang: 'en-US', localService: true, ...extra });
  const ranked = rankVoices([v('Fred'), v('Bubbles'), v('Alex'), v('Samantha'), v('Ava (Premium)'), v('Daniel (Enhanced)', { lang: 'en-GB' })], 'en-US');
  assert.deepEqual(ranked.map((x) => x.v.name), ['Ava (Premium)', 'Daniel (Enhanced)', 'Samantha', 'Alex']);
});
