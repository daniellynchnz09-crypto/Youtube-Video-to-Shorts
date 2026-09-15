import { randomUUID } from 'node:crypto'
import { readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { VideoMetadata, WordTimestamp } from '../../../shared/types.js'
import { buildTranscriptionHint } from './videoContext.js'

const execFileAsync = promisify(execFile)
const __dirname = dirname(fileURLToPath(import.meta.url))

export interface TranscriptionResult {
  words: WordTimestamp[]
  durationSeconds: number
}

/** A stretch of the audio pyannote's VAD model judged to contain real speech (see whisperx_transcribe.py). */
interface SpeechSegment {
  start: number
  end: number
}

/**
 * Whisper's word-level timestamps — whether from Groq's hosted
 * whisper-large-v3 (used here previously) or any other vanilla Whisper —
 * come from the model's own cross-attention weights, and turned out to
 * carry several-second-scale error on this project's content (confirmed
 * 2026-08-31: a word's reported position was off by up to ~3.6s in a way
 * that didn't shrink when the audio handed to Whisper was made much
 * shorter, ruling out "long audio accumulates drift" as the cause — see
 * bugs.md for the full trail, including a chunking attempt that didn't
 * help). That's not just a display-timing annoyance: the analyzer's
 * segment boundaries and the final clip's actual extraction window both
 * depend on these timestamps too, so a clip could end up covering the
 * wrong real stretch of the source video, not just showing laggy
 * subtitles over the right stretch.
 *
 * WhisperX exists specifically to fix this: it still uses Whisper (via
 * faster-whisper) for transcription, but then re-times every word with a
 * dedicated wav2vec2 phoneme-alignment model run directly against the
 * audio, instead of trusting Whisper's own attention-based timing. Verified
 * against the same reference case (2026-08-31): the word that was 3.6s off
 * under Groq's whisper-large-v3 landed within ~0.03s of the tightly-scoped
 * reference position under WhisperX, on the very same full, unchunked
 * video.
 *
 * This runs as a Python subprocess (`whisperx_transcribe.py`, in a
 * dedicated venv at `whisperx-venv/`) rather than an in-process Node
 * library — WhisperX has no Node equivalent, and shelling out mirrors how
 * yt-dlp is already integrated in this pipeline. It also runs entirely
 * locally on the user's own GPU rather than through Groq's API, which
 * incidentally removes this step from the Groq rate-limit/resilience gap
 * documented in backlog.md — transcription no longer depends on Groq at
 * all (analysis and title generation still do).
 *
 * `hint` is passed through to Whisper's `initial_prompt` (see
 * buildTranscriptionHint) to bias spelling of proper nouns the model would
 * otherwise mangle. Empty string = no hint.
 */
async function runWhisperX(
  audioPath: string,
  hint: string
): Promise<{ words: WordTimestamp[]; durationSeconds: number; speechSegments: SpeechSegment[] }> {
  const projectRoot = join(__dirname, '../../..')
  const pythonPath = join(projectRoot, 'whisperx-venv', 'Scripts', 'python.exe')
  const scriptPath = join(__dirname, 'whisperx_transcribe.py')
  const outputPath = join(tmpdir(), `yss-whisperx-${randomUUID()}.json`)

  try {
    await execFileAsync(pythonPath, [scriptPath, audioPath, outputPath, 'en', hint], {
      maxBuffer: 1024 * 1024 * 64
    })
    const raw = await readFile(outputPath, 'utf-8')
    const parsed = JSON.parse(raw) as { words: WordTimestamp[]; duration: number; speechSegments: SpeechSegment[] }
    return { words: parsed.words, durationSeconds: parsed.duration, speechSegments: parsed.speechSegments }
  } finally {
    await rm(outputPath, { force: true })
  }
}

export async function transcribeAudio(
  audioPath: string,
  metadata?: VideoMetadata
): Promise<TranscriptionResult> {
  const { words, durationSeconds, speechSegments } = await runWhisperX(audioPath, buildTranscriptionHint(metadata))
  const deduplicated = dropDuplicateBursts(words)
  const normalized = normalizeWordTimestamps(deduplicated)
  const clamped = clampWordsToSpeechSegments(normalized, speechSegments)
  logLikelyDroppedWordGaps(clamped, speechSegments)
  return { words: clamped, durationSeconds }
}

/**
 * Whisper occasionally transcribes the same phrase twice: once as a burst of
 * near-zero-duration words crammed into a fraction of a second (a real
 * example: 10 words spanning just 0.28s, ~0.02s each — physically
 * impossible to actually speak that fast), immediately followed later by
 * the same phrase again at a normal, correctly-timed pace. Left alone, the
 * burst copy survives normalizeWordTimestamps() below — its floor-and-push
 * logic stretches a too-short word out to a minimum plausible duration
 * rather than removing it, so a crammed run still ends up on screen, just
 * spread across ~1s instead of ~0.3s: a rapid flash of words with no
 * matching audio, followed by the same words shown again (correctly) when
 * actually spoken. This was originally observed and fixed against Groq's
 * output, but kept here as a defensive check — WhisperX's transcription
 * step still runs Whisper under the hood, so the same duplication could in
 * principle still occur, even though the timing itself is now re-derived
 * by alignment rather than trusted directly.
 *
 * This must run on the raw, un-normalized timestamps — normalizeWordTimestamps()
 * would have already floored away the near-zero-duration signal a burst is
 * detected by. A *single* near-zero-duration word is left alone here (that
 * case is a one-off glitch, not a duplicate transcription, and is exactly
 * what normalizeWordTimestamps()'s floor is for) — this only drops a run of
 * several such words packed back-to-back, which realistic speech can't
 * produce (a run this tight implies a rate far beyond human speech).
 */
const BURST_WORD_MAX_DURATION_SECONDS = 0.05
const BURST_MAX_GAP_SECONDS = 0.01
const BURST_MIN_RUN_LENGTH = 3

function dropDuplicateBursts(words: WordTimestamp[]): WordTimestamp[] {
  const dropIndices = new Set<number>()
  let runStart = 0

  const flushRun = (runEnd: number): void => {
    if (runEnd - runStart >= BURST_MIN_RUN_LENGTH) {
      for (let i = runStart; i < runEnd; i++) dropIndices.add(i)
    }
  }

  for (let i = 0; i < words.length; i++) {
    const word = words[i]!
    const inBurst = word.end - word.start <= BURST_WORD_MAX_DURATION_SECONDS
    const continuesRun = i === runStart || word.start - words[i - 1]!.end <= BURST_MAX_GAP_SECONDS
    if (!inBurst || !continuesRun) {
      flushRun(i)
      runStart = i
    }
    if (!inBurst) runStart = i + 1
  }
  flushRun(words.length)

  return words.filter((_, i) => !dropIndices.has(i))
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

/**
 * VAD's real speech/silence detection (see whisperx_transcribe.py) as a
 * cross-check on forced-alignment's word timestamps — added 2026-09-15 for
 * the residual isolated-word desync bug (see bugs.md). Forced alignment can
 * attribute a dropped/self-corrected phrase's silence to the surviving
 * adjacent word's own duration (see normalizeWordTimestamps' doc comment
 * above) — MAX_PLAUSIBLE_WORD_DURATION_SECONDS already caps that at 1.5s,
 * but a word visually holding the screen for a full 1.5s into what's
 * actually real silence still reads as broken. Verified directly
 * (2026-09-15) against a real case: "than" was capped to exactly 1.5s
 * (516.11-517.61) by the existing floor, but pyannote's VAD confirms real
 * speech in that area actually stops at 516.25 — clamping to the VAD
 * boundary (plus a small padding for VAD's own boundary imprecision and
 * natural trailing consonants) removes the bogus ~1s of the word bleeding
 * into real silence.
 *
 * Only clamps the END of a word that already overlaps a VAD speech segment
 * at its start — a word whose *start* falls entirely outside every VAD
 * segment (the original "Ah!" mislocated-by-~6s case in bugs.md) isn't
 * relocated here; that would mean moving the word to a different position
 * entirely, and that path hasn't been verified against real data yet.
 */
const VAD_END_PADDING_SECONDS = 0.3

export function clampWordsToSpeechSegments(words: WordTimestamp[], speechSegments: SpeechSegment[]): WordTimestamp[] {
  if (speechSegments.length === 0) return words
  const result = words.map((w) => ({ ...w }))
  let segIndex = 0

  for (const word of result) {
    while (segIndex < speechSegments.length - 1 && speechSegments[segIndex]!.end < word.start) {
      segIndex++
    }
    const seg = speechSegments[segIndex]!
    // Word starts before this (or any) VAD segment — not this fix's target, see doc comment.
    if (word.start < seg.start) continue

    const maxEnd = seg.end + VAD_END_PADDING_SECONDS
    if (word.end > maxEnd) {
      word.end = Math.max(word.start + MIN_PLAUSIBLE_WORD_DURATION_SECONDS, maxEnd)
    }
  }

  return result
}

/**
 * Diagnostic only — doesn't change output. Flags a VAD-confirmed speech
 * stretch that ends up with little or no word coverage, meaning Whisper's
 * ASR likely dropped real spoken content rather than just mistiming it (the
 * OTHER known desync shape — see bugs.md's "ASR step, not alignment,
 * silently drops a word" case; confirmed directly 2026-09-15 against a
 * real VAD-confirmed 503.41-508.93s speech stretch that only two words,
 * 1.4s apart, actually covered). VAD can't recover the missing text — this
 * just surfaces the gap in pipeline logs rather than leaving it only
 * discoverable by a user noticing a subtitle drop after the fact.
 */
const DROPPED_WORD_MIN_SEGMENT_SECONDS = 1.0
const DROPPED_WORD_MAX_COVERAGE_FRACTION = 0.5

export function logLikelyDroppedWordGaps(words: WordTimestamp[], speechSegments: SpeechSegment[]): void {
  let wordIndex = 0
  for (const seg of speechSegments) {
    const segDuration = seg.end - seg.start
    if (segDuration < DROPPED_WORD_MIN_SEGMENT_SECONDS) continue

    while (wordIndex < words.length && words[wordIndex]!.end < seg.start) wordIndex++

    let covered = 0
    for (let i = wordIndex; i < words.length && words[i]!.start < seg.end; i++) {
      const w = words[i]!
      covered += Math.min(w.end, seg.end) - Math.max(w.start, seg.start)
    }

    if (covered / segDuration < DROPPED_WORD_MAX_COVERAGE_FRACTION) {
      console.warn(
        `[transcribe] Possible dropped word(s): VAD detected ${segDuration.toFixed(2)}s of speech at ` +
          `${seg.start.toFixed(2)}s-${seg.end.toFixed(2)}s, but transcribed words only cover ${covered.toFixed(2)}s of it.`
      )
    }
  }
}
