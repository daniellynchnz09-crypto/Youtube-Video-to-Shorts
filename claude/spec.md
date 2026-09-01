# Product spec

Part of the [YouTube Short Splitter](../Claude.md) doc set. See [architecture.md](architecture.md) for how this is built; this doc is about what it does.

## Pipeline (URL → finished clips)

1. **Input:** user pastes a YouTube URL into the app.
2. **Resolve:** app locates/validates the video.
3. **Transcribe (audio-only pass):** yt-dlp downloads just the audio track (small, downsampled), WhisperX transcribes it locally with word-level timestamps re-timed by a dedicated forced-alignment pass — much finer than a normal subtitle file, and far more accurate than vanilla Whisper's attention-based timing (see [architecture.md](architecture.md#why-these-providers)).
4. **Analyze:** the LLM analyzes the transcript to find the most engaging/potentially-viral segments.
   - Each segment: **min 15s, max 60s**.
   - **Min 3, max 50 segments per video**, scaled to video length.
   - **Candidate pool, not a one-shot batch:** the analyzer is run **2–3 times** and the results merged. A single pass reliably surfaces the same core handful of moments while genuinely varied material only shows up in *some* runs, so one pass alone would keep regenerating a near-identical batch (see [backlog.md](backlog.md#batch-segment-selection-clusters-on-the-same-handful-of-moments)). Merged candidates are deduped by time overlap and stored **unrendered**.
5. **Video download:** yt-dlp fetches the full source video once (in parallel with the audio pass). Individual clip ranges are later cut from this local copy frame-accurately with ffmpeg, not re-fetched per clip. *(Previously fetched only the used ranges via yt-dlp `--download-sections`; replaced after its byte-offset seek estimate drifted up to ~15s on progressive-HTTP formats — see [bugs.md](bugs.md).)*
6. **Review & select:** the candidate pool appears in the app as an unrendered list, each entry showing the analyzer's reasoning. The user picks which candidates become clips, and can request more candidate passes to widen the pool. See [Multi-clip generation & review](#multi-clip-generation--review).
7. **Title generation:** per selected clip, the LLM generates a title — explains the clip while aiming to be clickable/attention-grabbing.
8. **Render (Remotion):** each selected clip is composited per the [Rendering spec](#rendering-spec) below.
9. **Edit:** rendered clips appear in the app for playback and editing (see [Editing](#editing-in-review)).

## Multi-clip generation & review

The generator is deliberately split into a cheap **candidate** stage and an expensive **render** stage, with the user's selection in between.

**Why the split:** analysis is a single small LLM text call; rendering a clip is ffmpeg + a per-clip title call + a full Remotion composite + 10–100MB of disk, and the Groq free tier has a hard ~200k-token/day cap. So the pipeline generates candidates freely and only ever renders what the user actually asked for.

**Why multiple analyzer passes:** on the same video, repeated `analyze()` runs converge on the same "obviously exciting" handful of moments while other well-reasoned candidates surface only intermittently (documented in [backlog.md](backlog.md#batch-segment-selection-clusters-on-the-same-handful-of-moments)). This run-to-run variance is a feature to harvest, not suppress — pinning the sampling to be deterministic would just lock in the obvious picks and lose the long tail. Running the analyzer a few times and merging is how the varied material gets surfaced.

**Flow:**

1. On analyze, run the analyzer **2–3 times**. Within each run, `diversifySegments()` already spreads that run's picks across the video (90s minimum gap) before falling back to engagement order — see [analyze.ts](../app/main/pipeline/analyze.ts).
2. **Merge** all passes into one candidate pool, deduping candidates whose time ranges overlap (midpoints within ~30s treated as the same moment; keep the higher-ranked / longer-reasoned one).
3. Persist the pool as **unrendered candidates** — a candidate carries its start/end time, the analyzer's `reason` text, and which pass(es) produced it. Nothing is downloaded per-candidate or rendered at this point.
4. The **review UI** lists every candidate (ordered by engagement rank, showing its reasoning and a source-video scrubber preview if cheap to do). The user ticks the ones to keep.
5. A **"find more candidates"** action runs another analyzer pass and appends any non-overlapping new candidates to the existing pool — this is how the user pulls in clips "from a different batch" without re-rendering anything.
6. Only ticked candidates proceed to title generation + render. Un-ticked candidates stay in the pool (a project can be reopened and more of them rendered later).

**Data model impact:** clips need to exist before they're rendered. Either a separate `candidates` table, or `clips` rows with a `render_status` of `candidate` / `rendering` / `done` and nullable `file_path` / `title` until rendered. See [architecture.md](architecture.md#data-model-local-sqlite).

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
- **Audio:** final rendered clip audio should match source quality — the audio-only transcription pass is deliberately downsampled for Whisper's benefit, but the video segment download and render must not carry that downsampling through to the final clip.

**Reference example:** [`docs/reference/format-example.png`](../docs/reference/format-example.png) — a Vizard.ai-style output screenshot the visual layout is modeled on (ignore the "Vizard.ai" watermark itself). Shows: title block in bold yellow text with black outline, wrapped across multiple centered lines, sitting above the centered 16:9 video; a thin progress/status bar overlaid at the top of the video; below the video, karaoke-style subtitle text with the current phrase in white ("FIRSTLY,") and the emphasized/highlighted word in red ("THE START"), large and bold, taking up a big share of the bottom space.

## Editing (in review)

- **Title editing:** free-text edit; the rendered title box auto-reflows (expands/contracts/wraps lines) based on new text length, always staying constrained to the top-half bounding box above the center video.
- **Subtitle editing:** fix transcription mistakes (e.g. one word mis-split into two, or two words merged into one) without breaking the underlying word-level timestamps. Edited subtitles reflow the same way the title does, staying within their bounding box and never overlapping the center video.
- **Custom dictionary:** if a word/term gets consistently mis-transcribed (common with game terminology not in standard dictionaries), the user can add a mapping (misheard term → correct term, with context). Future transcriptions use this dictionary via the correction pass to prefer the correct term over the generic dictionary word when the context matches.

## Export

- Download individual clips, or all clips at once.
- Per-clip checkboxes for a "download selected" flow, since not every generated clip will be a keeper.

## Project lifecycle

- Each transcription run creates a **project**.
- A **home page** lists all past projects; reopening one lets the user export or edit its clips again.
- **On project close:** scratch cache is deleted (source video segments, full raw transcript) — only the fully rendered clips (+ their per-clip transcript slice) are needed going forward and are kept.
