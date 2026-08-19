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
- When estimating endWordIndex, err toward landing a couple words early rather than late. Overshooting past the true end of the thought and into the next topic is worse than ending a beat sooner — the intended sentence/thought must not have any of the following topic's words bleeding into the clip.
- Watch for false starts and stutters (e.g. "I'd probably be I'd probably be") — a repeated/incomplete phrase followed by a pause usually means the speaker is still collecting their thoughts mid-sentence, not concluding one. Don't let endWordIndex land there. Prefer pushing endWordIndex past the pause to include how the speaker actually finishes the thought, but only if that still fits the 15-60s limit above — if including the real completion would push the segment past 60s, end the segment earlier instead, before the repeated phrase begins, rather than breaking the duration limit.
- For each segment, also decide endsAtSentenceEnd: true if endWordIndex is genuinely the end of a full sentence/thought with nothing relevant said immediately after (the clip can afford a little breathing room there); false if you're cutting there specifically to stop before the speaker moves on to something new mid-sentence/mid-breath (the cut needs to be tight so the next topic doesn't bleed in).

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

export const groqSegmentAnalyzer: SegmentAnalyzer = {
  async analyze(groq, words, videoDurationSeconds) {
    const completion = await groq.chat.completions.create({
      model: 'openai/gpt-oss-120b',
      messages: [{ role: 'user', content: buildPrompt(words, videoDurationSeconds) }],
      response_format: { type: 'json_object' }
    })

    const raw = completion.choices[0]?.message?.content ?? '{}'
    const parsed = llmSegmentResponseSchema.parse(JSON.parse(raw))

    const segments: Segment[] = []
    for (const s of parsed.segments) {
      const startIndex = Math.min(s.startWordIndex, words.length - 1)
      let endIndex = Math.min(Math.max(s.endWordIndex, startIndex), words.length - 1)
      if (s.endsAtSentenceEnd) {
        endIndex = snapEndIndexToPause(words, startIndex, endIndex)
      }
      const startWord = words[startIndex]
      let endWord = words[endIndex]
      if (!startWord || !endWord || endWord.end <= startWord.start) continue

      while (endIndex > startIndex && endWord!.end - startWord.start > MAX_SEGMENT_SECONDS) {
        endIndex -= 1
        endWord = words[endIndex]
      }
      if (!endWord || endWord.end <= startWord.start) continue

      const padding = s.endsAtSentenceEnd ? SENTENCE_END_PADDING_SECONDS : QUICK_CUT_PADDING_SECONDS
      const endTime = Math.min(
        endWord.end + padding,
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
