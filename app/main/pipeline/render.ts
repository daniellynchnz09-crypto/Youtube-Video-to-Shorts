import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { bundle } from '@remotion/bundler'
import { renderMedia, selectComposition } from '@remotion/renderer'
import type { ShortClipProps } from '../remotion/ShortClip.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

export interface RenderClipInput {
  videoPath: string
  title: string
  words: ShortClipProps['words']
  durationInSeconds: number
  outputPath: string
}

export async function renderClip(input: RenderClipInput): Promise<void> {
  const bundleLocation = await bundle({
    entryPoint: join(__dirname, '../remotion/index.ts')
  })

  const clipProps: ShortClipProps = {
    videoSrc: input.videoPath,
    title: input.title,
    words: input.words,
    durationInSeconds: input.durationInSeconds
  }
  // selectComposition/renderMedia type their inputProps as Record<string, unknown>
  // rather than being generic over the composition's own zod schema.
  const inputProps = clipProps as unknown as Record<string, unknown>

  const composition = await selectComposition({
    serveUrl: bundleLocation,
    id: 'ShortClip',
    inputProps
  })

  await renderMedia({
    composition,
    serveUrl: bundleLocation,
    codec: 'h264',
    outputLocation: input.outputPath,
    inputProps
  })
}
