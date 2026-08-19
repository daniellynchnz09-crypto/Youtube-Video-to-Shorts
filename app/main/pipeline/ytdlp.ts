import ytdlp from 'yt-dlp-exec'

export interface TimeRange {
  startTime: number
  endTime: number
}

export async function downloadAudio(url: string, outPath: string): Promise<void> {
  // Groq's Whisper endpoint caps uploads at 25MB. Whisper itself only uses
  // 16kHz mono internally, so downsampling here loses no transcription
  // accuracy while cutting file size by ~15-20x vs. the source stream.
  // At ~18kbps this comfortably fits videos up to a few hours long.
  await ytdlp(url, {
    extractAudio: true,
    audioFormat: 'm4a',
    audioQuality: 9,
    output: outPath,
    noPlaylist: true,
    postprocessorArgs: 'ffmpeg:-ar 16000 -ac 1 -b:a 24k'
  } as Parameters<typeof ytdlp>[1])
}

export async function downloadSegment(url: string, range: TimeRange, outPath: string): Promise<void> {
  // yt-dlp-exec's shipped types predate --download-sections,
  // --force-keyframes-at-cuts, and --merge-output-format.
  //
  // Explicit format selector (bestvideo+bestaudio, falling back to best) so
  // the final rendered clip's audio matches source quality — unlike
  // downloadAudio() above, this pass is never downsampled, since it feeds
  // the actual render rather than just transcription.
  await ytdlp(url, {
    output: outPath,
    noPlaylist: true,
    format: 'bestvideo*+bestaudio/best',
    downloadSections: `*${range.startTime}-${range.endTime}`,
    forceKeyframesAtCuts: true,
    mergeOutputFormat: 'mp4'
  } as Parameters<typeof ytdlp>[1])
}
