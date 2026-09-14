import type Groq from 'groq-sdk'
import { z } from 'zod'
import { segmentSchema, type Segment } from '../../../shared/schemas.js'
import type { VideoMetadata, WordTimestamp } from '../../../shared/types.js'
import { formatVideoMetadata } from './videoContext.js'
import { formatGlossaryForPrompt, matchGlossary } from './glossary.js'

/**
 * The analysis step behind an interface, per Claude.md's expandability note:
 * swapping this from Groq to Claude later should mean writing one new
 * implementation of this interface, not touching the rest of the pipeline.
 */
export interface SegmentAnalyzer {
  analyze(
    groq: Groq,
    words: WordTimestamp[],
    videoDurationSeconds: number,
    metadata?: VideoMetadata
  ): Promise<Segment[]>
}

/**
 * Every Nth word gets an index marker for the LLM to reference (see
 * buildPrompt). Smaller = less interpolation error on where a boundary
 * actually lands, at the cost of more tokens — 10 was chosen after 20
 * proved loose enough that an endWordIndex could land a few words into the
 * next topic instead of at the true end of the current one.
 */
const MARKER_INTERVAL = 10
/**
 * Groq's `openai/gpt-oss-120b` caps every single request at a flat 8000
 * tokens, independent of the per-minute budget (a 413, not the retryable 400
 * TPM-exhaustion case in `requestSegments` below — retrying the identical
 * oversized prompt just fails again). First hit 2026-09-09 on a 2419-word
 * video (8041 tokens requested). Tried widening marker spacing for long
 * transcripts first — measuring the actual prompt afterward showed that was
 * the wrong lever: the real chars-per-token ratio here is ~2.7-2.9 (not the
 * ~4 assumed), and the fixed rules/instructions text alone is already
 * ~8000+ characters, paid on every call regardless of video length: widening
 * markers only trims a few hundred characters (spread across the whole
 * transcript), nowhere near enough for a genuinely long video, and it also
 * costs boundary precision (see `snapStartIndexToSentenceStart` below,
 * added after a wider-marker run landed a start nine words late). The actual
 * fix is `chunkWordRanges` below: split long transcripts across multiple
 * requests, each comfortably under budget, rather than trying to shrink one
 * request to fit an ever-growing video.
 */
/**
 * Gaps at or above this are called out inline in the transcript sent to the
 * LLM (see buildPrompt) — the transcript is otherwise just word tokens, so
 * without this the model has no way to tell a real sentence boundary from a
 * mid-sentence hesitation (e.g. a speaker pausing to collect their thoughts
 * before finishing a sentence they'd started).
 */
const PAUSE_MARK_THRESHOLD_SECONDS = 0.6

/**
 * The LLM's endWordIndex is only ever an estimate (interpolated from sparse
 * markers), and in practice it sometimes overshoots a few words into the
 * next topic even with the prompt rules above. As a code-level backstop for
 * "genuine sentence end" segments, snap backward from the LLM's pick to the
 * nearest real pause in the actual word timestamps within a small window —
 * silence is a much more reliable end-of-thought signal than index counting.
 * Only applied when endsAtSentenceEnd is true; a deliberate quick cut has no
 * pause to snap to by design, so it's left as the LLM chose it.
 */
const BOUNDARY_SNAP_SEARCH_WORDS = 15
const BOUNDARY_SNAP_MIN_GAP_SECONDS = 0.35

/**
 * startWordIndex gets no equivalent correction to endWordIndex's several
 * layers below (snapEndIndexToPause, findSentenceEnd) — it's trusted as
 * given, despite coming from the exact same sparse-marker interpolation the
 * end-side fixes exist to correct for. Confirmed in practice (2026-09-09): a
 * candidate opened on "attempt." — the LAST word of the sentence "Wonder how
 * many rooms I can do in one attempt." — nine words past the real start,
 * dropping the entire setup the clip needed. A word ending its own sentence,
 * or with no pause/punctuation before it at all, is never a real sentence
 * start (barring index 0) — walk backward to the nearest position that
 * actually is one, the same "trust silence/punctuation over index counting"
 * logic already used for endWordIndex.
 */
const START_SNAP_SEARCH_WORDS = 20

function isSentenceStart(words: WordTimestamp[], index: number): boolean {
  if (index === 0) return true
  const prev = words[index - 1]!
  const gap = words[index]!.start - prev.end
  return hasSentenceEndingPunctuation(prev.word) || gap >= PAUSE_MARK_THRESHOLD_SECONDS
}

function snapStartIndexToSentenceStart(words: WordTimestamp[], startIndex: number): number {
  if (isSentenceStart(words, startIndex)) return startIndex
  const earliest = Math.max(0, startIndex - START_SNAP_SEARCH_WORDS)
  for (let i = startIndex - 1; i > earliest; i--) {
    if (isSentenceStart(words, i)) return i
  }
  return startIndex
}

function snapEndIndexToPause(words: WordTimestamp[], startIndex: number, endIndex: number): number {
  const earliest = Math.max(startIndex, endIndex - BOUNDARY_SNAP_SEARCH_WORDS)
  for (let i = endIndex; i > earliest; i--) {
    const gap = words[i]!.start - words[i - 1]!.end
    if (gap >= BOUNDARY_SNAP_MIN_GAP_SECONDS) {
      return i - 1
    }
  }
  return endIndex
}

/**
 * Regardless of what the LLM decided, a segment should never end on a word
 * that's grammatically incomplete on its own — the prompt says so, but it's
 * not always followed (observed ending on "are", then "I'm", then "actually"
 * across successive attempts at blocklisting specific words — a fixed word
 * list is whack-a-mole and can never cover every case).
 *
 * A more general, more reliable signal: Groq's Whisper transcription already
 * attaches punctuation to words (e.g. "chaos!", "control."), and every bad
 * ending observed so far had none. So instead of matching against a word
 * list, push endIndex forward until it lands on a word that actually carries
 * SENTENCE-ending punctuation (. ! ?) — bounded by MAX_SEGMENT_SECONDS so
 * this can't blow past the duration cap enforced further down. Deliberately
 * excludes commas/semicolons/colons: those mark a still-continuing sentence,
 * not a real stopping point, and accepting them produced clips that ended on
 * something like "...at the yellow orb," which read as an abrupt, random
 * cutoff despite technically carrying punctuation. The word list is kept as
 * a secondary check for the rare case where punctuation is missing but the
 * word is still an obvious dangler.
 */
const DANGLING_END_WORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'so', 'because', 'that', 'which', 'who', 'whose',
  'is', 'are', 'was', 'were', 'am', 'be', 'been', 'being', 'to', 'of', 'in', 'on', 'at',
  'for', 'with', 'as', 'by', 'from', 'i', 'you', 'he', 'she', 'it', 'we', 'they', 'this',
  'these', 'those', 'my', 'your', 'his', 'her', 'its', 'our', 'their', 'if', 'when',
  'while', 'than', 'then', 'not', 'no', 'very', 'really', 'just', 'like',
  // contractions — these strip to keep their apostrophe (see stripWord), and
  // are just as dangling as their expanded form ("I'm" == "I am")
  "i'm", "it's", "that's", "there's", "he's", "she's", "what's", "who's", "here's",
  "we're", "you're", "they're", "i've", "you've", "we've", "they've",
  "i'll", "you'll", "he'll", "she'll", "we'll", "they'll", "it'll",
  "i'd", "you'd", "he'd", "she'd", "we'd", "they'd",
  "isn't", "wasn't", "aren't", "weren't", "don't", "doesn't", "didn't",
  "can't", "won't", "wouldn't", "couldn't", "shouldn't", "mustn't", "let's"
])
const DANGLING_EXTEND_MAX_WORDS = 20
/**
 * If forward extension still hasn't found real sentence-ending punctuation
 * within its own budget (a long run-on stretch with no period), search
 * backward from the original pick instead — better to end the clip a bit
 * shorter, on the last word that genuinely does end a sentence, than to
 * accept a cut that's still incomplete either way.
 */
const CLAUSE_END_BACKWARD_SEARCH_WORDS = 25

function stripWord(raw: string): string {
  return raw.toLowerCase().replace(/[^a-z']/g, '')
}

function hasSentenceEndingPunctuation(word: string): boolean {
  return /[.!?]["')\]]*$/.test(word.trim())
}

function extendPastDanglingWord(
  words: WordTimestamp[],
  startIndex: number,
  endIndex: number
): number {
  let idx = endIndex
  let extended = 0
  while (
    idx < words.length - 1 &&
    extended < DANGLING_EXTEND_MAX_WORDS &&
    (!hasSentenceEndingPunctuation(words[idx]!.word) || DANGLING_END_WORDS.has(stripWord(words[idx]!.word))) &&
    words[idx + 1]!.end - words[startIndex]!.start <= MAX_SEGMENT_SECONDS
  ) {
    idx++
    extended++
  }
  return idx
}

function findSentenceEnd(words: WordTimestamp[], startIndex: number, originalEndIndex: number): number {
  const forward = extendPastDanglingWord(words, startIndex, originalEndIndex)
  if (hasSentenceEndingPunctuation(words[forward]!.word)) return forward

  const earliest = Math.max(startIndex, originalEndIndex - CLAUSE_END_BACKWARD_SEARCH_WORDS)
  for (let i = originalEndIndex; i > earliest; i--) {
    if (hasSentenceEndingPunctuation(words[i]!.word)) return i
  }
  return forward
}
/**
 * Trailing buffer so a clip doesn't audibly cut off mid-word when the last
 * word's timestamp is slightly optimistic (Whisper's word-end timestamps
 * tend to land a bit early on trailing consonants). Two tiers, chosen by
 * the LLM per-segment: a quick cut when the speaker pivots to a new topic
 * right after (too much padding would bleed into the next thought), and a
 * more generous one for breathing room when the segment actually ends at
 * the end of a sentence/thought.
 */
const QUICK_CUT_PADDING_SECONDS = 0.25
const SENTENCE_END_PADDING_SECONDS = 0.8

/**
 * Hard backstop for the 15-60s rule stated in the prompt below. The LLM
 * mostly follows it, but not always (e.g. it can choose to ride out a pause
 * to reach a real sentence end and land just past 60s) — enforced here in
 * code rather than trusted purely to prompt-following.
 */
const MIN_SEGMENT_SECONDS = 15
const MAX_SEGMENT_SECONDS = 60

/**
 * Deterministic backstop for "too much dead air" — see its use below.
 * DEAD_AIR_GAP_THRESHOLD_SECONDS is intentionally higher than
 * PAUSE_MARK_THRESHOLD_SECONDS (0.6s): normal speech has plenty of
 * sub-3s pauses that don't make a segment feel disjointed, so only
 * genuinely long silences count toward the fraction.
 */
const DEAD_AIR_GAP_THRESHOLD_SECONDS = 3
const MAX_DEAD_AIR_FRACTION = 0.35

/**
 * Groq's free tier caps openai/gpt-oss-120b at 8000 tokens/minute — sending a
 * timestamp on every single word blew way past that on anything longer than
 * a couple minutes (a 17-minute/1931-word video alone needed ~20k tokens).
 * Instead: plain transcript text with a sparse word-index marker every
 * MARKER_INTERVAL words for grounding, and the LLM answers with word
 * indices (not seconds) — actual timestamps get looked up locally from the
 * `words` array afterward, so a little index imprecision from the sparse
 * markers just means a few words of slop at a clip boundary, not wrong data.
 */
function buildPrompt(
  words: WordTimestamp[],
  videoDurationSeconds: number,
  metadata: VideoMetadata | undefined
): string {
  const maxSegments = Math.min(50, Math.max(3, Math.round(videoDurationSeconds / 60)))
  // A flat floor of 3 regardless of video length meant a ~15min video could
  // return as few candidates as a ~3min one. Scale the floor with maxSegments
  // instead, so longer videos are expected to surface proportionally more.
  const minSegments = Math.max(1, Math.floor(maxSegments / 3))
  const parts: string[] = []
  for (let i = 0; i < words.length; i++) {
    const word = words[i]!
    if (i > 0) {
      const gap = word.start - words[i - 1]!.end
      if (gap >= PAUSE_MARK_THRESHOLD_SECONDS) {
        parts.push(`‖pause ${gap.toFixed(1)}s‖`)
      }
    }
    parts.push(i % MARKER_INTERVAL === 0 ? `«${i}»${word.word}` : word.word)
  }
  const transcript = parts.join(' ')

  const metadataBlock = formatVideoMetadata(metadata)
  const contextSection = metadataBlock
    ? `\nContext — metadata from the source video, to help you understand references, in-jokes, and terminology in the transcript (the speech is a live reaction to something on screen the transcript doesn't describe):\n${metadataBlock}\n`
    : ''

  // For the analyzer, the useful glossary entries are the ones that tell it
  // what a *moment* is about — content/level names, people, references,
  // difficulty framing. Plain game mechanics matter more for a title than for
  // picking segments, and dropping them keeps this within Groq's per-minute
  // token budget on top of an already-large transcript prompt.
  const glossaryMatches = matchGlossary(words.map((w) => w.word).join(' '))
    .filter((m) => m.entry.category !== 'mechanic')
    .slice(0, 25)
  const glossaryBlock = formatGlossaryForPrompt(glossaryMatches, { maxDefinitionChars: 120 })
  const glossarySection = glossaryBlock
    ? `\nThe channel covers one specific video game. Terms from its glossary that appear in this transcript (use these to judge what a moment is actually about):\n${glossaryBlock}\n`
    : ''

  return `You are selecting the most engaging, viral-worthy segments from a video transcript to turn into vertical short-form clips.

The transcript below has a word-index marker like «140» before every ${MARKER_INTERVAL}th word, so you can reference positions without counting every word yourself. It also has inline markers like ‖pause 1.3s‖ wherever the speaker paused that long before their next word.
${contextSection}${glossarySection}
Rules:
- Each segment must correspond to roughly 15-60 seconds of speech.
- Return between ${minSegments} and ${maxSegments} segments, ranked most engaging first.
- Segments are allowed to overlap or reuse the same footage as another segment, but only when each one gives that footage a genuinely different framing (a different hook, a different starting/ending point that changes what question or moment the clip centers on) — not the same beginning and end proposed twice. Don't force this; most segments should still just be your best independent picks. It's fine, and expected, for two segments to share part of their time range when the footage naturally supports more than one distinct short.
- startWordIndex/endWordIndex should be your best estimate of the actual word position — interpolate between the nearest markers.
- Critical: pick boundaries that give the clip an obvious beginning and end. startWordIndex must land at (or very near) the start of a complete sentence or thought — not mid-sentence, so the viewer isn't dropped in without context. endWordIndex must land at (or very near) the end of a complete sentence or thought — not cut off mid-idea.
- Beyond just the boundaries, the segment as a whole should cover one coherent moment or topic, not just start and end cleanly. Watch specifically for a segment that straddles the tail end of one activity/topic and the start of a completely unrelated one (e.g. barely a comment on finishing one thing, then moving straight into commentary on something unrelated) — even with clean sentence boundaries on both ends, a segment like that lacks a real throughline and reads as unfocused. When a candidate segment would straddle that kind of seam, prefer shifting it to sit entirely within whichever side has more substance, rather than spanning both.
- Watch the ‖pause Xs‖ markers inside a candidate segment, not just at its edges. A single long pause mid-segment can be fine (e.g. quiet gameplay before the speaker reacts again). But a segment strung together from multiple short lines separated by several long pauses (roughly 5s+) is mostly dead air wearing a few words of connective tissue — reads as disjointed voice clips, not one moment, even when each individual line is on-topic. Prefer a tighter segment around the actual commentary over a wide one that pads itself out with silence to reach the fragments.
- Worth factoring into how engaging a segment is: if it sets up a question, wager, spin/roll, or prediction, it reads better when the resolution is included too, rather than ending right on the setup line. If the payoff is close by and fits within the 15-60s limit, prefer extending endWordIndex to include it. This is a nice-to-have, not a hard requirement — plenty of engaging segments don't involve this pattern at all, and if the actual resolution is genuinely far off (e.g. a long build-up or a slow reveal), it's fine to either use a different segment or just let this one end on the setup.
- When estimating endWordIndex, err toward landing a couple words early rather than late. Overshooting past the true end of the thought and into the next topic is worse than ending a beat sooner — the intended sentence/thought must not have any of the following topic's words bleeding into the clip.
- Watch for false starts and stutters (e.g. "I'd probably be I'd probably be") — a repeated/incomplete phrase followed by a pause usually means the speaker is still collecting their thoughts mid-sentence, not concluding one. Don't let endWordIndex land there. Prefer pushing endWordIndex past the pause to include how the speaker actually finishes the thought, but only if that still fits the 15-60s limit above — if including the real completion would push the segment past 60s, end the segment earlier instead, before the repeated phrase begins, rather than breaking the duration limit.
- endWordIndex must ALWAYS land at the end of a grammatically complete clause — e.g. never on a conjunction ("and", "so", "because"), a dangling article/pronoun ("that", "a", "this"), or an auxiliary verb with no completion ("are", "is", "was"). This applies equally whether endsAtSentenceEnd is true or false — the two cases are only about what happens right after the clip's own content ends, never about whether the clip's own last clause is finished.
- For each segment, also decide endsAtSentenceEnd: true if, right after endWordIndex, the speaker pauses or the thought is fully closed with nothing relevant said immediately next (the clip can afford a little breathing room there); false if the speaker keeps talking immediately after endWordIndex with no gap — a new topic, or more on the same one — so a big pad would bleed into it and the cut needs to be tight.

Transcript (${words.length} words total, video is ${videoDurationSeconds.toFixed(0)}s long):
${transcript}

Respond with ONLY JSON matching this shape:
{ "segments": [{ "startWordIndex": number, "endWordIndex": number, "endsAtSentenceEnd": boolean, "reason": string }] }`
}

const llmSegmentResponseSchema = z.object({
  segments: z
    .array(
      z.object({
        startWordIndex: z.number().int().nonnegative(),
        endWordIndex: z.number().int().nonnegative(),
        endsAtSentenceEnd: z.boolean(),
        reason: z.string().min(1)
      })
    )
    .min(1)
})

/**
 * Groq occasionally returns a 400 json_validate_failed with an empty
 * failed_generation for this call — confirmed via response headers to be the
 * free tier's 8000 tokens/minute cap (seen remaining-tokens as low as 64),
 * hit by running several analyses back-to-back within the same rolling
 * minute. groq-sdk's own retry logic doesn't cover this since Groq reports
 * it as a 400 (a client-error status, not one the SDK treats as transient).
 * The token bucket needs up to ~60s to refill, so the backoff has to
 * actually span that — a short few-second retry just fails again against
 * the same still-tight budget.
 */
const ANALYZE_MAX_ATTEMPTS = 3
const ANALYZE_RETRY_BASE_DELAY_MS = 20000

async function requestSegments(
  groq: Groq,
  words: WordTimestamp[],
  videoDurationSeconds: number,
  metadata: VideoMetadata | undefined
): Promise<z.infer<typeof llmSegmentResponseSchema>> {
  let lastError: unknown
  for (let attempt = 1; attempt <= ANALYZE_MAX_ATTEMPTS; attempt++) {
    try {
      const completion = await groq.chat.completions.create({
        model: 'openai/gpt-oss-120b',
        messages: [{ role: 'user', content: buildPrompt(words, videoDurationSeconds, metadata) }],
        response_format: { type: 'json_object' }
      })
      const raw = completion.choices[0]?.message?.content ?? '{}'
      return llmSegmentResponseSchema.parse(JSON.parse(raw))
    } catch (err) {
      lastError = err
      if (attempt < ANALYZE_MAX_ATTEMPTS) {
        await new Promise((resolve) => setTimeout(resolve, ANALYZE_RETRY_BASE_DELAY_MS * attempt))
      }
    }
  }
  throw lastError
}

/**
 * The real fix for the 8000-token cap (see MARKER_INTERVAL's comment above):
 * split a long transcript across multiple requestSegments calls instead of
 * squeezing one oversized prompt to fit. 1300 words is a deliberate safety
 * margin, not a tight fit — measured directly (2026-09-09) against a
 * 2419-word video whose full-transcript prompt came in at 24375 chars /
 * ~8000-9800 tokens (the token count varies run to run for reasons not fully
 * pinned down, hence the margin) with ~10500 of those characters being the
 * fixed rules/glossary/metadata text every request pays regardless of chunk
 * size. 1300 words of transcript on top of that fixed cost lands well clear
 * of 8000 tokens even at the higher end of the observed ratio.
 *
 * Consecutive chunks overlap by 100 words so a segment whose real boundaries
 * straddle a chunk split isn't missed by both sides — each side may
 * independently propose it, which is fine: overlap between candidates is
 * already an accepted, expected outcome of this analyzer (see the "allowed
 * to overlap" rule in buildPrompt), not something that needs deduping here.
 */
const CHUNK_MAX_WORDS = 1300
const CHUNK_OVERLAP_WORDS = 100

function chunkWordRanges(totalWords: number): Array<{ start: number; end: number }> {
  if (totalWords <= CHUNK_MAX_WORDS) return [{ start: 0, end: totalWords }]
  const ranges: Array<{ start: number; end: number }> = []
  let start = 0
  while (start < totalWords) {
    const end = Math.min(start + CHUNK_MAX_WORDS, totalWords)
    ranges.push({ start, end })
    if (end >= totalWords) break
    start = end - CHUNK_OVERLAP_WORDS
  }
  return ranges
}

/**
 * The LLM ranks candidates purely by how engaging each one is on its own,
 * with no instruction to spread them across the video — observed in
 * practice (2026-08-28) to reliably converge on the same handful of
 * "obviously exciting" moments across repeated runs on the same video,
 * while other well-reasoned candidates elsewhere only surface inconsistently
 * (seemingly displacing one of that same core set, rather than the model
 * exploring differently each time). Left alone, a downstream consumer that
 * takes the top N candidates (once multi-clip generation exists) would keep
 * regenerating largely the same batch instead of the topic variety a user
 * actually wants from "give me several shorts from this video."
 *
 * Rather than trust prompt-level instructions to self-diversify (an easy
 * instruction for the model to deprioritize in favor of one more engaging
 * pick), this greedily reorders the LLM's own ranked list: take the
 * top-ranked candidate first, then repeatedly take the next-highest-ranked
 * remaining candidate whose midpoint is far enough from every candidate
 * already taken. Once every remaining candidate is too close to something
 * already picked, it falls back to pure engagement order for the rest — so
 * nothing is ever dropped, just pushed later in the list, which matters
 * once a downstream consumer caps how many it actually renders.
 */
const DIVERSITY_MIN_GAP_SECONDS = 90

function segmentMidpoint(segment: Segment): number {
  return (segment.startTime + segment.endTime) / 2
}

function diversifySegments(segments: Segment[]): Segment[] {
  const remaining = [...segments]
  const selected: Segment[] = []

  while (remaining.length > 0) {
    const pickIndex = remaining.findIndex((candidate) =>
      selected.every((s) => Math.abs(segmentMidpoint(candidate) - segmentMidpoint(s)) >= DIVERSITY_MIN_GAP_SECONDS)
    )
    const index = pickIndex === -1 ? 0 : pickIndex
    selected.push(remaining[index]!)
    remaining.splice(index, 1)
  }

  return selected
}

export const groqSegmentAnalyzer: SegmentAnalyzer = {
  async analyze(groq, words, videoDurationSeconds, metadata) {
    // Each chunk is analyzed as if it were its own short transcript (its own
    // duration, its own glossary matches) — word indices it returns are
    // local to that chunk, so `offset` shifts them back to the full video's
    // word array before any of the existing per-segment logic below (which
    // all operates on `words`, the full array) runs.
    const rawSegments: Array<{ s: z.infer<typeof llmSegmentResponseSchema>['segments'][number]; offset: number }> = []
    for (const { start, end } of chunkWordRanges(words.length)) {
      const chunkWords = words.slice(start, end)
      const chunkDuration = chunkWords[chunkWords.length - 1]!.end - chunkWords[0]!.start
      const parsed = await requestSegments(groq, chunkWords, chunkDuration, metadata)
      for (const s of parsed.segments) rawSegments.push({ s, offset: start })
    }

    const segments: Segment[] = []
    for (const { s, offset } of rawSegments) {
      const startIndex = snapStartIndexToSentenceStart(words, Math.min(s.startWordIndex + offset, words.length - 1))
      let endIndex = Math.min(Math.max(s.endWordIndex + offset, startIndex), words.length - 1)
      if (s.endsAtSentenceEnd) {
        endIndex = snapEndIndexToPause(words, startIndex, endIndex)
      }
      endIndex = findSentenceEnd(words, startIndex, endIndex)
      const startWord = words[startIndex]
      let endWord = words[endIndex]
      if (!startWord || !endWord || endWord.end <= startWord.start) continue

      if (endWord.end - startWord.start > MAX_SEGMENT_SECONDS) {
        // findSentenceEnd's pick doesn't fit the duration cap. Trim down to
        // where it does, then search backward from there for the nearest
        // real sentence end — a plain word-by-word decrement would land
        // wherever truncation happens to stop, undoing findSentenceEnd's
        // work and risking an ending like "Bear" (mid dangling phrase).
        let trimmedIndex = endIndex
        while (trimmedIndex > startIndex && words[trimmedIndex]!.end - startWord.start > MAX_SEGMENT_SECONDS) {
          trimmedIndex -= 1
        }
        let goodIndex = trimmedIndex
        while (goodIndex > startIndex && !hasSentenceEndingPunctuation(words[goodIndex]!.word)) {
          goodIndex -= 1
        }
        endIndex = goodIndex > startIndex ? goodIndex : trimmedIndex
        endWord = words[endIndex]
      }
      if (!endWord || endWord.end <= startWord.start) continue

      // The prompt already tells the model to avoid segments strung
      // together from multiple long pauses (see buildPrompt) — confirmed in
      // practice (2026-09-14) that it doesn't reliably follow that: a
      // 179-236s candidate was re-picked after the rule was added, still
      // 27.4s (48%) dead air across the same two gaps. Unlike a coherence
      // judgment, "how much of this segment is silence" is mechanically
      // measurable, so don't leave it to the model a second time — reject
      // deterministically.
      let deadAirSeconds = 0
      for (let i = startIndex + 1; i <= endIndex; i++) {
        const gap = words[i]!.start - words[i - 1]!.end
        if (gap >= DEAD_AIR_GAP_THRESHOLD_SECONDS) deadAirSeconds += gap
      }
      if (deadAirSeconds / (endWord.end - startWord.start) > MAX_DEAD_AIR_FRACTION) continue

      // Padding is meant to add trailing silence/breathing room after the
      // clip's own content ends, not to reach into whatever's said next. If
      // the next real word starts before the padding window would end (a
      // real example: "further." ended at 37.62s with the next sentence's
      // "I" starting at 37.62s too, zero gap), a flat padding value grabs a
      // fragment of that next word/sentence instead of actual silence — cap
      // it at the real gap to the next word so it never crosses that line.
      const padding = s.endsAtSentenceEnd ? SENTENCE_END_PADDING_SECONDS : QUICK_CUT_PADDING_SECONDS
      const nextWord = words[endIndex + 1]
      const maxPaddingBeforeNextWord = nextWord ? Math.max(0, nextWord.start - endWord.end) : Infinity
      const effectivePadding = Math.min(padding, maxPaddingBeforeNextWord)
      const endTime = Math.min(
        endWord.end + effectivePadding,
        videoDurationSeconds,
        startWord.start + MAX_SEGMENT_SECONDS
      )
      if (endTime - startWord.start < MIN_SEGMENT_SECONDS) continue

      segments.push(
        segmentSchema.parse({
          startTime: startWord.start,
          endTime,
          reason: s.reason,
          endsAtSentenceEnd: s.endsAtSentenceEnd
        })
      )
    }

    if (segments.length === 0) {
      throw new Error('Analyzer produced no usable segments after mapping word indices to timestamps')
    }

    return diversifySegments(segments)
  }
}
