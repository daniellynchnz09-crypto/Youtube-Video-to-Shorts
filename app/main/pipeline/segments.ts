import type { Segment } from '../../../shared/schemas.js'
import type { SubtitleWord, WordTimestamp } from '../../../shared/types.js'

/** Slices the full-video word list to one segment and rebases timestamps to the clip's own start (0-based). */
export function wordsInSegment(words: WordTimestamp[], segment: Segment): SubtitleWord[] {
  return words
    .filter((w) => w.start >= segment.startTime && w.end <= segment.endTime)
    .map((w) => ({ word: w.word, start: w.start - segment.startTime, end: w.end - segment.startTime }))
}
