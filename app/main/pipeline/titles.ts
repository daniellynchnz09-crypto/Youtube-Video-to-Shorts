import type Groq from 'groq-sdk'
import { titleResponseSchema } from '../../../shared/schemas.js'
import type { WordTimestamp } from '../../../shared/types.js'

/** Same swap-to-Claude seam as SegmentAnalyzer — see analyze.ts. */
export interface TitleGenerator {
  generate(groq: Groq, clipWords: WordTimestamp[], endsAtSentenceEnd: boolean): Promise<string>
}

export const groqTitleGenerator: TitleGenerator = {
  async generate(groq, clipWords, endsAtSentenceEnd) {
    const transcript = clipWords.map((w) => w.word).join(' ')

    // When the clip is a quick cut before a new topic (see analyze.ts), the
    // last stretch of transcript is often just a tease into something the
    // clip doesn't actually show — without this caveat the title generator
    // tends to latch onto that trailing line and title the clip on content
    // the viewer never gets to see.
    const endingNote = endsAtSentenceEnd
      ? ''
      : "\n\nNote: this transcript is cut off mid-thought right as a new topic is introduced — that final topic isn't actually explored in this clip. Base the title on what's substantially discussed, not on that trailing tease."

    const completion = await groq.chat.completions.create({
      model: 'openai/gpt-oss-120b',
      messages: [
        {
          role: 'user',
          content: `Write one short, clickable, attention-grabbing title for a vertical short-form video clip based on this transcript excerpt. Explain what the clip is about while staying intriguing.

Base the title on what's substantially discussed across most of the clip's runtime. Even when the transcript ends on a complete, well-formed sentence, don't build the title around a detail, question, or hook that only shows up in that closing line — if that subject isn't also present earlier in the transcript, it's not representative of the clip and shouldn't drive the title.

Transcript:
${transcript}${endingNote}

Respond with ONLY JSON matching: { "title": string }`
        }
      ],
      response_format: { type: 'json_object' }
    })

    const raw = completion.choices[0]?.message?.content ?? '{}'
    return titleResponseSchema.parse(JSON.parse(raw)).title
  }
}
