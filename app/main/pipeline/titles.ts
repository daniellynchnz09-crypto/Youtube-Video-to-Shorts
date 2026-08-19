import type Groq from 'groq-sdk'
import { titleResponseSchema } from '../../../shared/schemas.js'
import type { WordTimestamp } from '../../../shared/types.js'

/** Same swap-to-Claude seam as SegmentAnalyzer — see analyze.ts. */
export interface TitleGenerator {
  generate(groq: Groq, clipWords: WordTimestamp[]): Promise<string>
}

export const groqTitleGenerator: TitleGenerator = {
  async generate(groq, clipWords) {
    const transcript = clipWords.map((w) => w.word).join(' ')

    const completion = await groq.chat.completions.create({
      model: 'openai/gpt-oss-120b',
      messages: [
        {
          role: 'user',
          content: `Write one short, clickable, attention-grabbing title for a vertical short-form video clip based on this transcript excerpt. Explain what the clip is about while staying intriguing.

Transcript:
${transcript}

Respond with ONLY JSON matching: { "title": string }`
        }
      ],
      response_format: { type: 'json_object' }
    })

    const raw = completion.choices[0]?.message?.content ?? '{}'
    return titleResponseSchema.parse(JSON.parse(raw)).title
  }
}
