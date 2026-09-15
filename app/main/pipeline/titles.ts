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
    segmentReason: string,
    metadata?: VideoMetadata
  ): Promise<string>
}

export const groqTitleGenerator: TitleGenerator = {
  async generate(groq, clipWords, endsAtSentenceEnd, segmentReason, metadata) {
    const transcript = clipWords.map((w) => w.word).join(' ')

    // The analyzer already judged *why* this moment is engaging (see
    // analyze.ts's `reason` field) — observed directly (2026-09-08 review) to
    // sometimes already be a better title than what this step generates on
    // its own from the raw transcript. Feed it in as grounding, not something
    // to just restate.
    const reasonNote = `\n\nWhy this moment was selected as a candidate clip (for context on what's actually engaging about it — don't just restate this verbatim as the title). This description can make two separate things in the clip sound more connected than they really are — check any causal or explanatory link it implies against the transcript itself before building a title on it:\n${segmentReason}`

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

    // Glossary terms in this clip, with their meanings and correct spellings —
    // the transcript mis-hears proper nouns and the model has no way to know a
    // game-specific word isn't being used in its everyday sense.
    const glossaryBlock = formatGlossaryForPrompt(matchGlossary(transcript))
    const glossaryNote = glossaryBlock
      ? `\n\nThe channel covers one specific video game. Its glossary terms that appear in this clip (use the correct spelling, and don't build a title on a misreading of one of these):\n${glossaryBlock}`
      : ''

    const completion = await groq.chat.completions.create({
      model: 'openai/gpt-oss-120b',
      messages: [
        {
          role: 'user',
          content: `Write one short, clickable, attention-grabbing title for a vertical short-form video clip based on this transcript excerpt. Explain what the clip is about while staying intriguing.

Prefer a single plain, declarative statement of what actually happens over stacking a mechanic name + manufactured stakes word + exclamation into one line (e.g. avoid a manufactured stakes word like "Nightmare" that isn't earned by the transcript, or a colon-stacked "X: Y!" format that reads as generic clickbait). A title can still hold back the resolution as a hook — e.g. "This Mistake Cost Me a New Record" states the situation plainly but leaves whether they recovered as the reason to watch — but don't go so vague or cryptic that it's unclear what the clip is even about.

Two glossary terms appearing near each other in the transcript are not necessarily one combined thing — don't mash them into an invented compound name (e.g. treating two separate glossary entries as if they were one named combination) unless the glossary itself defines them together. Describe the relationship in plain words instead.

A specific level/character name from the glossary isn't mandatory in every title — if naming it out of context would read as ambiguous (e.g. a level name that could be misread as an object or action rather than a place), it's fine to leave it out and describe the moment more generally instead. Correct-but-confusing is not better than vaguer-but-clear.

Don't personify a game mechanic or obstacle as an opponent with intent (e.g. a gamemode "beating" the player) unless the transcript is genuinely describing it that way — most of these are physics/level elements, not agents making decisions.

Focus the title on ONE central aspect of the clip, not a list of separate things that happen to occur in it. If the clip contains two moments that aren't actually connected (e.g. the speaker notices something incidental, and separately works out an unrelated fact later on), pick whichever one the clip is actually about rather than mashing both into one title — a title that reads as "X and Y" is a sign two unrelated beats got stitched together instead of one being chosen.

When the title states a cause ("X leaves me Y", "I'm Z because of W"), that cause must be one the speaker actually gives, not just an action mentioned somewhere nearby in the transcript. If the speaker states their own reason for a feeling or reaction — even if it's a vaguer, less specific-sounding line than some other detail nearby — use THAT stated reason. A concrete, vivid-sounding incidental action (a single mistake, a specific object) is not automatically the real cause just because it's more quotable than the speaker's own plainer explanation.

If the transcript clearly covers two separate, unrelated beats — one activity or topic ending and a different, unrelated one starting (e.g. quitting one level, then opening a completely different one afterward) — don't write a title that implies they're one connected narrative (e.g. describing the second topic as if it happened as part of the first). Base the title on whichever side has more substance, the same way the clip itself should.

Base the title on what's substantially discussed across most of the clip's runtime. Even when the transcript ends on a complete, well-formed sentence, don't build the title around a detail, question, or hook that only shows up in that closing line — if that subject isn't also present earlier in the transcript, it's not representative of the clip and shouldn't drive the title.${contextNote}${glossaryNote}${reasonNote}

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
