import ytdlp from 'yt-dlp-exec'

export interface TimeRange {
  startTime: number
  endTime: number
}

export async function downloadAudio(url: string, outPath: string): Promise<void> {
  await ytdlp(url, {
    extractAudio: true,
    audioFormat: 'm4a',
    output: outPath,
    noPlaylist: true
  })
}

export async function downloadSegment(url: string, range: TimeRange, outPath: string): Promise<void> {
  // yt-dlp-exec's shipped types predate --download-sections/--force-keyframes-at-cuts;
  // it converts any flag object key to a kebab-case CLI flag at runtime regardless,
  // so this is a real, working call — just outside what its .d.ts declares.
  await ytdlp(url, {
    output: outPath,
    noPlaylist: true,
    downloadSections: `*${range.startTime}-${range.endTime}`,
    forceKeyframesAtCuts: true
  } as Parameters<typeof ytdlp>[1])
}
