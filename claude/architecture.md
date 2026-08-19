# Architecture

Part of the [YouTube Short Splitter](../Claude.md) doc set.

## Shape of the app: local desktop app (not a hosted web app)

Originally planned as a Vercel-hosted Next.js web app with a cloud backend. After weighing it, the decision is to build this **as a local desktop app instead** — runs entirely on the user's own PC (Ryzen 7, RTX 4060/5060, 64GB RAM — plenty for local Remotion/ffmpeg rendering).

Why: simpler storage (everything lives on local disk, no cloud DB/object storage needed), no "is the background worker running" problem (the app only does work while it's open), and fewer security concerns (nothing is exposed to the internet). Code still gets pushed to GitHub frequently for version control — there's just no Vercel deployment for now.

**The full original web-app architecture is preserved in [backlog.md](backlog.md#web-app-version)** in case this expands beyond a local single-user tool later.

### Desktop shell: Electron

Chosen over Tauri to keep everything in one language (Node/TypeScript/React) — Remotion (the rendering engine) is already Node-based, so this avoids introducing Rust for a marginal size/perf gain that isn't a priority right now.

## System diagram

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

## Why these providers

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

## Folder structure

```
Youtube Short Splitter/
  Claude.md                # entry-point overview + index (this doc set)
  claude/                  # architecture, spec, plan, backlog, bugs, journal
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

- **Claude API cost:** if/when the LLM steps move off Groq's free tier (see the future-expandability note above), multiple calls per video (segment analysis + per-clip title generation + dictionary-aware correction) become a modest but real ongoing cost.
- **Groq free-tier rate limits:** 8000 tokens/minute on `openai/gpt-oss-120b` — occasionally hit during rapid back-to-back testing, causing transient `json_validate_failed` errors. Mitigated with retry-with-backoff in `analyze.ts` (see [bugs.md](bugs.md)); not currently a problem at normal (non-testing) usage volume.
- **App only processes while running** — intentional, this was the point of going local.
- **Electron bundle size/RAM** — heavier than a fully native app; accepted trade-off for staying in one language/stack.
