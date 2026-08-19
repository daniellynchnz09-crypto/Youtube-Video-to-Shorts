import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import Groq from 'groq-sdk'
import type Database from 'better-sqlite3'
import { resolveProjectPaths } from './paths.js'
import { downloadAudio, downloadSegment } from './ytdlp.js'
import { transcribeAudio } from './transcribe.js'
import { groqSegmentAnalyzer } from './analyze.js'
import { groqTitleGenerator } from './titles.js'
import { renderClip } from './render.js'
import { wordsInSegment } from './segments.js'

export interface RunPipelineConfig {
  url: string
  baseDir: string
  groqApiKey: string
  db: Database.Database
  /** Caps how many of the analyzed segments actually get rendered. Omit to render all of them. */
  maxClips?: number
}

export interface PipelineClipResult {
  clipId: string
  title: string
  filePath: string
  startTime: number
  endTime: number
}

export async function runPipeline(config: RunPipelineConfig): Promise<PipelineClipResult[]> {
  const groq = new Groq({ apiKey: config.groqApiKey })
  const projectId = randomUUID()
  const paths = await resolveProjectPaths(config.baseDir, projectId)

  config.db
    .prepare(
      'INSERT INTO projects (id, source_url, title, status, created_at) VALUES (?, ?, ?, ?, ?)'
    )
    .run(projectId, config.url, config.url, 'transcribing', new Date().toISOString())

  await downloadAudio(config.url, paths.audioPath)
  const { words, durationSeconds } = await transcribeAudio(groq, paths.audioPath)

  config.db.prepare('UPDATE projects SET status = ? WHERE id = ?').run('analyzing', projectId)
  const segments = await groqSegmentAnalyzer.analyze(groq, words, durationSeconds)

  const segmentsToRender = config.maxClips ? segments.slice(0, config.maxClips) : segments
  const results: PipelineClipResult[] = []

  config.db.prepare('UPDATE projects SET status = ? WHERE id = ?').run('rendering', projectId)

  const insertClip = config.db.prepare(
    `INSERT INTO clips
      (id, project_id, title, start_time, end_time, words_json, render_status, review_status, file_path, thumbnail_path)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )

  for (const segment of segmentsToRender) {
    const clipId = randomUUID()
    const segmentVideoPath = join(paths.segmentDir, `${clipId}.mp4`)
    await downloadSegment(config.url, segment, segmentVideoPath)

    const clipWords = wordsInSegment(words, segment)
    const title = await groqTitleGenerator.generate(groq, clipWords)

    const outputPath = join(paths.outputDir, `${clipId}.mp4`)
    const durationInSeconds = segment.endTime - segment.startTime

    await renderClip({
      videoPath: segmentVideoPath,
      title,
      words: clipWords,
      durationInSeconds,
      outputPath
    })

    insertClip.run(
      clipId,
      projectId,
      title,
      segment.startTime,
      segment.endTime,
      JSON.stringify(clipWords),
      'done',
      'unreviewed',
      outputPath,
      null
    )

    results.push({
      clipId,
      title,
      filePath: outputPath,
      startTime: segment.startTime,
      endTime: segment.endTime
    })
  }

  config.db.prepare('UPDATE projects SET status = ? WHERE id = ?').run('ready', projectId)

  return results
}
