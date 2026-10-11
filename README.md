# My Council

Ask one question. Three AIs answer it on their own, then read each other's answers and respond over several rounds. A chair model then reports whether they reached consensus, with a recommendation if they did.

Everything runs in your browser through [OpenRouter](https://openrouter.ai), so one API key covers Claude, ChatGPT, Gemini, Grok, DeepSeek and the rest. There is no server and no build step.

## How a session runs

1. **Opening round.** Each member answers independently, at the same time.
2. **Clarifying questions** (on by default). Each member may ask you one question, but only if your answer would change its recommendation and the question and attachments don't already settle it. If anyone asks, the run pauses and shows the questions. Answer what you can (blank is fine) or skip. Every member then sees all the questions and answers together with the others' opening answers. If nobody asks, there is no pause. Turn this off in Settings.
3. **Debate rounds** (3 by default, 0–5 allowed). Each member gets the other two members' latest answers as a follow-up in its own conversation, then responds. Every reply ends with a `STANCE:` line and an `AGREEMENT: full | partial | none` line.
4. **Early stop** (on by default). If all three report `full` agreement before the last round, the remaining rounds are skipped to save money.
5. **Verdict.** A chair model reads the whole transcript (including your answers) and returns: consensus (full / partial / none), a summary, the recommendation (only if there is consensus), the points they agreed on, the points still contested, and each member's final position.

With 3 debate rounds that comes to up to 13 model calls per question. The settings panel shows a rough cost estimate, and the app shows the actual spend reported by OpenRouter.

## Following up

After any verdict, a **Follow up** panel appears (highlighted when consensus was partial or none). Add a note, such as what the members got wrong, what you've since found out, or which contested point to focus on, and optionally attach files, then convene again.

To keep it cheap, the members don't get the full transcript. A short summary of the previous session (about 1–2k tokens) is attached as `previous-session.md`: the question, your clarifications, each member's final stance, the chair's verdict, the points agreed and still contested, and the names of the evidence files. You can read it under "Session summary that will be sent". Files you attached earlier aren't carried over; **Re-attach earlier files** brings them back, and each one can be removed. Follow-ups appear below the earlier sessions, can be chained, and the transcript download covers all of them.

## Attaching evidence

You can attach files that every member should consider: quotes, reports, photos, spreadsheets exported as CSV, and so on. Use **Attach evidence** or drag files onto the question box. Attachments are optional.

| File | What the members get |
|---|---|
| PDF with text | The text, marked `[Page N]` so members can cite pages |
| Scanned PDF (no text layer) | The first 10 pages as images |
| Word (.docx) | The text |
| Images | The image, scaled to at most 1600 px |
| .txt .md .csv .json .html .xml .yaml .log .eml | The text as-is |

- Files are read in your browser. The PDF and Word readers (pdf.js and mammoth) load from cdnjs only when you attach one of those files. Nothing goes anywhere except into the prompts sent to OpenRouter.
- The evidence goes into each member's opening message, and members are told to cite it by file name and page. The chair sees only the file names and judges the debate, not the documents.
- **Images and models that can't see them:** a member whose model doesn't accept images is told the images exist but doesn't see them. The app warns you about this before you start.
- **Cost:** the evidence is part of the conversation, so it is re-sent every round. A 30-page PDF is roughly 15–20k tokens × 3 members × 4 rounds. The estimate in Settings includes it. Each file is cut off at about 120k characters.

## Members: model × persona

Each of the three seats has two separate settings:

- **Model:** any OpenRouter model ID. The dropdown loads OpenRouter's live model list with prices.
- **Persona:** Balanced, Save me money, Save me time, Save me stress, Devil's advocate, or Custom (write your own priorities).

Presets:

| Preset | Seats |
|---|---|
| Claude / ChatGPT / Gemini | three different models, all Balanced |
| Money / Time / Stress | one model playing three personas |
| Both mixed (default) | Claude = money, ChatGPT = time, Gemini = stress |
| Budget | the mixed setup on cheap, fast models (Haiku / GPT Luna / Gemini Flash) |

You can't tell whether a disagreement comes from the model or from the persona when both change at once. To compare models, use the first preset. To compare priorities, use the second.

## Run it

**Hosted (recommended):** in the repo's Settings → Pages, set Source to **GitHub Actions**. Each push to `main` runs the tests and publishes the app at `https://<user>.github.io/My-Council/`. It works on a phone.

**Locally:**

```sh
npm start        # serves on http://localhost:8080
npm test         # engine + markdown tests, no network
```

Opening `index.html` straight from disk won't work, because ES modules need to be served over http.

## Your API key

Paste an OpenRouter key into Settings. It is saved in this browser's localStorage and is sent only to `openrouter.ai`. Anyone with access to the browser profile can read it, so on a shared machine set a credit limit on the key at [openrouter.ai/keys](https://openrouter.ai/keys).

## Files

- `src/council.js`: the debate engine (rounds, clarifying questions, follow-up prompts, stance parsing, early stop, verdict, session summaries). It has no DOM and makes no network calls itself.
- `src/openrouter.js`: streaming chat completions and the model list.
- `src/app.js`, `index.html`, `src/styles.css`: the UI.
- `src/markdown.js`: a small Markdown renderer that escapes all HTML first.
- `src/attachments.js`: reads attached files into evidence (PDF, Word, images, text).
- `test/`: `node --test` suite using a fake model.
