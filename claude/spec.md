# Product spec

Part of the [YouTube Short Splitter](../Claude.md) doc set. See [architecture.md](architecture.md) for how this is built; this doc is about what it does.

## Pipeline (URL → finished clips)

1. **Input:** user pastes a YouTube URL into the app.
2. **Resolve:** app locates/validates the video, and fetches its **metadata** — the uploader's own title, description, and tags (yt-dlp, no media download). This is fed into the analyzer and title prompts as context: the transcript is a live reaction to on-screen gameplay it can't describe, and the uploader's own text usually carries the correct content/creator names, difficulty framing, and terminology the transcription mishears (a real case: a piece of content whose name the transcription got wrong three different ways — the correct spelling was right there in the video title). See [Title generation](#title-generation-context).
3. **Transcribe (audio-only pass):** yt-dlp downloads just the audio track (small, downsampled), WhisperX transcribes it locally with word-level timestamps re-timed by a dedicated forced-alignment pass — much finer than a normal subtitle file, and far more accurate than vanilla Whisper's attention-based timing (see [architecture.md](architecture.md#why-these-providers)). The video metadata from step 2 is fed in as Whisper's `initial_prompt` to bias proper-noun spelling in the subtitles themselves (see [Title generation context](#title-generation-context) — the same context helps transcription, not just the title).
4. **Analyze:** the LLM analyzes the transcript (plus the video metadata from step 2) to find the most engaging/potentially-viral segments.
   - Each segment: **min 15s, max 60s**.
   - **Min 3, max 50 segments per video**, scaled to video length.
   - **Candidate pool, not a one-shot batch:** the analyzer is run **2–3 times** and the results merged. A single pass reliably surfaces the same core handful of moments while genuinely varied material only shows up in *some* runs, so one pass alone would keep regenerating a near-identical batch (see [backlog.md](backlog.md#batch-segment-selection-clusters-on-the-same-handful-of-moments)). Merged candidates are deduped only when near-identical (same start/end proposed twice) — genuine overlap is now allowed and expected, see below — and stored **unrendered**.
5. **Video download:** yt-dlp fetches the full source video once (in parallel with the audio pass). Individual clip ranges are later cut from this local copy frame-accurately with ffmpeg, not re-fetched per clip. *(Previously fetched only the used ranges via yt-dlp `--download-sections`; replaced after its byte-offset seek estimate drifted up to ~15s on progressive-HTTP formats — see [bugs.md](bugs.md).)*
6. **Review & select:** the candidate pool appears in the app as an unrendered list, each entry showing the analyzer's reasoning. The user picks which candidates become clips, and can request more candidate passes to widen the pool. See [Multi-clip generation & review](#multi-clip-generation--review).
7. **Title generation:** per selected clip, the LLM generates a title (from the clip's transcript slice + the video metadata from step 2) — explains the clip while aiming to be clickable/attention-grabbing. See [Title generation context](#title-generation-context).
8. **Render (Remotion):** each selected clip is composited per the [Rendering spec](#rendering-spec) below.
9. **Edit:** rendered clips appear in the app for playback and editing (see [Editing](#editing-in-review)).

## Multi-clip generation & review

The generator is deliberately split into a cheap **candidate** stage and an expensive **render** stage, with the user's selection in between.

**Why the split:** analysis is a single small LLM text call; rendering a clip is ffmpeg + a per-clip title call + a full Remotion composite + 10–100MB of disk, and the Groq free tier has a hard ~200k-token/day cap. So the pipeline generates candidates freely and only ever renders what the user actually asked for.

**Why multiple analyzer passes:** on the same video, repeated `analyze()` runs converge on the same "obviously exciting" handful of moments while other well-reasoned candidates surface only intermittently (documented in [backlog.md](backlog.md#batch-segment-selection-clusters-on-the-same-handful-of-moments)). This run-to-run variance is a feature to harvest, not suppress — pinning the sampling to be deterministic would just lock in the obvious picks and lose the long tail. Running the analyzer a few times and merging is how the varied material gets surfaced.

**Flow:**

1. On analyze, run the analyzer **2–3 times**. Within each run, `diversifySegments()` already spreads that run's picks across the video (90s minimum gap) before falling back to engagement order — see [analyze.ts](../app/main/pipeline/analyze.ts).
2. **Merge** all passes into one candidate pool, deduping only true repeats (same start/end proposed again within a few seconds). **Overlap is allowed on purpose** (2026-09-09): the analyzer prompt explicitly permits proposing a second segment over the same footage when it gives that footage a genuinely different framing (a tighter cut of just the payoff vs. the fuller build-up, or a different hook on the same moment) — tested against a real 17-minute video and roughly doubled the usable candidate count (7 → 14-15) versus dropping every overlapping pick.
3. Persist the pool as **unrendered candidates** — a candidate carries its start/end time, the analyzer's `reason` text, and which pass(es) produced it. Nothing is downloaded per-candidate or rendered at this point.
4. The **review UI** lists every candidate (ordered by engagement rank, showing its reasoning and a source-video scrubber preview if cheap to do). Candidates whose time ranges overlap should be **grouped as alternate cuts of the same moment** rather than shown as unrelated list entries, so the user picks which cut(s) of that moment to render/export rather than comparing them cold against everything else in the pool (idea from 2026-09-09 review — not yet implemented). The user ticks the ones to keep.
5. A **"find more candidates"** action runs another analyzer pass and appends any non-overlapping new candidates to the existing pool — this is how the user pulls in clips "from a different batch" without re-rendering anything.
6. Only ticked candidates proceed to title generation + render. Un-ticked candidates stay in the pool (a project can be reopened and more of them rendered later).

**Data model impact:** clips need to exist before they're rendered. Either a separate `candidates` table, or `clips` rows with a `render_status` of `candidate` / `rendering` / `done` and nullable `file_path` / `title` until rendered. See [architecture.md](architecture.md#data-model-local-sqlite).

## Title generation context

The clip's transcript slice alone is a weak basis for a title: the speech is a live reaction to on-screen gameplay the transcript doesn't describe, it leans on game-specific jargon, and the transcription mangles proper nouns it's never heard (content and creator names especially). Layers of context, cheapest first:

1. **Source video metadata (done).** The uploader's own title, description, and tags, fetched once per project (yt-dlp, no media download — [`fetchVideoMetadata`](../app/main/pipeline/ytdlp.ts)). Two uses, both in [`videoContext.ts`](../app/main/pipeline/videoContext.ts):
   - `formatVideoMetadata()` → a context block in the **analyzer and title prompts** (title + description + tags). Fixed proper nouns downstream (a mis-transcribed content name and a mis-transcribed person name both corrected) and surfaced framing the clip lacked.
   - `buildTranscriptionHint()` → Whisper's **`initial_prompt`** during transcription itself (title + description only — the raw tags are skipped because real videos' tags contain misspellings that would bias transcription the wrong way). This aims to get the spelling right *in the subtitles*, not just have downstream models correct it.
   - The tags are also a useful raw term list for seeding the game glossary below.
2. **Game glossary (done, seeded).** [`app/main/pipeline/glossary.example.json`](../app/main/pipeline/glossary.example.json) is the committed template; the real `glossary.json` is a local, gitignored file of the channel's game-specific terminology (`term`, `category`, `aliases`, `misheard`, `definition` per entry, plus `candidateStopwords`), loaded and matched by [`glossary.ts`](../app/main/pipeline/glossary.ts). A deliberately minimal early slice of the full [custom dictionary](#editing-in-review) feature — no schema or UI. Three uses:
   - canonical proper-noun spellings prepended to the transcription `initial_prompt` (`glossaryHintNames`), so content and player names are spelled right in the subtitles even when the video's own metadata doesn't mention them;
   - the entries that actually appear in a transcript / clip (matched by term, alias, or a known mis-transcription) are injected as a definitions block into the analyzer and title prompts (`matchGlossary` + `formatGlossaryForPrompt`) — the analyzer gets non-mechanic entries at short length to stay within Groq's token budget, the title prompt gets the full text;
   - the same matcher drives the term-flagging in the new-video workflow below.
   - Seeded from the first three source videos, with the user writing every definition.
3. **Per-video context brief (experimental).** One extra LLM call over the full transcript + metadata, producing 2–3 sentences (what the video is, who's speaking, what's shown, key names), cached on the project and prepended to every per-clip title call. Compact and amortized rather than re-sending the whole transcript per clip. To be trialled after the glossary; kept only if it moves title quality noticeably.
4. **Model quality.** Titles run on Groq's `openai/gpt-oss-120b` (free). The title step is tiny (one short call per clip) and isolated behind the `TitleGenerator` interface, so moving just this step to the Claude API — while analysis stays on Groq — is a small, low-cost upgrade if the above context still isn't enough. See [architecture.md](architecture.md#why-these-providers).
5. **On-screen analysis (backlog).** A vision pass over clip frames to ground titles in what's actually shown — the biggest lift, tracked under [Game-specific context](backlog.md#game-specific-context-terminology--asset-recognition).

As of 2026-09-08 the glossary feeds the title prompt with per-level difficulty framing and correct terminology, so **titles are critiqued as rigorously as clip selection and subtitles** during review (they were exempt while the model lacked context). The free model still tends to overstate stakes/difficulty — see [bugs.md](bugs.md).

## New-video workflow

When the user provides a new YouTube link to make shorts from, the order is:

1. **Transcribe first, don't render.** Run the video through download + metadata fetch + WhisperX transcription (with the metadata + glossary `initial_prompt` hint).
2. **Deliver the transcript for review** — a readable, timestamped, sentence-grouped file — with:
   - every [glossary](#title-generation-context) term that appears in this transcript **flagged** (grouped by category, noting where the transcript's spelling is wrong), and
   - each **candidate new term** (`findUnknownTermCandidates` — ALL-CAPS runs and repeated TitleCase phrases, minus known terms and stopwords) automatically run through a wiki lookup (`wikiLookup.ts`, see [backlog.md](backlog.md#game-specific-context-terminology--asset-recognition)) and sorted into two buckets: a **drafted** definition (grounded in a wiki article, source cited) ready to approve or edit, or **needs your input** when the lookup doesn't land a confident match — deliberately one search attempt, not several retry/alternate-query strategies (user direction, 2026-09-18: ask rather than keep searching).
3. **User resolves each term.** Approve/edit a draft, answer a "needs input" one directly, or say skip — added to the local `glossary.json` either way. Nothing is written automatically; every result, wiki-sourced or not, is presented as a draft.
4. **Then** proceed to candidate analysis → review → render.

This keeps the glossary growing with real usage, so each new video's subtitles and titles benefit from terminology learned on the previous ones.

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

**Reference layout** (modeled on a typical auto-clipping tool's output): title block in bold yellow text with black outline, wrapped across multiple centered lines, sitting above the centered 16:9 video; a thin progress/status bar overlaid at the top of the video; below the video, karaoke-style subtitle text with the current phrase in white and the emphasized/highlighted word in red, large and bold, taking up a big share of the bottom space.

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
