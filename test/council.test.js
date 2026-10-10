import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runCouncil, parseStance, parseVerdict, systemPrompt } from '../src/council.js';
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
