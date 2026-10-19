# My Council

Ask one question. Three AIs answer it on their own, then read each other's answers and respond over several rounds. A chair model then reports whether they reached consensus, with a recommendation if they did.

Everything runs in your browser through [OpenRouter](https://openrouter.ai), so one API key covers Claude, ChatGPT, Gemini, Grok, DeepSeek and the rest. There is no server and no build step. Light and dark themes; works on a phone.

## How a session runs

1. **Opening round.** Each member answers independently, at the same time.
2. **Clarifying question** (on by default). Each member may ask you one question, but only if your answer would change its recommendation and the question and attachments don't already settle it. When two or more ask, the chair combines them into **one** question so you answer once (turn off in Settings to see them separately). Answer (blank is fine) or skip. Every member then sees the question and your answer together with the others' opening answers. If nobody asks, there is no pause.
3. **Debate rounds** (3 by default, 0–5 allowed). Each member gets the other two members' latest answers as a follow-up in its own conversation, then responds. Every reply ends with a `STANCE:` line and an `AGREEMENT: full | partial | none` line.
4. **Early stop** (on by default). If all three report `full` agreement before the last round, the remaining rounds are skipped to save money.
5. **Verdict.** A chair model reads the whole transcript (including your answers) and returns: consensus (full / partial / none), a summary, the recommendation (only if there is consensus), the points they agreed on, the points still contested, and each member's final position.

With 3 debate rounds that comes to up to 13 model calls per question (plus one tiny call when questions are merged). The question box shows a rough cost estimate, and the app shows the actual spend and what caching saved, as reported by OpenRouter.

## Cost: prompt caching and the chair

**Prompt caching is automatic.** Each member keeps one conversation that only grows, so every round re-sends the previous rounds unchanged. The provider caches that prefix and bills it at a fraction of the normal input price (Claude 0.1×, OpenAI/Grok/Gemini 0.25×, DeepSeek 0.1×).

- Claude needs an opt-in, which the app sends (`cache_control`). OpenAI, Gemini, Grok and DeepSeek cache on their own.
- All of one member's calls share a `session_id`, so OpenRouter routes them to the provider that holds the cache.
- Every model in the built-in list supports caching. "Allow any OpenRouter model" in Settings → Advanced opens up the full list; "Only suggest models with prompt caching" keeps that list to models that cache.
- What to expect: caching cuts the *input* side, which grows each round. It doesn't touch output, and reasoning models' thinking is billed as output, so a typical run saves roughly 10–30% overall, more with large attachments. Lowering **Member thinking depth** (Settings → Advanced) is the other big lever.
- Caches expire after about 5 minutes idle (Claude) or a few minutes (Gemini), so a long pause on a clarifying question can cost one cache re-write.

**The chair** reads the finished debate once and writes a structured verdict (and merges questions). That's summarising, not hard reasoning, so it defaults to **Claude Haiku 5.5** without extended thinking, about 1/20th the price of Sonnet 5.5. Change it in Settings → Chair. Since the chair makes one call per session, caching barely matters for it; the members are where caching pays off.

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

## Your council

The landing page is just the question box. The chip under it shows who's on the council; click it (or the gear icon) to change the council in Settings. Pick a style, then a model per seat from a short list:

| Style | Seats |
|---|---|
| Different AIs (default) | three different models, all Balanced |
| Personalities | **one** model for all three seats, each channelling a famous figure: Einstein, Tesla, Trump, Lincoln, Jobs, Ford, Franklin, Buffett, Curie, Churchill, Marcus Aurelius |
| Perspectives | **one** model for all three seats, each with a priority: Save me money / time / stress, Devil's advocate, Balanced, or Custom |

Personalities advise the way that person would (their known thinking and approach) without claiming to be them or inventing quotes. Add more in `PERSONAS` in `src/council.js`.

Personalities and Perspectives use one model on purpose: if the model changes too, you can't tell whether a disagreement comes from the model or the persona.

The model lists (`src/catalog.js`) offer each family's "· latest" alias (OpenRouter keeps it pointed at the newest Sonnet, GPT Sol, Gemini Pro, …) plus a couple of fixed earlier versions, and a fast & cheap option. `$`–`$$$$` shows relative price.

## Run it

**Hosted (recommended):** in the repo's Settings → Pages, set Source to **GitHub Actions**. Each push to `main` runs the tests and publishes the app at `https://<user>.github.io/My-Council/`. It works on a phone.

**Locally:**

```sh
npm start        # serves on http://localhost:8080
npm test         # engine + markdown tests, no network
```

Opening `index.html` straight from disk won't work, because ES modules need to be served over http.

## Your API key

Open Settings (gear icon) → OpenRouter connection and paste a key; **Check** shows the credit left on it. The key is saved in this browser's localStorage and is sent only to `openrouter.ai`. Anyone with access to the browser profile can read it, so on a shared machine set a credit limit on the key at [openrouter.ai/keys](https://openrouter.ai/keys).

### Inviting testers on your account (no server needed)

Give each tester their own OpenRouter key with a spending cap, and send it as an invite link:

1. At [openrouter.ai/keys](https://openrouter.ai/keys), create a key per tester (name it after them) and set a **credit limit**, e.g. $5.
2. Send them `https://<user>.github.io/My-Council/#key=<their key>`.

Opening the link saves the key in their browser and connects them; the key is removed from the address bar, and the part after `#` is never sent to the web server. You see each tester's spend per key on OpenRouter and can delete a key to cut someone off. The tester can see their own key, so treat the link like a gift card worth its credit limit. For a login-based setup where testers never see a key, see the hosted branch.

## Listening to the debate

Press **Listen** (next to the cost line once a debate starts) to hear the short version read aloud: each member's one-line stance per round, then the chair's verdict (recommendation and summary). Each member gets its own voice from the natural-sounding ones on the device (your system voice, Premium/Enhanced ones), with a different pitch for any that have to share; never the old robot voices. It skips any voice that's listed but not downloaded. Press it mid-debate and it starts from the beginning and keeps up as new rounds arrive; press **Stop listening** to stop. It uses the browser's built-in speech, so it's free and needs no extra key. To choose the voice yourself, use **Settings → Appearance → Read-aloud voice** (with a **Test** button). Siri voices can't be used by websites. On iPhone, the silent switch mutes it; for a better voice, download one under Settings → Accessibility → Spoken Content → Voices.

Settings also holds the council (style, models, personalities, perspectives), the debate rounds (default 3), early stop, clarifying questions, the chair model, theme, and Advanced options.

## Files

- `src/council.js`: the debate engine (rounds, clarifying questions, follow-up prompts, stance parsing, early stop, verdict, session summaries). It has no DOM and makes no network calls itself.
- `src/openrouter.js`: streaming chat completions (caching opt-in, sticky sessions, savings), key check, the model list.
- `src/catalog.js`: the curated models, chair options and council styles.
- `src/app.js`, `index.html`, `src/styles.css`: the UI.
- `src/markdown.js`: a small Markdown renderer that escapes all HTML first.
- `src/attachments.js`: reads attached files into evidence (PDF, Word, images, text).
- `test/`: `node --test` suite using a fake model.
- `FEATUREREQUESTS.md`: ideas for triage.
