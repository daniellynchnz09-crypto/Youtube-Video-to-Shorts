# YouTube Short Splitter — Planning Doc

Status: **Planning phase.** Nothing has been scaffolded yet. This file is the living spec — update it as decisions change. Changes to this file alone don't need a deploy/build (there's currently no deployment anyway — see Architecture).

## What this is

A tool that takes a YouTube video URL and automatically splits it into vertical (1080x1920) shorts suitable for YouTube Shorts/TikTok — similar to TikTok's own clipping tool or Vizard AI. It finds the most engaging segments, generates clickable titles, burns in animated karaoke-style subtitles, and lets the user review/edit/export the results.

## Shape of the app: local desktop app (not a hosted web app)

Originally planned as a Vercel-hosted Next.js web app with a cloud backend. After weighing it, the decision is to build this **as a local desktop app instead** — runs entirely on the user's own PC (Ryzen 7, RTX 4060/5060, 64GB RAM — plenty for local Remotion/ffmpeg rendering).

Why: simpler storage (everything lives on local disk, no cloud DB/object storage needed), no "is the background worker running" problem (the app only does work while it's open), and fewer security concerns (nothing is exposed to the internet). Code still gets pushed to GitHub frequently for version control — there's just no Vercel deployment for now.

**The full original web-app architecture is preserved in the [Backlog](#backlog) section** in case this expands beyond a local single-user tool later.

### Desktop shell: Electron

Chosen over Tauri to keep everything in one language (Node/TypeScript/React) — Remotion (the rendering engine) is already Node-based, so this avoids introducing Rust for a marginal size/perf gain that isn't a priority right now.

## Architecture

```
Electron App (runs only while the user is using it)
  ├─ Main process (Node.js/TypeScript)
  │    - yt-dlp: downloads only the video segments needed for clips
  │    - Groq Whisper (whisper-large-v3): word-level transcription
  │    - Groq-hosted LLM (openai/gpt-oss-120b): highlight/virality
  │      detection, clip titles, dictionary-aware transcript correction
  │      (free tier — see note below on swapping to Claude later)
  │    - Remotion: renders final 1080x1920 clips locally (GPU-accelerated
  │      encode where available)
  │    - SQLite (better-sqlite3 or Prisma+SQLite): projects, clips,
  │      transcripts, custom dictionary
  │    - local filesystem: rendered clips + thumbnails, under a
  │      per-project folder
  │
  └─ Renderer process (React UI)
       - review/edit UI, project home page, custom dictionary UI
       - talks to the main process via Electron IPC
       - no network calls except the external APIs (yt-dlp's source,
         Groq)
```

No polling, no job queue, no webhook exposure — UI and worker live in the same app, so everything is in-process or IPC.

### Why these providers

- **Transcription — Groq-hosted Whisper (`whisper-large-v3`):** word-level timestamps, free tier covers personal-project volume, fast. (Claude's API is text-only, no audio transcription. Gemini access is capped at 20 prompts/day — too low since each video needs multiple AI calls that scale with clip count.)
- **Analysis / titles / dictionary correction — Groq-hosted LLM (`openai/gpt-oss-120b`), for now:** free tier, reuses the Groq key already set up for transcription, $0 ongoing cost. Used for: finding the most engaging/viral segments, generating clip titles, and applying custom-dictionary-aware corrections to the transcript. (Model choice as of 2026-08-19 — Groq's hosted lineup changes over time; `app/main/pipeline/analyze.ts`/`titles.ts` are the source of truth if this drifts.)
  - **Future expandability note:** Anthropic's Claude API was the original choice here and remains the natural upgrade path if clip/title quality on the free model isn't good enough — better judgment on "is this segment actually engaging" and better title copywriting, at the cost of paying for API credits separately from a claude.ai subscription (the two are billed independently; there's no free Claude API tier). Swapping providers later should only mean changing the LLM client in this one pipeline step, not a structural rework — worth keeping the analysis/title-generation code isolated behind a small interface for that reason.
- **Rendering — Remotion, rendered locally:** free for personal use, React-based so the animated title/karaoke-subtitle/emoji-pop-in timing logic is just data-driven React components. Runs on the user's own hardware rather than a paid cloud renderer (e.g. Remotion Lambda).

## Storage

- **Scratch (deleted when a project is closed):** downloaded source video segments, full raw transcript. Likely low hundreds of MB to a couple GB per source video while a project is open.
- **Persistent (kept until the user deletes a project):** rendered vertical clips + thumbnails. Roughly 15–60s of 1080x1920 video each, ~10–100MB depending on encode settings. Everything is local disk now, so no cloud storage cap forces early cleanup — just keep an eye on total disk usage as projects accumulate.

## Data model (local SQLite)

- `projects` — id, source YouTube URL, title, status, created_at
- `clips` — id, project_id, title, start/end time, ordered word-level subtitle data (per-word timestamps + user edit overrides), render status, local file path, thumbnail path, selected/rejected flag
- `dictionary_terms` — id, misheard word(s), correct term, context notes — **global** across all projects (not per-project), so a correction learned on one video improves transcription on all future videos

## Pipeline (URL → finished clips)

1. **Input:** user pastes a YouTube URL into the app.
2. **Resolve:** app locates/validates the video.
3. **Transcribe (pass 1 — audio only):** yt-dlp downloads just the audio track (small), Groq Whisper transcribes it with word-level timestamps (much finer than a normal subtitle file).
4. **Analyze:** Claude analyzes the transcript to find the most engaging/potentially-viral segments.
   - Each segment: **min 15s, max 60s**.
   - **Min 3, max 50 segments per video**, scaled to video length.
5. **Targeted download (pass 2 — video):** yt-dlp fetches *only* the video for the identified segment time ranges (`--download-sections`) — full video is never downloaded, keeping this efficient. *(Two-pass approach: segments can't be known before transcribing, so audio-first → analyze → targeted video fetch is how "only download what's used" is actually achieved.)*
6. **Title generation:** Claude generates a title per clip — explains the clip while aiming to be clickable/attention-grabbing.
7. **Render (Remotion):** each clip is composited per the [Rendering spec](#rendering-spec) below.
8. **Review:** finished clips appear in the app for playback/editing (see [Editing](#editing-in-review)).

## Rendering spec

Canvas: **1080×1920** (portrait).

- **Center video:** the downloaded clip keeps its original 16:9 aspect ratio and is centered on the canvas.
- **Background:** an expanded/zoomed, heavily blurred version of the same video fills the rest of the canvas (avoids black bars top/bottom), with a slight dark gradient overlay so the background doesn't compete with the foreground content.
- **Title (above the center video):**
  - Bold font, centered.
  - Color: yellow, **except** switches to red if the background behind the title is yellow (for contrast).
  - Black outline.
  - Sized/wrapped to use as much of the available space above the video as possible without feeling cramped.
- **Subtitles (below the center video):**
  - Karaoke-style: at most **4 words visible at a time**, synced to speech.
  - Font: Rubik Black.
  - Color: white or black depending on background contrast at that point.
  - Sized to take up the majority of the bottom half without cramming.
  - **Word highlight:** when a word is spoken, the matching on-screen word lights up (highlight + color change).
  - **Emoji pop-in:** if a spoken word has a matching/equivalent emoji, it animates in when the word is said and disappears after 1.5–2 seconds.

**Reference example:** [`docs/reference/format-example.png`](docs/reference/format-example.png) — a Vizard.ai-style output screenshot the visual layout is modeled on (ignore the "Vizard.ai" watermark itself). Shows: title block in bold yellow text with black outline, wrapped across multiple centered lines, sitting above the centered 16:9 video; a thin progress/status bar overlaid at the top of the video; below the video, karaoke-style subtitle text with the current phrase in white ("FIRSTLY,") and the emphasized/highlighted word in red ("THE START"), large and bold, taking up a big share of the bottom space.

## Editing (in review)

- **Title editing:** free-text edit; the rendered title box auto-reflows (expands/contracts/wraps lines) based on new text length, always staying constrained to the top-half bounding box above the center video.
- **Subtitle editing:** fix transcription mistakes (e.g. one word mis-split into two, or two words merged into one) without breaking the underlying word-level timestamps. Edited subtitles reflow the same way the title does, staying within their bounding box and never overlapping the center video.
- **Custom dictionary:** if a word/term gets consistently mis-transcribed (common with game terminology not in standard dictionaries), the user can add a mapping (misheard term → correct term, with context). Future transcriptions use this dictionary via the Claude correction pass to prefer the correct term over the generic dictionary word when the context matches.

## Export

- Download individual clips, or all clips at once.
- Per-clip checkboxes for a "download selected" flow, since not every generated clip will be a keeper.

## Project lifecycle

- Each transcription run creates a **project**.
- A **home page** lists all past projects; reopening one lets the user export or edit its clips again.
- **On project close:** scratch cache is deleted (source video segments, full raw transcript) — only the fully rendered clips (+ their per-clip transcript slice) are needed going forward and are kept.

## Folder structure

```
Youtube Short Splitter/
  Claude.md                # this file
  app/
    main/                  # Electron main process
      pipeline/            # download, transcribe, analyze, render steps
      remotion/             # Remotion compositions (background, title,
                            # karaoke subtitles, emoji pop-ins)
      db/                   # SQLite schema/migrations
    renderer/               # React UI (review/edit, project home, dictionary)
  shared/                   # shared TS types/schema between main + renderer
```

## Known risks / constraints

- **Claude API cost:** multiple calls per video (segment analysis + per-clip title generation + dictionary-aware correction) — modest but real ongoing cost, not free-tier.
- **App only processes while running** — intentional, this was the point of going local.
- **Electron bundle size/RAM** — heavier than a fully native app; accepted trade-off for staying in one language/stack.

## Suggested build order

1. Core pipeline end-to-end for one video → one clip, no UI (prove download → transcribe → analyze → render works).
2. Multi-clip generation + minimal review UI (list, play, select/reject, export).
3. Full rendering spec fidelity (title reflow, karaoke highlight, emoji pop-ins) + subtitle/title editing.
4. Custom dictionary feature.
5. Project home page + persistence/cache-cleanup lifecycle.
6. *(Backlog)* Web app expansion.
7. *(Backlog)* YouTube scheduled publishing via n8n.
8. *(Backlog)* TikTok scheduled publishing (pending API review).

---

## Backlog

Deferred for now, kept here so the thinking isn't lost.

### Scheduled publishing to YouTube/TikTok

Direct account linking from the app + scheduling clips to post automatically.

- **TikTok Content Posting API** requires app review before unaudited apps can post publicly — until approved, posts would be draft/private-only.
- **YouTube Data API v3** uploads are quota-expensive but fine at personal-project volume.
- When this returns, **n8n** likely returns with it (self-hosted via Docker at that point, since it would need to reach local files/tokens, or the app would need to expose an endpoint to it) — n8n's cron/workflow strengths are a good fit specifically for scheduled posting, less so for the download/render pipeline itself.

### Web app version

Full architecture already designed, in case this expands beyond a local single-user tool:

- **Hosting:** Vercel (Next.js) for the frontend/UI.
- **Heavy processing:** Vercel serverless can't run yt-dlp/ffmpeg/Remotion (execution limits, no persistent disk, no ffmpeg binary). A local worker (ideally sharing pipeline code with the Electron main process) would poll a cloud DB for jobs — polling avoids exposing the home PC to inbound traffic/tunnels.
- **DB:** cloud Postgres (e.g. Supabase or Neon, free tier).
- **Object storage:** Cloudflare R2 (free tier ~10GB, zero egress fees) — final rendered clips + thumbnails only, never the full source video or raw transcript (same cache-cleanup principle as the local version).
- **Auth:** single-user password gate initially; data model would keep a nullable `user_id` from day one so real multi-user accounts could be added later without a painful migration.
- **n8n's role:** workflow orchestration + the scheduled-publishing step specifically — not the download/render pipeline, since n8n Cloud's sandboxed Code node can't invoke shell binaries like yt-dlp/ffmpeg.
- **Vercel config note:** "Ignored Build Step" can be configured to skip a redeploy when a commit only touches `Claude.md`.
