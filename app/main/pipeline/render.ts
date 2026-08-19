import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { createServer } from 'node:http'
import type { Server } from 'node:http'
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

/**
 * Remotion's OffthreadVideo/asset pipeline only knows how to fetch http(s)
 * URLs (and staticFile()-resolved paths served through its own bundle
 * server) — it has no code path for reading an arbitrary local file
 * directly, so a bare Windows path or a file:// URL both fail. Since our
 * segment videos are downloaded fresh per render (not known at bundle time,
 * so staticFile() doesn't apply), we serve just that one file over a
 * throwaway local HTTP server for the duration of the render.
 */
async function serveLocalFile(filePath: string): Promise<{ url: string; close: () => Promise<void> }> {
  const { size } = await stat(filePath)

  const server: Server = createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': size })
    createReadStream(filePath).pipe(res)
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('Failed to determine local server port')
  }

  return {
    url: `http://127.0.0.1:${address.port}/segment.mp4`,
    close: () => new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())))
  }
}

export async function renderClip(input: RenderClipInput): Promise<void> {
  const bundleLocation = await bundle({
    entryPoint: join(__dirname, '../remotion/index.ts')
  })

  const localServer = await serveLocalFile(input.videoPath)

  try {
    const clipProps: ShortClipProps = {
      videoSrc: localServer.url,
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
  } finally {
    await localServer.close()
  }
}
