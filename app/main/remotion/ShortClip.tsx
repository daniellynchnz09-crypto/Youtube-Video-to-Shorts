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
/**
 * Whisper's word timestamps are least reliable right after a real silence
 * (less surrounding speech to anchor the alignment against), so a word
 * following a pause this long or longer gets a small extra reveal buffer
 * below — a hedge against it being flagged as "spoken" a touch before the
 * viewer actually hears it, which would otherwise read as the subtitles
 * jumping ahead during the pause.
 */
const LONG_PAUSE_SECONDS = 1
const POST_LONG_PAUSE_REVEAL_BUFFER_SECONDS = 0.15

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

interface SubtitleGroup {
  words: SubtitleWord[]
  /** Extra seconds added to this group's first word before it's considered "spoken" — see LONG_PAUSE_SECONDS above. */
  revealDelaySeconds: number
}

function buildSubtitleGroups(
  words: SubtitleWord[],
  maxWords = MAX_VISIBLE_WORDS,
  pauseBreakSeconds = PAUSE_BREAK_SECONDS
): SubtitleGroup[] {
  const groups: SubtitleGroup[] = []
  let current: SubtitleWord[] = []
  let prevGroupEnd: number | null = null

  const flush = (): void => {
    if (current.length === 0) return
    const gapFromPrevGroup = prevGroupEnd === null ? 0 : current[0]!.start - prevGroupEnd
    groups.push({
      words: current,
      revealDelaySeconds: gapFromPrevGroup > LONG_PAUSE_SECONDS ? POST_LONG_PAUSE_REVEAL_BUFFER_SECONDS : 0
    })
    prevGroupEnd = current[current.length - 1]!.end
    current = []
  }

  for (const word of words) {
    if (current.length > 0) {
      const prevWord = current[current.length - 1]!
      const gap = word.start - prevWord.end
      if (gap > pauseBreakSeconds || current.length >= maxWords || endsSentence(prevWord.word)) {
        flush()
      }
    }
    current.push(word)
  }
  flush()
  return groups
}

/**
 * Finds the most recently started group and reveals its words as they're
 * actually spoken (no look-ahead within the group either, beyond the small
 * post-pause buffer on a group's first word), clearing once a pause after
 * the group's last word exceeds pauseBreakSeconds.
 */
function getVisibleWords(
  groups: SubtitleGroup[],
  currentTime: number,
  pauseBreakSeconds = PAUSE_BREAK_SECONDS
): SubtitleWord[] {
  for (let g = groups.length - 1; g >= 0; g--) {
    const group = groups[g]!
    const effectiveFirstStart = group.words[0]!.start + group.revealDelaySeconds
    if (effectiveFirstStart <= currentTime) {
      const lastWord = group.words[group.words.length - 1]!
      if (currentTime - lastWord.end > pauseBreakSeconds) return []
      return group.words.filter((w, i) => (i === 0 ? effectiveFirstStart : w.start) <= currentTime)
    }
  }
  return []
}
