# My Council

Ask one question. Three AIs answer it on their own, then read each other's answers and respond over several rounds. A chair model then reports whether they reached consensus, with a recommendation if they did.

Everything runs in your browser through [OpenRouter](https://openrouter.ai), so one API key covers Claude, ChatGPT, Gemini, Grok, DeepSeek and the rest. There is no server and no build step.

## How a session runs

1. **Opening round.** Each member answers independently, at the same time.
2. **Debate rounds** (3 by default, 0–5 allowed). Each member gets the other two members' latest answers as a follow-up in its own conversation, then responds. Every reply ends with a `STANCE:` line and an `AGREEMENT: full | partial | none` line.
3. **Early stop** (on by default). If all three report `full` agreement before the last round, the remaining rounds are skipped to save money.
4. **Verdict.** A chair model reads the whole transcript and returns: consensus (full / partial / none), a summary, the recommendation (only if there is consensus), the points they agreed on, the points still contested, and each member's final position.

With 3 debate rounds that comes to up to 13 model calls per question. The settings panel shows a rough cost estimate, and the app shows the actual spend reported by OpenRouter.

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

- `src/council.js`: the debate engine (rounds, follow-up prompts, stance parsing, early stop, verdict). It has no DOM and makes no network calls itself.
- `src/openrouter.js`: streaming chat completions and the model list.
- `src/app.js`, `index.html`, `src/styles.css`: the UI.
- `src/markdown.js`: a small Markdown renderer that escapes all HTML first.
- `test/`: `node --test` suite using a fake model.
