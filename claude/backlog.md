# Backlog

Part of the [YouTube Short Splitter](../Claude.md) doc set. Deferred for now, kept here so the thinking isn't lost.

## Speaker-specific transcription accuracy

Observed during build-order step 1 testing (2026-08-19): Whisper's transcription is mildly inaccurate on the creator's own speech (accent/speaking style, jargon aside) — not a code bug, just base transcription accuracy.

Since every video run through this tool comes from a single channel/single speaker, there may be a way to adapt transcription specifically to that one voice rather than relying on generic Whisper accuracy:

- **Not available:** Groq's hosted `whisper-large-v3` can't be fine-tuned — there's no per-speaker fine-tuning API on the free-tier hosted model.
- **Worth exploring instead:** Whisper's `prompt` parameter (supported by Groq's transcription endpoint) can bias output toward known vocabulary/phrasing — an accumulated channel-specific glossary (built up via the [Custom dictionary](spec.md#editing-in-review) feature, or a separate running list of the creator's common phrases/terms) could be fed in as a prompt hint on every transcription call, which may reduce misheard words without needing real fine-tuning.
- Would need testing to see how much this actually moves accuracy before committing engineering time to it.

## Learn from user title edits

Observed during build-order step 1 testing (2026-08-19/20): the title generator repeatedly latches onto whatever's discussed in the clip's closing line(s) rather than what's representative of the whole clip, even after several rounds of prompt tuning aimed at this specific failure. Prompting alone may keep needing this kind of correction indefinitely — the user's own note (2026-08-20): sometimes the title just won't match the content the LLM can infer vs. what the creator actually meant, and that's expected to need a manual edit in the review UI regardless of how good the prompt gets.

Idea: once [Title editing](spec.md#editing-in-review) exists in the review UI, capture the (original generated title, transcript, user's edited title) triple whenever a user actually changes a generated title. Over time this becomes a small dataset of "what this user considers a good title for this transcript" — same shape as the [Custom dictionary](spec.md#editing-in-review) feature's misheard-term corrections, just for titles instead of transcription.

- **Possible use:** feed a handful of the user's own past (transcript excerpt → their edited title) pairs into the title-generation prompt as few-shot examples, so future titles drift toward the user's actual taste/style rather than staying static.
- Would need enough edit volume to be useful — worth revisiting once real usage (multiple projects, not just smoke tests) produces a meaningful sample of edits, not before.

## Game-specific context (terminology + asset recognition)

Idea proposed 2026-08-20, sits alongside the [Custom dictionary](spec.md#editing-in-review) feature but is broader: since this channel plays specific games with their own in-game vocabulary (e.g. the game calling its obstacles "spikes," not "enemies" — a generic word Whisper/the LLM defaults to), a per-game context profile could correct terminology at both the transcription-correction and title-generation stages.

Envisioned shape of the feature (not built yet):

- A GUI section (alongside the custom dictionary UI, likely same build-order step) where the user creates a **game context**: game name, then the app searches the game's wiki/other online sources for background info, plus user-submitted reference images of in-game assets (so clips can eventually be matched against known assets visually) and a terminology mapping list (generic/misheard term → correct in-game term).
- A project could be tagged with an active game context; the dictionary-aware correction pass and title generation would apply that context's terminology mappings on top of (or instead of) the global custom dictionary when generating output.
- Longer-term/more speculative piece: visual asset recognition (matching submitted reference images against clip frames) to auto-suggest which game context applies, or to ground terminology decisions in what's actually on screen — bigger scope than the terminology-mapping half, likely a separate later pass.

**the game starter terminology** (given by the user 2026-08-20, since it's the channel's main game — ready to seed once this feature exists):
- enemies → spikes
- stage → level
- arrow → wave
- jump ring → orb
- hard level → demon

Not implemented as a feature — no schema, UI, or asset-recognition wiring exists yet. Revisit once the custom dictionary feature itself (build-order step 4) is underway, since this extends the same underlying mechanism.

**Partial groundwork already in place (2026-09-02):** the source video's metadata — including its tags — is now fetched and fed into the analyzer/title prompts (see [spec.md](spec.md#title-generation-context)). The uploader's tags are effectively a per-video term list (on the test video: `the game`, `top 1 extreme demon`, `joke level`, `a player`, plus the level name and its common mishearings), so some of what a game-context profile would provide is now coming in for free. A small hardcoded game glossary is planned as the next step after that, ahead of any of the full feature above.

## Batch segment selection clusters on the same handful of moments

Observed during build-order step 1 review testing (2026-08-28), across roughly 10 separate `analyze()` calls on the same ~16-minute video: a small "core" set of moments (the spinner/recent-tab intro, the a level/a player/a level bit, the ascending-difficulty explanation, the dislikes/skill-issue rant, the closing teaser) came back as a candidate in nearly *every* run, while a genuine "long tail" of other well-reasoned candidates (a hitbox/noclip glitch bit, a hard-demon-layout challenge, a nerfed/grease-spam bit, a blind-jumps level-design critique, a wave-platformer level) only surfaced in *some* runs — seemingly displacing one of the "core" five rather than the model exploring differently each time.

Net effect: once step 2 (multi-clip generation) exists and actually produces a batch of clips per project, regenerating that batch would likely keep returning largely the same handful of shorts every time, with the more varied material surfacing inconsistently — not the topic diversity a user would want from "give me several shorts from this video." The current analyzer prompt (`analyze.ts`) only asks for "most engaging, ranked" with no instruction to spread selections across the video's breadth or across distinct topics, so nothing currently discourages convergence on the same obviously-quotable beats.

Two levers, pursued from the code side first:
- **Code-level, within a single run — done (`f90d411`).** `diversifySegments()` in [analyze.ts](../app/main/pipeline/analyze.ts) greedily reorders the LLM's ranked candidate list so picks are spread across the video (90s minimum gap between selections) before falling back to pure engagement order once no further diverse pick remains. Chosen over prompt-tuning, which was judged too easy for the model to deprioritize in favour of an individually more engaging pick. Nothing is dropped — just reordered — which matters once a downstream consumer caps how many it renders.
- **Cross-run variance — not the enemy; harvest it.** The reordering above only spreads picks *within* one run. The run-to-run part (each run explores a different slice of the long tail) is worth exploiting rather than suppressing: pinning the sampling deterministic would just permanently lock in the obvious handful. The plan is to run the analyzer 2–3 times per project, merge and dedupe the candidates by time overlap, and let the user pick which ones render from the combined pool — plus a "find more candidates" action that appends further passes. This is specced under [Multi-clip generation & review](spec.md#multi-clip-generation--review) for build-order step 2; it needs a schema change so candidates can exist unrendered.
- **Prompt-level (optional, later):** additionally instruct the analyzer to spread picks across distinct topics, not rank by engagement alone. Lower priority than the above since prompt-following can't be relied on here.

## Scheduled publishing to YouTube/TikTok

Direct account linking from the app + scheduling clips to post automatically.

- **TikTok Content Posting API** requires app review before unaudited apps can post publicly — until approved, posts would be draft/private-only.
- **YouTube Data API v3** uploads are quota-expensive but fine at personal-project volume.
- When this returns, **n8n** likely returns with it (self-hosted via Docker at that point, since it would need to reach local files/tokens, or the app would need to expose an endpoint to it) — n8n's cron/workflow strengths are a good fit specifically for scheduled posting, less so for the download/render pipeline itself.
- A legacy n8n workflow ("Shorts Splitter (placeholder)") from this project's pre-Electron era already exists and loosely maps out the transcription process — check with the user before reusing or removing it when this backlog item is picked up.

## Web app version

### Unattended job resilience — needed before this can run without a user present

Raised by the user (2026-08-31) after repeatedly hitting Groq's transient rate-limit error (`json_validate_failed`, see [bugs.md](bugs.md)) during manual review sessions: on the current local desktop app, a transient failure is tolerable because the user is sitting right there and can just re-run the step. That assumption breaks completely once this runs as an unattended web app job (or even the local app's future multi-clip batch step, to a lesser extent) — nobody is present to notice a failed run and manually retry it, so a clip that hits a transient hiccup needs to recover on its own.

Current state, checked directly (2026-08-31): only `analyze.ts`'s Groq call has retry-with-backoff (`ANALYZE_MAX_ATTEMPTS`, added after repeatedly hitting the same rate-limit error during testing). `transcribe.ts`'s and `titles.ts`'s Groq calls have **no retry logic at all** — either would currently just throw and abort the whole run. Neither does the yt-dlp download step or the local ffmpeg segment-extraction step (see [bugs.md](bugs.md) for the extraction-accuracy fix that introduced that step) — a flaky network blip or a transient ffmpeg failure kills the run the same way.

Before this runs unattended, needed:
- **Retry-with-backoff on every external call in the pipeline**, not just the one that happened to get hit hardest during manual testing — generalize `analyze.ts`'s existing pattern (or extract it into a shared helper) to `transcribe.ts`, `titles.ts`, the yt-dlp downloads, and the ffmpeg extraction step.
- **Job-level retry, not just call-level** — a background worker (per the polling design below) that can re-attempt an entire failed clip (or failed pipeline stage) on its own schedule, not just retry a single API call a few times before giving up. Needs to distinguish transient failures (rate limits, network blips — worth retrying) from permanent ones (a genuinely malformed video URL, a video that's been taken down — retrying forever would just waste quota).
- **Surfacing partial failure in a multi-clip batch** — one clip failing shouldn't silently drop it from the batch or crash the others; the user (or the job status the web UI shows) needs to see which clips succeeded, which are still retrying, and which gave up permanently.

Full architecture already designed, in case this expands beyond a local single-user tool:

- **Hosting:** Vercel (Next.js) for the frontend/UI.
- **Heavy processing:** Vercel serverless can't run yt-dlp/ffmpeg/Remotion (execution limits, no persistent disk, no ffmpeg binary). A local worker (ideally sharing pipeline code with the Electron main process) would poll a cloud DB for jobs — polling avoids exposing the home PC to inbound traffic/tunnels.
- **DB:** cloud Postgres (e.g. Supabase or Neon, free tier).
- **Object storage:** Cloudflare R2 (free tier ~10GB, zero egress fees) — final rendered clips + thumbnails only, never the full source video or raw transcript (same cache-cleanup principle as the local version).
- **Auth:** single-user password gate initially; data model would keep a nullable `user_id` from day one so real multi-user accounts could be added later without a painful migration.
- **n8n's role:** workflow orchestration + the scheduled-publishing step specifically — not the download/render pipeline, since n8n Cloud's sandboxed Code node can't invoke shell binaries like yt-dlp/ffmpeg.
- **Vercel config note:** "Ignored Build Step" can be configured to skip a redeploy when a commit only touches doc-only files.
