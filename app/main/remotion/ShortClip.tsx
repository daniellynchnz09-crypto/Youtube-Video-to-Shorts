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

export const ShortClip: React.FC<ShortClipProps> = ({ videoSrc, title, words }) => {
  const frame = useCurrentFrame()
  const { fps } = useVideoConfig()
  const currentTime = frame / fps
  const visibleWords = getVisibleWords(words, currentTime)

  return (
    <AbsoluteFill style={{ backgroundColor: '#000' }}>
      <AbsoluteFill>
        {/* OffthreadVideo (extracts frames server-side via ffmpeg) rather than
            Video (an actual <video> element) — Chrome blocks an http-served
            page from loading a local file:// video at all. */}
        <OffthreadVideo
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

function getVisibleWords(words: SubtitleWord[], currentTime: number, maxWords = MAX_VISIBLE_WORDS): SubtitleWord[] {
  const activeIndex = words.findIndex((w) => currentTime >= w.start && currentTime <= w.end)
  const centerIndex = activeIndex === -1 ? words.findIndex((w) => w.start > currentTime) : activeIndex
  if (centerIndex === -1) return []
  const start = Math.max(0, centerIndex - Math.floor(maxWords / 2))
  return words.slice(start, start + maxWords)
}
