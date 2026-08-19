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

const MARKER_INTERVAL = 20
/** Small trailing buffer so a clip doesn't audibly/visually cut off mid-word
 * when the last word's timestamp is slightly optimistic. */
const END_PADDING_SECONDS = 0.4

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
  const transcript = words
    .map((w, i) => (i % MARKER_INTERVAL === 0 ? `«${i}»${w.word}` : w.word))
    .join(' ')

  return `You are selecting the most engaging, viral-worthy segments from a video transcript to turn into vertical short-form clips.

The transcript below has a word-index marker like «140» before every ${MARKER_INTERVAL}th word, so you can reference positions without counting every word yourself.

Rules:
- Each segment must correspond to roughly 15-60 seconds of speech.
- Return between 3 and ${maxSegments} segments, ranked most engaging first.
- Segments must not overlap.
- startWordIndex/endWordIndex should be your best estimate of the actual word position — interpolate between the nearest markers.
- Critical: pick boundaries that give the clip an obvious beginning and end. startWordIndex must land at (or very near) the start of a complete sentence or thought — not mid-sentence, so the viewer isn't dropped in without context. endWordIndex must land at (or very near) the end of a complete sentence or thought — not cut off mid-idea.

Transcript (${words.length} words total, video is ${videoDurationSeconds.toFixed(0)}s long):
${transcript}

Respond with ONLY JSON matching this shape:
{ "segments": [{ "startWordIndex": number, "endWordIndex": number, "reason": string }] }`
}

const llmSegmentResponseSchema = z.object({
  segments: z
    .array(
      z.object({
        startWordIndex: z.number().int().nonnegative(),
        endWordIndex: z.number().int().nonnegative(),
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
      const endIndex = Math.min(Math.max(s.endWordIndex, startIndex), words.length - 1)
      const startWord = words[startIndex]
      const endWord = words[endIndex]
      if (!startWord || !endWord || endWord.end <= startWord.start) continue

      segments.push(
        segmentSchema.parse({
          startTime: startWord.start,
          endTime: Math.min(endWord.end + END_PADDING_SECONDS, videoDurationSeconds),
          reason: s.reason
        })
      )
    }

    if (segments.length === 0) {
      throw new Error('Analyzer produced no usable segments after mapping word indices to timestamps')
    }

    return segments
  }
}
