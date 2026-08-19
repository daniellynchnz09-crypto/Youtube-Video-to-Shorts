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

Idea proposed 2026-08-20, sits alongside the [Custom dictionary](spec.md#editing-in-review) feature but is broader: since this channel plays specific games with their own in-game vocabulary (e.g. Geometry Dash calling its obstacles "spikes," not "enemies" — a generic word Whisper/the LLM defaults to), a per-game context profile could correct terminology at both the transcription-correction and title-generation stages.

Envisioned shape of the feature (not built yet):

- A GUI section (alongside the custom dictionary UI, likely same build-order step) where the user creates a **game context**: game name, then the app searches the game's wiki/other online sources for background info, plus user-submitted reference images of in-game assets (so clips can eventually be matched against known assets visually) and a terminology mapping list (generic/misheard term → correct in-game term).
- A project could be tagged with an active game context; the dictionary-aware correction pass and title generation would apply that context's terminology mappings on top of (or instead of) the global custom dictionary when generating output.
- Longer-term/more speculative piece: visual asset recognition (matching submitted reference images against clip frames) to auto-suggest which game context applies, or to ground terminology decisions in what's actually on screen — bigger scope than the terminology-mapping half, likely a separate later pass.

**Geometry Dash starter terminology** (given by the user 2026-08-20, since it's the channel's main game — ready to seed once this feature exists):
- enemies → spikes
- stage → level
- arrow → wave
- jump ring → orb
- hard level → demon

Not implemented — no schema, UI, or pipeline wiring exists for this yet. Revisit once the custom dictionary feature itself (build-order step 4) is underway, since this extends the same underlying mechanism.

## Scheduled publishing to YouTube/TikTok

Direct account linking from the app + scheduling clips to post automatically.

- **TikTok Content Posting API** requires app review before unaudited apps can post publicly — until approved, posts would be draft/private-only.
- **YouTube Data API v3** uploads are quota-expensive but fine at personal-project volume.
- When this returns, **n8n** likely returns with it (self-hosted via Docker at that point, since it would need to reach local files/tokens, or the app would need to expose an endpoint to it) — n8n's cron/workflow strengths are a good fit specifically for scheduled posting, less so for the download/render pipeline itself.
- A legacy n8n workflow ("Shorts Splitter (placeholder)") from this project's pre-Electron era already exists and loosely maps out the transcription process — check with the user before reusing or removing it when this backlog item is picked up.

## Web app version

Full architecture already designed, in case this expands beyond a local single-user tool:

- **Hosting:** Vercel (Next.js) for the frontend/UI.
- **Heavy processing:** Vercel serverless can't run yt-dlp/ffmpeg/Remotion (execution limits, no persistent disk, no ffmpeg binary). A local worker (ideally sharing pipeline code with the Electron main process) would poll a cloud DB for jobs — polling avoids exposing the home PC to inbound traffic/tunnels.
- **DB:** cloud Postgres (e.g. Supabase or Neon, free tier).
- **Object storage:** Cloudflare R2 (free tier ~10GB, zero egress fees) — final rendered clips + thumbnails only, never the full source video or raw transcript (same cache-cleanup principle as the local version).
- **Auth:** single-user password gate initially; data model would keep a nullable `user_id` from day one so real multi-user accounts could be added later without a painful migration.
- **n8n's role:** workflow orchestration + the scheduled-publishing step specifically — not the download/render pipeline, since n8n Cloud's sandboxed Code node can't invoke shell binaries like yt-dlp/ffmpeg.
- **Vercel config note:** "Ignored Build Step" can be configured to skip a redeploy when a commit only touches doc-only files.
