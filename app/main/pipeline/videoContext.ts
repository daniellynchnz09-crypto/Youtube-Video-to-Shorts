import type { VideoMetadata } from '../../../shared/types.js'

/**
 * Formats the source video's metadata into a compact block for the analyzer
 * and title prompts. Descriptions run long (link dumps, socials, timestamps),
 * so they're truncated — the useful context is almost always in the opening
 * lines. Returns '' when there's nothing usable, so callers can drop the
 * whole context section rather than emit empty headings.
 */
const MAX_DESCRIPTION_CHARS = 700
const MAX_TAGS = 30

export function formatVideoMetadata(metadata: VideoMetadata | undefined): string {
  if (!metadata) return ''
  const lines: string[] = []

  const title = metadata.title.trim()
  if (title) lines.push(`Video title: ${title}`)

  const description = metadata.description.trim()
  if (description) {
    const trimmed =
      description.length > MAX_DESCRIPTION_CHARS
        ? `${description.slice(0, MAX_DESCRIPTION_CHARS).trimEnd()}…`
        : description
    lines.push(`Video description: ${trimmed}`)
  }

  if (metadata.tags.length > 0) {
    lines.push(`Video tags: ${metadata.tags.slice(0, MAX_TAGS).join(', ')}`)
  }

  return lines.join('\n')
}

/**
 * Builds a Whisper `initial_prompt` hint from the video metadata, to bias
 * transcription toward the correct spelling of proper nouns it would
 * otherwise mangle (level names, creator names, game jargon it's never
 * heard — a real case: "a level" came out as "a level"/"a level", "a player"
 * as "a player"). `initial_prompt` is a soft bias with roughly a
 * 224-token budget, and Whisper does best with natural prose that matches
 * the expected speaking style, so this uses the uploader's title +
 * description (correct casing and spelling) and deliberately NOT the raw
 * tag list — the tags on real videos contain misspellings ("a level",
 * "achnes") that would bias transcription the wrong way.
 *
 * The hint MUST end on a complete sentence. Whisper treats the prompt as
 * text preceding the audio and will "continue" a dangling clause — observed
 * 2026-09-02: a 600-char cut landed on "...but all", and the transcript came
 * back opening with a hallucinated "the time it was not verified by a player,
 * so I decided to make this video about it." that was never spoken. Trimming
 * back to the last sentence-ending punctuation makes the prompt read as
 * finished text rather than a lead-in. Returns '' when there's nothing usable.
 */
const MAX_HINT_CHARS = 700

export function buildTranscriptionHint(metadata: VideoMetadata | undefined): string {
  if (!metadata) return ''
  const title = metadata.title.trim()
  const description = metadata.description.trim()

  let hint = [title, description].filter(Boolean).join('. ')
  if (!hint) return ''

  if (hint.length > MAX_HINT_CHARS) hint = hint.slice(0, MAX_HINT_CHARS)

  const lastSentenceEnd = Math.max(hint.lastIndexOf('.'), hint.lastIndexOf('!'), hint.lastIndexOf('?'))
  if (lastSentenceEnd >= 40) hint = hint.slice(0, lastSentenceEnd + 1)
  else if (!/[.!?]$/.test(hint)) hint += '.'

  return hint.trim()
}
