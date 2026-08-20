/**
 * Plain-Node smoke test for build-order step 1: proves download -> transcribe
 * -> analyze -> targeted download -> title -> render -> DB write works
 * end-to-end for ONE clip, with no Electron process and no UI involved.
 *
 * Run with: npm run smoke
 */
import 'dotenv/config'
import { execFile } from 'node:child_process'
import { mkdir, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import Groq from 'groq-sdk'
import Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import { resolveProjectPaths } from './paths.js'
import { downloadAudio, downloadSegment } from './ytdlp.js'
import { transcribeAudio } from './transcribe.js'
import { groqSegmentAnalyzer } from './analyze.js'
import { groqTitleGenerator } from './titles.js'
import { renderClip } from './render.js'
import { wordsInSegment } from './segments.js'
import { SCHEMA_SQL } from '../db/schema.js'

const execFileAsync = promisify(execFile)

// A short YouTube URL you're comfortable repeatedly re-downloading/re-transcribing
// during development. Not guessed on your behalf — fill this in before running.
const TEST_URL = 'https://youtu.be/7s7FvLsJjwc'

// Which ranked candidate segment to render (0 = top-ranked). Bump this to
// spot-check a different part of the video without waiting on the analyzer
// to non-deterministically rank a different segment first.
const SEGMENT_INDEX = 0

async function main(): Promise<void> {
  if (!TEST_URL) {
    throw new Error('Set TEST_URL in app/main/pipeline/smoke-test.ts before running `npm run smoke`.')
  }
  const groqApiKey = process.env.GROQ_API_KEY
  if (!groqApiKey) {
    throw new Error('GROQ_API_KEY is not set in .env')
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
  const scratchDir = join(process.cwd(), 'scratch', 'smoke-test', timestamp)
  await mkdir(scratchDir, { recursive: true })

  const groq = new Groq({ apiKey: groqApiKey })
  const db = new Database(join(scratchDir, 'test.db'))
  db.exec(SCHEMA_SQL)

  const timings: Record<string, number> = {}
  const timed = async <T>(label: string, fn: () => Promise<T>): Promise<T> => {
    const start = Date.now()
    const result = await fn()
    timings[label] = Date.now() - start
    console.log(`[${label}] done in ${timings[label]}ms`)
    return result
  }

  const projectId = randomUUID()
  const paths = await resolveProjectPaths(scratchDir, projectId)

  db.prepare(
    'INSERT INTO projects (id, source_url, title, status, created_at) VALUES (?, ?, ?, ?, ?)'
  ).run(projectId, TEST_URL, TEST_URL, 'transcribing', new Date().toISOString())

  await timed('download-audio', () => downloadAudio(TEST_URL, paths.audioPath))

  const { words, durationSeconds } = await timed('transcribe', () => transcribeAudio(groq, paths.audioPath))
  console.log(`  -> ${words.length} words, ${durationSeconds.toFixed(1)}s source duration`)

  db.prepare('UPDATE projects SET status = ? WHERE id = ?').run('analyzing', projectId)
  const segments = await timed('analyze', () => groqSegmentAnalyzer.analyze(groq, words, durationSeconds))
  console.log(`  -> ${segments.length} candidate segments returned`)

  const topSegment = segments[SEGMENT_INDEX] ?? segments[0]
  if (!topSegment) {
    throw new Error('Analyzer returned zero segments')
  }

  const clipId = randomUUID()
  const segmentVideoPath = join(paths.segmentDir, `${clipId}.mp4`)
  await timed('download-segment', () => downloadSegment(TEST_URL, topSegment, segmentVideoPath))

  const clipWords = wordsInSegment(words, topSegment)
  const title = await timed('title', () => groqTitleGenerator.generate(groq, clipWords, topSegment.endsAtSentenceEnd))
  console.log(`  -> title: "${title}"`)

  const outputPath = join(paths.outputDir, `${clipId}.mp4`)
  const durationInSeconds = topSegment.endTime - topSegment.startTime

  db.prepare('UPDATE projects SET status = ? WHERE id = ?').run('rendering', projectId)
  await timed('render', () =>
    renderClip({ videoPath: segmentVideoPath, title, words: clipWords, durationInSeconds, outputPath })
  )

  // Plain-text companion listing each subtitle word's on-screen timing in
  // milliseconds, for cross-checking against the rendered video by eye
  // instead of having to query the DB to spot a mistimed/mistranscribed word.
  const timingDumpPath = outputPath.replace(/\.mp4$/, '.subtitles.txt')
  await writeFile(
    timingDumpPath,
    clipWords.map((w) => `${Math.round(w.start * 1000)}ms - ${Math.round(w.end * 1000)}ms   ${w.word}`).join('\n')
  )
  console.log(`  -> subtitle timing dump: ${timingDumpPath}`)

  db.prepare(
    `INSERT INTO clips
      (id, project_id, title, start_time, end_time, words_json, render_status, review_status, file_path, thumbnail_path)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    clipId,
    projectId,
    title,
    topSegment.startTime,
    topSegment.endTime,
    JSON.stringify(clipWords),
    'done',
    'unreviewed',
    outputPath,
    null
  )
  db.prepare('UPDATE projects SET status = ? WHERE id = ?').run('ready', projectId)

  await assertOutput(outputPath)

  console.log('\n=== SMOKE TEST PASSED ===')
  console.log(`Output: ${outputPath}`)
  console.log('Per-stage timing (ms):', timings)
}

async function assertOutput(outputPath: string): Promise<void> {
  const fileStat = await stat(outputPath)
  if (fileStat.size === 0) {
    throw new Error(`Output file is empty: ${outputPath}`)
  }

  const { stdout } = await execFileAsync('ffprobe', [
    '-v',
    'error',
    '-select_streams',
    'v:0',
    '-show_entries',
    'format=duration:stream=width,height',
    '-of',
    'json',
    outputPath
  ])

  const probe = JSON.parse(stdout) as {
    format: { duration: string }
    streams: Array<{ width: number; height: number }>
  }
  const duration = Number(probe.format.duration)
  const stream = probe.streams[0]

  if (duration < 15 || duration > 60) {
    throw new Error(`Rendered clip duration ${duration}s is outside the 15-60s spec window`)
  }
  if (!stream || stream.width !== 1080 || stream.height !== 1920) {
    throw new Error(`Rendered clip resolution ${stream?.width}x${stream?.height} is not 1080x1920`)
  }

  console.log(`  -> verified: ${duration.toFixed(1)}s, ${stream.width}x${stream.height}, ${fileStat.size} bytes`)
}

main().catch((err) => {
  console.error('\n=== SMOKE TEST FAILED ===')
  console.error(err)
  process.exit(1)
})
