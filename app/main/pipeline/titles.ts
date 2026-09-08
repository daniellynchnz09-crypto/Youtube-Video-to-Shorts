import type Groq from 'groq-sdk'
import { titleResponseSchema } from '../../../shared/schemas.js'
import type { VideoMetadata, WordTimestamp } from '../../../shared/types.js'
import { formatVideoMetadata } from './videoContext.js'
import { formatGlossaryForPrompt, matchGlossary } from './glossary.js'

/** Same swap-to-Claude seam as SegmentAnalyzer — see analyze.ts. */
export interface TitleGenerator {
  generate(
    groq: Groq,
    clipWords: WordTimestamp[],
    endsAtSentenceEnd: boolean,
    metadata?: VideoMetadata
  ): Promise<string>
}

export const groqTitleGenerator: TitleGenerator = {
  async generate(groq, clipWords, endsAtSentenceEnd, metadata) {
    const transcript = clipWords.map((w) => w.word).join(' ')

    // When the clip is a quick cut before a new topic (see analyze.ts), the
    // last stretch of transcript is often just a tease into something the
    // clip doesn't actually show — without this caveat the title generator
    // tends to latch onto that trailing line and title the clip on content
    // the viewer never gets to see.
    const endingNote = endsAtSentenceEnd
      ? ''
      : "\n\nNote: this transcript is cut off mid-thought right as a new topic is introduced — that final topic isn't actually explored in this clip. Base the title on what's substantially discussed, not on that trailing tease."

    // The clip transcript alone often can't convey what's on screen or what
    // a reference means (game jargon, level/creator names). The source
    // video's own metadata usually carries the correct proper nouns and
    // framing — give it to the model as context, but keep it clear the
    // title is for this clip, not the whole video.
    const metadataBlock = formatVideoMetadata(metadata)
    const contextNote = metadataBlock
      ? `\n\nContext — metadata from the full source video this clip is taken from. Use it to get names, terminology, and framing right (the transcript excerpt may not make them clear), but write the title for THIS clip's content, not the whole video:\n${metadataBlock}`
      : ''

    // the game terms in this clip, with their meanings and correct
    // spellings — the transcript mis-hears proper nouns and the model has no
    // way to know a "wave" is a game mode, not the ocean.
    const glossaryBlock = formatGlossaryForPrompt(matchGlossary(transcript))
    const glossaryNote = glossaryBlock
      ? `\n\nthe game terms in this clip (this channel plays the game — use the correct spelling, and don't build a title on a misreading of one of these):\n${glossaryBlock}`
      : ''

    const completion = await groq.chat.completions.create({
      model: 'openai/gpt-oss-120b',
      messages: [
        {
          role: 'user',
          content: `Write one short, clickable, attention-grabbing title for a vertical short-form video clip based on this transcript excerpt. Explain what the clip is about while staying intriguing.

Base the title on what's substantially discussed across most of the clip's runtime. Even when the transcript ends on a complete, well-formed sentence, don't build the title around a detail, question, or hook that only shows up in that closing line — if that subject isn't also present earlier in the transcript, it's not representative of the clip and shouldn't drive the title.${contextNote}${glossaryNote}

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
