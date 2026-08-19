# Product spec

Part of the [YouTube Short Splitter](../Claude.md) doc set. See [architecture.md](architecture.md) for how this is built; this doc is about what it does.

## Pipeline (URL → finished clips)

1. **Input:** user pastes a YouTube URL into the app.
2. **Resolve:** app locates/validates the video.
3. **Transcribe (pass 1 — audio only):** yt-dlp downloads just the audio track (small), Groq Whisper transcribes it with word-level timestamps (much finer than a normal subtitle file).
4. **Analyze:** the LLM analyzes the transcript to find the most engaging/potentially-viral segments.
   - Each segment: **min 15s, max 60s**.
   - **Min 3, max 50 segments per video**, scaled to video length.
5. **Targeted download (pass 2 — video):** yt-dlp fetches *only* the video for the identified segment time ranges (`--download-sections`) — full video is never downloaded, keeping this efficient. *(Two-pass approach: segments can't be known before transcribing, so audio-first → analyze → targeted video fetch is how "only download what's used" is actually achieved.)*
6. **Title generation:** the LLM generates a title per clip — explains the clip while aiming to be clickable/attention-grabbing.
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
