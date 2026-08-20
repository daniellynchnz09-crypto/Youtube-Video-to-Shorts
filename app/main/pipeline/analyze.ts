import type Groq from 'groq-sdk'
import { z } from 'zod'
import { segmentSchema, type Segment } from '../../../shared/schemas.js'
import type { WordTimestamp } from '../../../shared/types.js'

/**
 * The analysis step behind an interface, per Claude.md's expandability note:
 * swapping this from Groq to Claude later should mean writing one new
 * implementation of this interface, not touching the rest of the pipeline.
 */
export interface SegmentAnalyzer {
  analyze(groq: Groq, words: WordTimestamp[], videoDurationSeconds: number): Promise<Segment[]>
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
 * Groq's free tier caps openai/gpt-oss-120b at 8000 tokens/minute — sending a
 * timestamp on every single word blew way past that on anything longer than
 * a couple minutes (a 17-minute/1931-word video alone needed ~20k tokens).
 * Instead: plain transcript text with a sparse word-index marker every
 * MARKER_INTERVAL words for grounding, and the LLM answers with word
 * indices (not seconds) — actual timestamps get looked up locally from the
 * `words` array afterward, so a little index imprecision from the sparse
 * markers just means a few words of slop at a clip boundary, not wrong data.
 */
function buildPrompt(words: WordTimestamp[], videoDurationSeconds: number): string {
  const maxSegments = Math.min(50, Math.max(3, Math.round(videoDurationSeconds / 60)))
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

  return `You are selecting the most engaging, viral-worthy segments from a video transcript to turn into vertical short-form clips.

The transcript below has a word-index marker like «140» before every ${MARKER_INTERVAL}th word, so you can reference positions without counting every word yourself. It also has inline markers like ‖pause 1.3s‖ wherever the speaker paused that long before their next word.

Rules:
- Each segment must correspond to roughly 15-60 seconds of speech.
- Return between 3 and ${maxSegments} segments, ranked most engaging first.
- Segments must not overlap.
- startWordIndex/endWordIndex should be your best estimate of the actual word position — interpolate between the nearest markers.
- Critical: pick boundaries that give the clip an obvious beginning and end. startWordIndex must land at (or very near) the start of a complete sentence or thought — not mid-sentence, so the viewer isn't dropped in without context. endWordIndex must land at (or very near) the end of a complete sentence or thought — not cut off mid-idea.
- Beyond just the boundaries, the segment as a whole should cover one coherent moment or topic, not just start and end cleanly. Watch specifically for a segment that straddles the tail end of one activity/topic and the start of a completely unrelated one (e.g. barely a comment on finishing one thing, then moving straight into commentary on something unrelated) — even with clean sentence boundaries on both ends, a segment like that lacks a real throughline and reads as unfocused. When a candidate segment would straddle that kind of seam, prefer shifting it to sit entirely within whichever side has more substance, rather than spanning both.
- Critical: if the segment sets up a question, wager, spin/roll, prediction, or any other moment that's clearly about to be resolved, you MUST include that resolution — never end the segment right after the setup line and before the payoff. For example, if the speaker says something like "let's see what this lands on" or "let's find out what I'm doing today," the very next thing they say — the actual result — has to be inside the segment too, even if it means extending endWordIndex past where the setup sentence itself ends. Ending right before a reveal like this is one of the worst outcomes for a clip, regardless of how clean the sentence boundary looks in isolation — check specifically for this pattern before finalizing endWordIndex. If the resolution turns out to be too far away to fit within 60s, don't use that starting point at all rather than presenting an unresolved setup.
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
  videoDurationSeconds: number
): Promise<z.infer<typeof llmSegmentResponseSchema>> {
  let lastError: unknown
  for (let attempt = 1; attempt <= ANALYZE_MAX_ATTEMPTS; attempt++) {
    try {
      const completion = await groq.chat.completions.create({
        model: 'openai/gpt-oss-120b',
        messages: [{ role: 'user', content: buildPrompt(words, videoDurationSeconds) }],
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

export const groqSegmentAnalyzer: SegmentAnalyzer = {
  async analyze(groq, words, videoDurationSeconds) {
    const parsed = await requestSegments(groq, words, videoDurationSeconds)

    const segments: Segment[] = []
    for (const s of parsed.segments) {
      const startIndex = Math.min(s.startWordIndex, words.length - 1)
      let endIndex = Math.min(Math.max(s.endWordIndex, startIndex), words.length - 1)
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

    return segments
  }
}
