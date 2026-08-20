import { useMemo } from 'react'
import { AbsoluteFill, OffthreadVideo, useCurrentFrame, useVideoConfig } from 'remotion'
import { z } from 'zod'
import type { SubtitleWord } from '../../../shared/types'

/**
 * Deliberately minimal for build-order step 1 (prove the render mechanism
 * produces a real mp4). Full rendering fidelity — karaoke word highlight,
 * yellow/red title contrast switching, emoji pop-ins, Rubik Black — is
 * build-order step 3, not this pass.
 *
 * A zod schema (rather than a plain interface) so Remotion's <Composition>
 * generic can infer a Record<string, unknown>-compatible props type.
 */
export const shortClipPropsSchema = z.object({
  videoSrc: z.string(),
  title: z.string(),
  words: z.array(
    z.object({
      word: z.string(),
      start: z.number(),
      end: z.number(),
      edited: z.boolean().optional()
    })
  ) satisfies z.ZodType<SubtitleWord[]>,
  durationInSeconds: z.number()
})

export type ShortClipProps = z.infer<typeof shortClipPropsSchema>

const CENTER_VIDEO_WIDTH = 1080
const CENTER_VIDEO_HEIGHT = Math.round((CENTER_VIDEO_WIDTH * 9) / 16)
const MAX_VISIBLE_WORDS = 4
/** A gap at least this long (seconds) between words is treated as a sentence/pause
 * break: subtitles clear rather than jumping ahead to the next sentence early. */
const PAUSE_BREAK_SECONDS = 0.5

export const ShortClip: React.FC<ShortClipProps> = ({ videoSrc, title, words }) => {
  const frame = useCurrentFrame()
  const { fps } = useVideoConfig()
  const currentTime = frame / fps
  const subtitleGroups = useMemo(() => buildSubtitleGroups(words), [words])
  const visibleWords = getVisibleWords(subtitleGroups, currentTime)

  return (
    <AbsoluteFill style={{ backgroundColor: '#000' }}>
      <AbsoluteFill>
        {/* OffthreadVideo (extracts frames server-side via ffmpeg) rather than
            Video (an actual <video> element) — Chrome blocks an http-served
            page from loading a local file:// video at all. Muted: this and
            the center OffthreadVideo below share the same src, and Remotion
            mixes audio from every non-muted video layer — without this the
            same audio track got mixed in twice, summing to clipped/distorted
            output audio. */}
        <OffthreadVideo
          muted
          src={videoSrc}
          style={{
            width: '100%',
            height: '100%',
            objectFit: 'cover',
            filter: 'blur(40px) brightness(0.6)',
            transform: 'scale(1.2)'
          }}
        />
      </AbsoluteFill>

      <AbsoluteFill style={{ justifyContent: 'flex-start', alignItems: 'center', paddingTop: 80 }}>
        <div
          style={{
            fontFamily: 'sans-serif',
            fontWeight: 900,
            fontSize: 64,
            color: '#facc15',
            textAlign: 'center',
            WebkitTextStroke: '4px black',
            padding: '0 40px'
          }}
        >
          {title}
        </div>
      </AbsoluteFill>

      <AbsoluteFill style={{ justifyContent: 'center', alignItems: 'center' }}>
        <OffthreadVideo src={videoSrc} style={{ width: CENTER_VIDEO_WIDTH, height: CENTER_VIDEO_HEIGHT }} />
      </AbsoluteFill>

      <AbsoluteFill style={{ justifyContent: 'flex-end', alignItems: 'center', paddingBottom: 160 }}>
        <div
          style={{
            fontFamily: 'sans-serif',
            fontWeight: 900,
            fontSize: 56,
            color: 'white',
            textAlign: 'center',
            WebkitTextStroke: '3px black',
            padding: '0 40px'
          }}
        >
          {visibleWords.map((w) => w.word).join(' ')}
        </div>
      </AbsoluteFill>
    </AbsoluteFill>
  )
}

/**
 * Fixed, non-overlapping groups of up to maxWords, split early on a
 * pause/sentence gap — precomputed once per clip rather than recomputed
 * per-frame, since the grouping itself doesn't depend on playback time.
 *
 * Deliberately not a sliding window: an earlier version kept the trailing
 * maxWords most-recently-spoken words on screen at all times, which meant
 * words that had already been shown stuck around and got shown again
 * alongside new ones every time the window advanced by one. Chunking into
 * discrete groups means each word is only ever part of one on-screen group,
 * even if that means a group has fewer than maxWords words in it.
 *
 * Also always breaks after a word carrying sentence-ending punctuation
 * (. ! ?), regardless of pause length or word count — without this, short
 * back-to-back sentences with little pause between them (e.g. "the hardest.
 * Right. Crypt") got merged into one group spanning multiple sentences.
 */
function endsSentence(word: string): boolean {
  return /[.!?]["')\]]*$/.test(word.trim())
}

function buildSubtitleGroups(
  words: SubtitleWord[],
  maxWords = MAX_VISIBLE_WORDS,
  pauseBreakSeconds = PAUSE_BREAK_SECONDS
): SubtitleWord[][] {
  const groups: SubtitleWord[][] = []
  let current: SubtitleWord[] = []
  for (const word of words) {
    if (current.length > 0) {
      const prevWord = current[current.length - 1]!
      const gap = word.start - prevWord.end
      if (gap > pauseBreakSeconds || current.length >= maxWords || endsSentence(prevWord.word)) {
        groups.push(current)
        current = []
      }
    }
    current.push(word)
  }
  if (current.length > 0) groups.push(current)
  return groups
}

/**
 * Finds the most recently started group and reveals its words as they're
 * actually spoken (no look-ahead within the group either), clearing once a
 * pause after the group's last word exceeds pauseBreakSeconds.
 */
function getVisibleWords(
  groups: SubtitleWord[][],
  currentTime: number,
  pauseBreakSeconds = PAUSE_BREAK_SECONDS
): SubtitleWord[] {
  for (let g = groups.length - 1; g >= 0; g--) {
    const group = groups[g]!
    if (group[0]!.start <= currentTime) {
      const lastWord = group[group.length - 1]!
      if (currentTime - lastWord.end > pauseBreakSeconds) return []
      return group.filter((w) => w.start <= currentTime)
    }
  }
  return []
}
