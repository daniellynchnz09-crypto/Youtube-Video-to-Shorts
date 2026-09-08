import type { VideoMetadata } from '../../../shared/types.js'
import { glossaryHintNames } from './glossary.js'

/**
 * Formats the source video's metadata into a compact block for the analyzer
 * and title prompts. Descriptions run long (link dumps, socials, timestamps),
 * so they're truncated — the useful context is almost always in the opening
 * lines. Returns '' when there's nothing usable, so callers can drop the
 * whole context section rather than emit empty headings.
 */
const MAX_DESCRIPTION_CHARS = 700
const MAX_TAGS = 30

/**
 * Trims the boilerplate tail off a YouTube description — social links, a
 * "Discord"/"Timestamps" heading, or the first bare URL. What's left is the
 * part that actually describes the video, which is all the prompts and the
 * transcription hint want.
 */
function usefulDescription(description: string): string {
  const lines = description.split(/\r?\n/)
  const cut = lines.findIndex((l) =>
    /^\s*(discord|my discord( server)?|socials?|follow me|links?|timestamps?|chapters?|music|song list|credits?)\s*:?\s*$/i.test(
      l
    ) || /https?:\/\//i.test(l)
  )
  return (cut === -1 ? lines : lines.slice(0, cut)).join('\n').trim()
}

export function formatVideoMetadata(metadata: VideoMetadata | undefined): string {
  if (!metadata) return ''
  const lines: string[] = []

  const title = metadata.title.trim()
  if (title) lines.push(`Video title: ${title}`)

  const description = usefulDescription(metadata.description.trim())
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
 *
 * A short list of the game proper nouns from the glossary is prepended
 * (level and player names Whisper otherwise mangles). The video-specific
 * metadata prose stays LAST so it survives Whisper's ~224-token tail
 * truncation when the whole prompt runs long — the glossary list is generic
 * fallback coverage, the metadata names the level this video is actually
 * about.
 */
const MAX_HINT_CHARS = 700
const MAX_GLOSSARY_HINT_CHARS = 260

function metadataProse(metadata: VideoMetadata): string {
  const title = metadata.title.trim()
  const description = usefulDescription(metadata.description.trim())

  let prose = [title, description].filter(Boolean).join('. ')
  if (!prose) return ''

  if (prose.length > MAX_HINT_CHARS) prose = prose.slice(0, MAX_HINT_CHARS)

  const lastSentenceEnd = Math.max(prose.lastIndexOf('.'), prose.lastIndexOf('!'), prose.lastIndexOf('?'))
  if (lastSentenceEnd >= 40) prose = prose.slice(0, lastSentenceEnd + 1)
  else if (!/[.!?]$/.test(prose)) prose += '.'

  return prose.trim()
}

export function buildTranscriptionHint(metadata: VideoMetadata | undefined): string {
  const prose = metadata ? metadataProse(metadata) : ''

  let names = glossaryHintNames()
  if (names.length > MAX_GLOSSARY_HINT_CHARS) {
    names = names.slice(0, MAX_GLOSSARY_HINT_CHARS)
    names = names.slice(0, names.lastIndexOf(','))
  }
  const namesSentence = names ? `the game names that may come up: ${names}.` : ''

  return [namesSentence, prose].filter(Boolean).join('\n').trim()
}
