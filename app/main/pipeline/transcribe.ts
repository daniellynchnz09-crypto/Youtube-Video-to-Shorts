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
 * likely game SFX bleeding into the alignment) — when it fails, several words
 * in a row land on near-identical timestamps (e.g. 10 words crammed into
 * 0.2s) instead of spreading across when they were actually spoken. Left
 * alone, this makes karaoke subtitles flash through a burst of words almost
 * instantly and then show nothing while the audio is still catching up.
 * Detects those degenerate runs and spreads them back out (proportional to
 * word length) across the real gap until the next trustworthy timestamp.
 */
const BURST_WORD_MAX_DURATION_SECONDS = 0.05
const BURST_GAP_MAX_SECONDS = 0.05
const BURST_MIN_RUN_LENGTH = 3
const MIN_REDISTRIBUTED_WORD_SECONDS = 0.12
const MAX_REDISTRIBUTED_WORD_SECONDS = 0.6
const BURST_TRAILING_GAP_FRACTION = 0.15

function normalizeWordTimestamps(words: WordTimestamp[]): WordTimestamp[] {
  const result = words.map((w) => ({ ...w }))
  let i = 0
  while (i < result.length) {
    let j = i
    while (
      j < result.length &&
      result[j]!.end - result[j]!.start <= BURST_WORD_MAX_DURATION_SECONDS &&
      (j === i || result[j]!.start - result[j - 1]!.end <= BURST_GAP_MAX_SECONDS)
    ) {
      j++
    }
    if (j - i >= BURST_MIN_RUN_LENGTH) {
      redistributeBurst(result, i, j)
      i = j
    } else {
      i++
    }
  }
  return result
}

/** Spreads result[start..end) evenly (by word length) across real time. `end` is exclusive. */
function redistributeBurst(words: WordTimestamp[], start: number, end: number): void {
  const burstStart = words[start]!.start
  const nextWord = words[end]
  const runLength = end - start
  const rawWindow = nextWord
    ? nextWord.start - burstStart
    : runLength * MAX_REDISTRIBUTED_WORD_SECONDS
  const usableWindow = Math.max(
    nextWord ? rawWindow * (1 - BURST_TRAILING_GAP_FRACTION) : rawWindow,
    MIN_REDISTRIBUTED_WORD_SECONDS * runLength
  )

  const lengths: number[] = []
  for (let k = start; k < end; k++) lengths.push(Math.max(words[k]!.word.trim().length, 1))
  const totalChars = lengths.reduce((a, b) => a + b, 0)

  let cursor = burstStart
  for (let k = start; k < end; k++) {
    const share = lengths[k - start] / totalChars
    const duration = Math.min(
      Math.max(usableWindow * share, MIN_REDISTRIBUTED_WORD_SECONDS),
      MAX_REDISTRIBUTED_WORD_SECONDS
    )
    words[k]!.start = cursor
    words[k]!.end = cursor + duration
    cursor += duration
  }
}
