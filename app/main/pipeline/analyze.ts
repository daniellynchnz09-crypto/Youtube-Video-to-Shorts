import type Groq from 'groq-sdk'
import { segmentAnalysisResponseSchema, type Segment } from '../../../shared/schemas.js'
import type { WordTimestamp } from '../../../shared/types.js'

/**
 * The analysis step behind an interface, per Claude.md's expandability note:
 * swapping this from Groq to Claude later should mean writing one new
 * implementation of this interface, not touching the rest of the pipeline.
 */
export interface SegmentAnalyzer {
  analyze(groq: Groq, words: WordTimestamp[], videoDurationSeconds: number): Promise<Segment[]>
}

function buildPrompt(words: WordTimestamp[], videoDurationSeconds: number): string {
  const maxSegments = Math.min(50, Math.max(3, Math.round(videoDurationSeconds / 60)))
  const transcriptLines = words.map((w) => `${w.word}\t${w.start.toFixed(2)}\t${w.end.toFixed(2)}`).join('\n')

  return `You are selecting the most engaging, viral-worthy segments from a video transcript to turn into vertical short-form clips.

Rules:
- Each segment must be between 15 and 60 seconds long.
- Return between 3 and ${maxSegments} segments, ranked most engaging first.
- Segments must not overlap.
- Base start/end times on the word timestamps below (seconds, relative to the source video).

Transcript (word, start, end):
${transcriptLines}

Respond with ONLY JSON matching this shape:
{ "segments": [{ "startTime": number, "endTime": number, "reason": string }] }`
}

export const groqSegmentAnalyzer: SegmentAnalyzer = {
  async analyze(groq, words, videoDurationSeconds) {
    const completion = await groq.chat.completions.create({
      model: 'llama-3.3-70b-versatile',
      messages: [{ role: 'user', content: buildPrompt(words, videoDurationSeconds) }],
      response_format: { type: 'json_object' }
    })

    const raw = completion.choices[0]?.message?.content ?? '{}'
    const parsed = segmentAnalysisResponseSchema.parse(JSON.parse(raw))
    return parsed.segments
  }
}
