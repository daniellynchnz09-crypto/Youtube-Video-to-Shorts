import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import ytdlp from 'yt-dlp-exec'

const execFileAsync = promisify(execFile)

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

export async function downloadFullVideo(url: string, outPath: string): Promise<void> {
  // Full-quality video+audio, whole video — see extractSegment() below for
  // why segments are cut locally from this rather than fetched directly via
  // yt-dlp's --download-sections.
  await ytdlp(url, {
    output: outPath,
    noPlaylist: true,
    format: 'bestvideo*+bestaudio/best',
    mergeOutputFormat: 'mp4'
  } as Parameters<typeof ytdlp>[1])
}

/**
 * Cuts a time range out of an already-downloaded local video file with
 * ffmpeg, rather than asking yt-dlp to fetch just that range directly via
 * --download-sections. That approach (previously used here) turned out to
 * be unreliable on some videos: confirmed via direct testing (2026-08-29)
 * that a requested range came back starting up to ~15 seconds later in the
 * source than asked, with the offset varying by position in the video (not
 * a fixed skew). Root cause traced to yt-dlp falling back to a
 * non-fragmented progressive HTTP format on that video (surfaced by a wall
 * of PO-token warnings during the fetch) — --download-sections estimates a
 * byte offset for a given timestamp, and that estimate drifts when actual
 * bitrate varies through the video, which cut precision depends on for
 * plain progressive formats in a way it doesn't for YouTube's normal
 * fragmented/DASH delivery.
 *
 * Trimming locally sidesteps the whole class of bug: `-ss` before `-i` does
 * a fast seek to the nearest keyframe at or before `startTime`, then
 * re-encoding (rather than stream-copying) makes the actual output start
 * frame-accurate at `startTime` regardless of where that seek landed.
 */
export async function extractSegment(videoPath: string, range: TimeRange, outPath: string): Promise<void> {
  const duration = range.endTime - range.startTime
  await execFileAsync('ffmpeg', [
    '-y',
    '-ss',
    String(range.startTime),
    '-i',
    videoPath,
    '-t',
    String(duration),
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-crf',
    '18',
    '-c:a',
    'aac',
    '-b:a',
    '192k',
    '-avoid_negative_ts',
    'make_zero',
    outPath
  ])
}
