import { createReadStream } from 'node:fs'
import type Groq from 'groq-sdk'
import type { WordTimestamp } from '../../../shared/types.js'

export interface TranscriptionResult {
  words: WordTimestamp[]
  durationSeconds: number
}

/**
 * groq-sdk's shipped types only declare `{ text: string }` for the
 * transcription response, but requesting verbose_json with word-level
 * timestamps actually returns this shape (per Groq's speech-to-text docs).
 */
interface WhisperVerboseJsonResponse {
  duration: number
  words?: Array<{ word: string; start: number; end: number }>
}

export async function transcribeAudio(groq: Groq, audioPath: string): Promise<TranscriptionResult> {
  const response = await groq.audio.transcriptions.create({
    file: createReadStream(audioPath),
    model: 'whisper-large-v3',
    response_format: 'verbose_json',
    timestamp_granularities: ['word']
  })

  const data = response as unknown as WhisperVerboseJsonResponse

  const words: WordTimestamp[] = (data.words ?? []).map((w) => ({
    word: w.word,
    start: w.start,
    end: w.end
  }))

  return { words: normalizeWordTimestamps(words), durationSeconds: data.duration ?? 0 }
}

/**
 * Whisper's word-level timestamps come from a forced-alignment pass that can
 * fail on fast/overlapping speech (observed on this channel's gameplay audio,
 * likely game SFX bleeding into the alignment). Two failure shapes seen in
 * practice: (1) a run of words crammed into a near-zero-duration window, and
 * (2) a word's start landing *before* the previous word has even finished
 * (a real example: "Crypt" started at 11.78s while the prior word "give" ran
 * until 12.20s). Left alone, both make karaoke subtitles flash through
 * several words almost instantly and then show nothing while the speaker is
 * still talking.
 *
 * Fixed in one forward pass: if a word starts before the previous one ends,
 * push it (keeping its own original duration) to start right where the
 * previous word ends; then, regardless of that, floor every word to a
 * minimum plausible spoken duration. Each fix naturally cascades into the
 * next word via the updated `prev.end`, so a whole crammed run gets spread
 * back out rather than just the first offender in it.
 */
const MIN_PLAUSIBLE_WORD_DURATION_SECONDS = 0.1

function normalizeWordTimestamps(words: WordTimestamp[]): WordTimestamp[] {
  const result = words.map((w) => ({ ...w }))
  for (let i = 0; i < result.length; i++) {
    const cur = result[i]!
    if (i > 0) {
      const prevEnd = result[i - 1]!.end
      if (cur.start < prevEnd) {
        const originalDuration = Math.max(cur.end - cur.start, 0)
        cur.start = prevEnd
        cur.end = cur.start + originalDuration
      }
    }
    if (cur.end - cur.start < MIN_PLAUSIBLE_WORD_DURATION_SECONDS) {
      cur.end = cur.start + MIN_PLAUSIBLE_WORD_DURATION_SECONDS
    }
  }
  return result
}
