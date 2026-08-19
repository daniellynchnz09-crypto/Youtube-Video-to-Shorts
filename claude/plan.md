# Build plan

Part of the [YouTube Short Splitter](../Claude.md) doc set.

## Status

**Build-order step 1 (core pipeline, no UI) is scaffolded and working end-to-end** — `npm run smoke` runs a real video through download → transcribe → analyze → targeted download → title → render → DB write and produces a playable 1080x1920 clip. Since scaffolding, most of the work has been iterative quality fixes driven by reviewing actual rendered clips (segment boundary accuracy, subtitle timing, title accuracy, audio quality) — see [bugs.md](bugs.md) for the specifics and [journal.md](journal.md) for the chronological log.

Step 2 (multi-clip generation + review UI) has not started.

## Suggested build order

1. Core pipeline end-to-end for one video → one clip, no UI (prove download → transcribe → analyze → render works). **Done, iterating on quality.**
2. Multi-clip generation + minimal review UI (list, play, select/reject, export).
3. Full rendering spec fidelity (title reflow, karaoke highlight, emoji pop-ins) + subtitle/title editing.
4. Custom dictionary feature.
5. Project home page + persistence/cache-cleanup lifecycle.
6. *(Backlog)* Web app expansion.
7. *(Backlog)* YouTube scheduled publishing via n8n.
8. *(Backlog)* TikTok scheduled publishing (pending API review).

See [backlog.md](backlog.md) for the deferred ideas referenced above, plus others not yet slotted into a step.
