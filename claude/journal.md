# Command journal

Part of the [YouTube Short Splitter](../Claude.md) doc set. Chronological log of significant work — see [bugs.md](bugs.md) for the same fixes grouped by issue instead.

## 2026-08-19

- Scaffolded the Electron + TypeScript + React project by hand (electron-vite config, `app/main`/`app/preload`/`app/renderer`/`shared` layout, TS7-compatible `tsconfig.json`). (`abbed98`)
- Wrote the build-order-step-1 pipeline: yt-dlp download (audio pass + targeted segment pass), Groq Whisper transcription, Groq LLM segment analysis, Groq LLM title generation, Remotion render, SQLite persistence, and a standalone `npm run smoke` script to run it all without Electron or a UI.
- Debugged the pipeline to a fully working end-to-end state against a real test video: fixed yt-dlp PO-token 403s (updated the vendored binary to nightly), a 413 from Groq's 25MB Whisper upload cap (downsampled the audio-only pass), a stale Groq model name, a free-tier TPM limit (redesigned the analyzer's prompt to use sparse word-index markers instead of per-word timestamps), and Remotion's local-file-loading restrictions (switched to `OffthreadVideo` served over a throwaway local HTTP server). (`e4068a1`)
- First three rounds of user feedback on actual rendered clip quality, each addressed same-day: mid-word cutoffs and no-look-ahead subtitles (`0abd7e2`, `9fc539d`), and titles latching onto unshown trailing content (`600d3cd`).

## 2026-08-20

- Continued iterating on clip-boundary and title-accuracy issues reported against real rendered clips: stutters/false starts (`a7ee025`), titles keying off closing-line content (`6c72601`), segment boundary overshoot (`421f07e`).
- Diagnosed and fixed the actual root cause behind both the recurring subtitle flashing and the recurring boundary-overshoot reports: Whisper forced-alignment failures producing corrupted word timestamps. Added timestamp normalization and a pause-snap boundary backstop. (`49c88d0`)
- Chased a "clip ends mid-clause" bug through two attempts — a dangling-word blocklist, then discovered blocklists are fundamentally whack-a-mole and switched to a punctuation-based signal instead, plus added retry-with-backoff for a transient Groq API error hit during rapid testing. (`8b4dab6`)
- Logged two feature ideas raised by the user during review: [learning from user title edits](backlog.md#learn-from-user-title-edits) and [per-game terminology context](backlog.md#game-specific-context-terminology--asset-recognition) (seeded with initial Geometry Dash terms).
- Found and fixed two more subtitle-timestamp edge cases (isolated glitches, overlapping/out-of-order timestamps) the earlier burst-detection fix missed, plus two real audio-quality bugs: a doubled/distorted audio track from an unmuted duplicate video layer, and no explicit best-quality format selector on the segment download. (`e691404`)
- Split this planning doc into `claude/` (architecture, spec, plan, backlog, bugs, journal) with a slim `Claude.md` index, since the single file had grown unwieldy.
- Found and fixed the real hallucination behind an unclear-audio/duplicate-phrase report using Groq's segment-level confidence data (`avg_logprob`/`no_speech_prob`), which required explicitly requesting `'segment'` granularity to receive at all. Added a companion `<clip>.subtitles.txt` timing dump per rendered clip per user request, for cross-checking without querying the DB. (`a2e75a8`)
- Fixed subtitle groups mixing multiple sentences and a boundary-extension bug that accepted a trailing comma as a good enough stopping point (`a1250cf`); redesigned the sliding-window subtitle display into discrete non-overlapping groups after it was reported as subtitles "repeating themselves" (`c0fc286`).
- Added a small post-pause subtitle reveal buffer per user request; while verifying it, found and fixed a real regression where the dangling-word extension's search budget was too small for longer unpunctuated stretches (`8309dd9`).
- Added a prompt rule steering the analyzer away from segments that straddle two unrelated topics despite having clean sentence boundaries on both ends (`b87987d`).
- Chased a "clip cuts off before the setup's payoff" report (a spinner segment ending right before its own reveal) through two escalating prompt-rule attempts; confirmed across three re-runs on the identical segment that the free-tier model doesn't reliably act on it even with a matching concrete example — logged in [bugs.md](bugs.md) as likely needing the Claude-upgrade path rather than more prompt tuning. Also found and fixed a real bug surfaced while testing this: the 60s duration-cap trim ran *after* sentence-end selection and could walk back through a good ending onto a dangling word.
- Switched the smoke-test source video (`https://youtu.be/byeEbuPqa7o`) partway through review, at user request, to avoid re-judging the same clips repeatedly.
