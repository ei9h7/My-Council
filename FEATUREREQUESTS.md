# Feature requests

Ideas for the engine and product, for triage. Rough cost/impact notes are estimates, not measurements. Tick, cut, or reorder as you like.

Legend: 💰 saves money · 🎯 better answers · ⚡ faster · 🧭 product

## Already shipped in this round (for reference)

- **Prompt caching, on by default.** Every member keeps one growing conversation, so each round re-sends a prefix the provider already has. Claude gets the opt-in (`cache_control`), OpenAI/Gemini/Grok/DeepSeek cache automatically, and every member's calls share a `session_id` so OpenRouter keeps them on the provider that holds the cache. The curated model list only contains models with caching. The app shows what caching saved.
- **One combined clarifying question.** When two or more members ask, the chair merges them into one question and you answer once.
- **Cheaper chair.** Claude Haiku 5.5, no extended thinking, by default (about 1/20th the price of Sonnet 5.5).
- **Thinking depth setting** (Advanced): low / medium / high reasoning effort for the members.

## Cost

1. 💰 **Default members to "medium" or "low" thinking.** Reasoning models bill their thinking as output, which is not cacheable and is usually the largest part of a run's cost. Sonnet "latest" defaults to *high*. Suggest an A/B on 10 real questions at low vs default; if verdicts don't change, make *low* or *medium* the default. Likely the single biggest saving left (30–60% of member cost).
2. 💰 **Cap output with `max_tokens`.** The protocol asks for ≤300 words but nothing enforces it. A cap around 900 visible tokens stops runaway answers. Needs care: on some providers the cap includes thinking tokens.
3. 💰🎯 **Send a digest instead of full answers between rounds.** Today each member reads the other two members' full answers every round. Instead, send each member only the others' STANCE plus "new arguments since last round" (members could write a `NEW:` bullet list). History then grows by ~300 tokens per round instead of ~1,600. Trade-off: less nuance.
4. 💰 **Stop on stable stances, not just full agreement.** If no member's STANCE changed between two rounds, another round rarely helps. Stop early on "stable partial" too (setting).
5. 💰 **Pre-digest large attachments once.** A cheap model (Haiku / Flash) reads a big PDF once and writes a structured digest with page refs; members get the digest and can quote pages from it. Saves re-reading 20k tokens × 3 members. Caching already softens this, so measure first.
6. 💰 **1-hour cache when a clarifying question is pending.** Claude's default cache lasts 5 minutes; if you take longer to answer, round 2 re-writes the cache. Switching to `ttl: "1h"` only for the round-1 opening (2× write price) would cover slow answers. Low priority.
7. 💰 **Adaptive council size.** A cheap triage call classifies the question (simple factual / opinion / high-stakes). Simple → 1 round with fast models; high-stakes → flagship models and 3 rounds. Show the choice and let the user override.

## Better answers (agent ideas)

8. 🎯 **Anonymous peer review.** Label the others "Member A/B" instead of "ChatGPT · Save me time" so models don't defer to (or dismiss) a brand. Research on LLM debate suggests less sycophancy when identities are hidden. Free.
9. 🎯 **Shared research agent.** One web-search call (OpenRouter `:online` / web plugin) before round 1 gathers current facts and prices, and every member gets the same findings. Cheaper and more consistent than giving each member search.
10. 🎯 **Fact-checker between rounds.** A cheap model scans the round for factual claims that conflict between members and asks the specific member to verify or retract. Targets the "two members confidently disagree on a number" failure.
11. 🎯 **Blind final vote.** After the last round, each member privately picks from the chair's candidate recommendations (one short call each, tiny output). Gives a real tally rather than the chair's reading of AGREEMENT lines.
12. 🎯 **Devil's advocate seat on demand.** If round 2 is already unanimous, swap one member's persona to Devil's advocate for the final round to stress-test the consensus before you act on it.
13. 🎯 **Confidence + "what would change my mind".** Add a `CONFIDENCE: 1–5` line and a "what new info would change this" line. The chair surfaces it, and it feeds better follow-up questions.

## Product

14. 🧭 **Saved history.** Keep past councils (localStorage now; Firestore in the hosted build) with search and re-open-to-follow-up.
15. 🧭 **Share link.** Read-only page of a finished council (hosted build only).
16. 🧭 **Per-run cost cap.** "Stop if this run passes $0.50" in Settings; abort before the next round.
17. 🧭 **Paid tier on the hosted build.** The proxy already logs per-user cost; add Stripe credit packs, charge cost × margin, and enforce balance in the proxy. See README "Hosted mode".
18. 🧭 **Model "freshness" check.** "· latest" aliases move silently. Show which concrete model answered (OpenRouter returns it in the response) on each card.
19. 🧭 **PWA / install to home screen**, so it feels like an app on phones.
