import { createReadStream } from 'node:fs'
import type Groq from 'groq-sdk'
import type { WordTimestamp } from '../../../shared/types.js'

export interface TranscriptionResult {
  words: WordTimestamp[]
  durationSeconds: number
}

/**
 * groq-sdk's shipped types only declare `{ text: string }` for the
 * transcription response, but requesting verbose_json actually returns this
 * shape (per Groq's speech-to-text docs) — `segments` is present regardless
 * of timestamp_granularities (it's verbose_json's base level of detail;
 * `words` is the opt-in addition on top of it), and carries Whisper's own
 * confidence signals per segment.
 */
interface WhisperSegment {
  start: number
  end: number
  avg_logprob: number
  no_speech_prob: number
}
interface WhisperVerboseJsonResponse {
  duration: number
  words?: Array<{ word: string; start: number; end: number }>
  segments?: WhisperSegment[]
}

/**
 * Whisper occasionally hallucinates a phrase onto unclear/mumbled audio
 * instead of transcribing it — a real example: the audio at the very start
 * of a clip was unintelligible, and Whisper transcribed it as "I think I'm
 * cracked today," a near-duplicate of a genuine "I think I'm cracked. Only
 * today though." said ~20s later. Confirmed via segment-level metadata: both
 * segments had literally identical avg_logprob/no_speech_prob, and the
 * hallucinated one's avg_logprob (-0.72) was notably worse than a normal,
 * correctly-transcribed neighboring segment (-0.31) — Whisper's own signal
 * that it wasn't confident. Words whose segment falls below this threshold
 * are dropped entirely rather than trusted, since wrong text is worse than
 * a small transcript gap (both the analyzer and the subtitle renderer
 * already tolerate small gaps).
 *
 * That last assumption broke on a longer low-confidence stretch: three
 * consecutive segments spanning ~24s all shared the exact same degraded
 * avg_logprob/no_speech_prob (same failure signature as above, just
 * sustained rather than a one-off), and dropping every word in all three
 * left the clip with a 26-second dead stretch of no subtitles at all despite
 * the speaker actually talking throughout — reported as subtitles vanishing
 * for a long block. A short hallucinated phrase is forgivable to drop; a
 * multi-second on-screen blackout is worse than showing imperfect text, so
 * dropping is now capped to a single *contiguous* low-confidence stretch of
 * at most this long — a longer stretch is left alone (kept, warts and all)
 * rather than blanked out.
 */
const LOW_CONFIDENCE_AVG_LOGPROB_THRESHOLD = -0.6
const MAX_DROPPABLE_LOW_CONFIDENCE_SECONDS = 6

export async function transcribeAudio(groq: Groq, audioPath: string): Promise<TranscriptionResult> {
  const response = await groq.audio.transcriptions.create({
    file: createReadStream(audioPath),
    model: 'whisper-large-v3',
    response_format: 'verbose_json',
    // 'segment' must be requested explicitly alongside 'word' — Groq returns
    // segments: null (no confidence data at all) if only 'word' is asked for.
    timestamp_granularities: ['word', 'segment']
  } as Parameters<typeof groq.audio.transcriptions.create>[0])

  const data = response as unknown as WhisperVerboseJsonResponse

  const words: WordTimestamp[] = (data.words ?? []).map((w) => ({
    word: w.word,
    start: w.start,
    end: w.end
  }))

  const confident = dropLowConfidenceWords(words, data.segments ?? [])
  return { words: normalizeWordTimestamps(confident), durationSeconds: data.duration ?? 0 }
}

function dropLowConfidenceWords(words: WordTimestamp[], segments: WhisperSegment[]): WordTimestamp[] {
  const lowConfidenceRanges = segments
    .filter((s) => s.avg_logprob < LOW_CONFIDENCE_AVG_LOGPROB_THRESHOLD)
    .sort((a, b) => a.start - b.start)
  if (lowConfidenceRanges.length === 0) return words

  const merged = mergeNearbyRanges(lowConfidenceRanges)
  const droppableRanges = merged.filter((r) => r.end - r.start <= MAX_DROPPABLE_LOW_CONFIDENCE_SECONDS)
  if (droppableRanges.length === 0) return words

  return words.filter((w) => !droppableRanges.some((r) => w.start >= r.start && w.start < r.end))
}

/**
 * Merges low-confidence ranges that are close together, not just literally
 * overlapping. The 26s dead-subtitle case turned out to be three separate
 * low-confidence segments with a few seconds of genuine silence between
 * each — merging only true overlaps left two of the three individually
 * under the drop cap while treating them as isolated, when from a viewer's
 * perspective a cluster of unreliable segments this close together is one
 * unreliable stretch, not three independent short ones.
 */
const RANGE_MERGE_GAP_SECONDS = 5

function mergeNearbyRanges(
  ranges: Array<{ start: number; end: number }>,
  gapSeconds = RANGE_MERGE_GAP_SECONDS
): Array<{ start: number; end: number }> {
  const merged: Array<{ start: number; end: number }> = []
  for (const r of ranges) {
    const last = merged[merged.length - 1]
    if (last && r.start - last.end <= gapSeconds) {
      last.end = Math.max(last.end, r.end)
    } else {
      merged.push({ start: r.start, end: r.end })
    }
  }
  return merged
}

/**
 * Whisper's word-level timestamps come from a forced-alignment pass that can
 * fail on fast/overlapping speech (observed on this channel's gameplay audio,
 * likely game SFX bleeding into the alignment). Three failure shapes seen in
 * practice: (1) a run of words crammed into a near-zero-duration window, (2)
 * a word's start landing *before* the previous word has even finished (a
 * real example: "Crypt" started at 11.78s while the prior word "give" ran
 * until 12.20s), and (3) Whisper silently dropping a repeated/self-corrected
 * phrase from the transcript entirely (e.g. the audio said "especially how,
 * I love how..." but the transcript just says "I love how...") — when that
 * happens, the alignment attributes the dropped phrase's audio time to the
 * adjacent word instead, producing a single word with a wildly implausible
 * duration (a real example: "I" spanning 2.16 seconds). Left alone, all
 * three make karaoke subtitles either flash through several words almost
 * instantly, or freeze on one word for multiple seconds while the speaker
 * has already moved on.
 *
 * (1) and (2) are fixed by pushing an overlapping word's start to close the
 * gap. (3) can't be truly fixed here — the missing words' text is gone, not
 * just mistimed, and there's nothing left in Whisper's output to recover it
 * from — but capping how long any single word can visually hold the screen
 * at least stops the multi-second freeze; the subtitle clears during the
 * excess (silence-handling in ShortClip.tsx already does this once the gap
 * exceeds its pause threshold) rather than sitting on a stale word. Every
 * word is also floored to a minimum plausible spoken duration for the same
 * reason as (1)/(2). Each fix cascades into the next word via the updated
 * `prev.end`, so a whole crammed run gets spread back out rather than just
 * the first offender in it.
 */
const MIN_PLAUSIBLE_WORD_DURATION_SECONDS = 0.1
const MAX_PLAUSIBLE_WORD_DURATION_SECONDS = 1.5

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
    if (cur.end - cur.start > MAX_PLAUSIBLE_WORD_DURATION_SECONDS) {
      cur.end = cur.start + MAX_PLAUSIBLE_WORD_DURATION_SECONDS
    }
  }
  return result
}
