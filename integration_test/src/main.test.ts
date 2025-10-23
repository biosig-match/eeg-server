import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import fs from 'fs/promises'
import path from 'path'
import { Pool } from 'pg'
import { Client as S3CompatibleClient } from 'minio'
import { compress, init as initZstd } from '@bokuweb/zstd-wasm'
import JSZip from 'jszip'
import { Buffer } from 'buffer'
import neatCSV from 'neat-csv'
import { parsePayloadsAndExtractTriggerTimestampsUs } from '../../event_corrector/src/domain/services/trigger_timestamps'

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:8080/api/v1'
const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://admin:password@localhost:5432/eeg_data'
const OBJECT_STORAGE_ENDPOINT = process.env.MINIO_ENDPOINT ?? 'localhost'
const OBJECT_STORAGE_PORT = Number.parseInt(process.env.MINIO_PORT ?? '8333', 10)
const OBJECT_STORAGE_USE_SSL =
  (process.env.MINIO_USE_SSL ?? 'false').toLowerCase() === 'true'
const OBJECT_STORAGE_ACCESS_KEY = process.env.MINIO_ACCESS_KEY ?? 'storageadmin'
const OBJECT_STORAGE_SECRET_KEY = process.env.MINIO_SECRET_KEY ?? 'storageadmin'
const OBJECT_STORAGE_CONFIG = {
  endPoint: OBJECT_STORAGE_ENDPOINT,
  port: OBJECT_STORAGE_PORT,
  useSSL: OBJECT_STORAGE_USE_SSL,
  accessKey: OBJECT_STORAGE_ACCESS_KEY,
  secretKey: OBJECT_STORAGE_SECRET_KEY,
}
const OBJECT_STORAGE_MEDIA_BUCKET =
  process.env.OBJECT_STORAGE_MEDIA_BUCKET ?? 'media'

function createObjectStorageTestClient(config: typeof OBJECT_STORAGE_CONFIG) {
  const client = new S3CompatibleClient({
    endPoint: config.endPoint,
    port: config.port,
    useSSL: config.useSSL,
    accessKey: config.accessKey,
    secretKey: config.secretKey,
  })

  return {
    async fPutObject(
      bucketName: string,
      objectId: string,
      filePath: string,
      metadata: Record<string, string> = {},
    ): Promise<void> {
      const exists = await client.bucketExists(bucketName).catch(() => false)
      if (!exists) {
        await client.makeBucket(bucketName)
      }
      await client.fPutObject(bucketName, objectId, filePath, metadata)
    },
  }
}

const ASSETS_DIR = path.resolve(__dirname, '../assets')
const TEST_OUTPUT_DIR = path.resolve(__dirname, '../test-output')

const DB_POLL_TIMEOUT = 30000
const TASK_POLL_TIMEOUT = 120000
const REALTIME_ANALYZER_POLL_TIMEOUT = 60000
const REALTIME_ANALYZER_POLL_INTERVAL = 2000

interface ElectrodeConfig {
  name: string
  type: number
}
interface DeviceProfile {
  deviceId: string
  samplingRate: number
  lsbToVolts: number
  electrodes: ElectrodeConfig[]
}

const MOCK_CUSTOM_EEG_DEVICE: DeviceProfile = {
  deviceId: 'custom-eeg-test-device',
  samplingRate: 250.0,
  lsbToVolts: 3e-9,
  electrodes: [
    { name: 'CH1', type: 0 },
    { name: 'CH2', type: 0 },
    { name: 'CH3', type: 0 },
    { name: 'CH4', type: 0 },
    { name: 'CH5', type: 0 },
    { name: 'CH6', type: 0 },
    { name: 'CH7', type: 0 },
    { name: 'CH8', type: 0 },
    { name: 'TRIG', type: 3 },
  ],
}

const MOCK_MUSE2_DEVICE: DeviceProfile = {
  deviceId: 'muse2-test-device',
  samplingRate: 256.0,
  lsbToVolts: 3.6e-9,
  electrodes: [
    { name: 'TP9', type: 0 },
    { name: 'AF7', type: 0 },
    { name: 'AF8', type: 0 },
    { name: 'TP10', type: 0 },
  ],
}

interface ChannelWaveParams {
  bands: Array<{ freq: number; amplitude: number; phase: number }>
  driftFreq: number
  driftAmplitude: number
  driftPhase: number
  lineFreq: number
  lineAmplitude: number
  linePhase: number
  noiseFreq: number
  noiseAmplitude: number
  noisePhase: number
}

const EEG_BAND_DEFS = [
  { freq: 1.5, baseAmplitude: 55 },
  { freq: 4.5, baseAmplitude: 48 },
  { freq: 8.5, baseAmplitude: 52 },
  { freq: 12.0, baseAmplitude: 44 },
  { freq: 20.0, baseAmplitude: 30 },
]

const EMG_BAND_DEFS = [
  { freq: 10.0, baseAmplitude: 95 },
  { freq: 25.0, baseAmplitude: 78 },
  { freq: 60.0, baseAmplitude: 55 },
]

const EOG_BAND_DEFS = [
  { freq: 0.2, baseAmplitude: 140 },
  { freq: 0.6, baseAmplitude: 90 },
  { freq: 1.2, baseAmplitude: 60 },
]

const CHANNEL_WAVE_CACHE = new Map<string, ChannelWaveParams>()

const hashString = (value: string): number => {
  let hash = 0
  for (let i = 0; i < value.length; i++) {
    hash = (hash << 5) - hash + value.charCodeAt(i)
    hash |= 0
  }
  return hash >>> 0
}

const mulberry32 = (seed: number) => {
  let t = seed >>> 0
  return () => {
    t += 0x6d2b79f5
    let r = Math.imul(t ^ (t >>> 15), 1 | t)
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r)
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296
  }
}

const getChannelWaveParams = (deviceId: string, channel: ElectrodeConfig): ChannelWaveParams => {
  const cacheKey = `${deviceId}:${channel.name}:${channel.type}`
  const cached = CHANNEL_WAVE_CACHE.get(cacheKey)
  if (cached) return cached

  const prng = mulberry32(hashString(cacheKey))
  const baseBands =
    channel.type === 1 ? EMG_BAND_DEFS : channel.type === 2 ? EOG_BAND_DEFS : EEG_BAND_DEFS
  const typeScale = channel.type === 1 ? 1.8 : channel.type === 2 ? 1.4 : 1.0

  const bands = baseBands.map(({ freq, baseAmplitude }) => ({
    freq,
    amplitude: (0.6 + prng() * 0.8) * baseAmplitude * typeScale,
    phase: prng() * Math.PI * 2,
  }))

  const params: ChannelWaveParams = {
    bands,
    driftFreq: (channel.type === 2 ? 0.05 : 0.1) + prng() * 0.15,
    driftAmplitude: (channel.type === 2 ? 120 : 40) * (0.7 + prng() * 0.6) * typeScale,
    driftPhase: prng() * Math.PI * 2,
    lineFreq: 50,
    lineAmplitude: (12 + prng() * 6) * typeScale,
    linePhase: prng() * Math.PI * 2,
    noiseFreq: (channel.type === 1 ? 80 : 35) + prng() * (channel.type === 1 ? 40 : 25),
    noiseAmplitude: (channel.type === 1 ? 48 : 18) * (0.5 + prng() * 0.8) * typeScale,
    noisePhase: prng() * Math.PI * 2,
  }

  CHANNEL_WAVE_CACHE.set(cacheKey, params)
  return params
}

const sampleElectrodeMicroVolts = (
  params: ChannelWaveParams,
  channelType: number,
  sampleTime: number,
) => {
  let signal = 0
  for (const band of params.bands) {
    signal += band.amplitude * Math.sin(2 * Math.PI * band.freq * sampleTime + band.phase)
  }
  signal +=
    params.driftAmplitude *
    Math.sin(2 * Math.PI * params.driftFreq * sampleTime + params.driftPhase)
  signal +=
    params.lineAmplitude * Math.sin(2 * Math.PI * params.lineFreq * sampleTime + params.linePhase)
  signal +=
    params.noiseAmplitude *
    Math.sin(2 * Math.PI * params.noiseFreq * sampleTime + params.noisePhase)

  if (channelType === 1) {
    signal += 12 * Math.sin(2 * Math.PI * 90 * sampleTime + params.noisePhase * 0.5)
  }

  return signal
}

interface ExperimentResponse {
  experiment_id: string
}

interface ExportTaskStatus {
  status: string
  error_message?: string | null
  result_file_path?: string | null
}

interface ExportTaskAccepted {
  task_id: string
}

interface ErpAnalysisResponse {
  summary: string
  recommendations: Array<{ file_name: string }>
}

interface ErrorResponse {
  detail?: string
}

interface RealtimeApplicationSummary {
  id: string
  display_name: string
  description: string
}

interface RealtimeApplicationResult {
  psd_image: string
  coherence_image: string
  timestamp: string
  bad_channels: string[]
  analysis_channels: string[]
  channel_quality: Record<string, unknown>
}

interface RealtimeAnalysisResponse {
  applications: Record<string, RealtimeApplicationResult>
  available_applications: RealtimeApplicationSummary[]
}

interface RawDataObjectRow {
  object_id: string
  sampling_rate: number
  lsb_to_volts: number
  start_time: Date | string
  end_time: Date | string
}

interface WorkflowContext {
  [key: string]: any
  experimentId?: string
  bidsTaskId?: string
  bidsArchiveEntries?: string[]
  zip?: JSZip
  zipBuffer?: Buffer
  bidsZipPath?: string
  bidsExtractedDir?: string
  rawDataObjects?: RawDataObjectRow[]
  calibCorrectedCount?: number
  mainCorrectedCount?: number
  calibRawObjectCount?: number
  mainRawObjectCount?: number
  calibLinkedObjectsCount?: number
  mainLinkedObjectsCount?: number
  erpAnalysisStatus?: number
  erpAnalysis?: ErpAnalysisResponse
  realtimeAnalysis?: RealtimeAnalysisResponse
  realtimeImageDir?: string
}
interface ScenarioConfig {
  deviceProfile: DeviceProfile
  withEvents: boolean
  ownerId: string
  participantId: string
  strangerId: string
}

let dbPool: Pool
type ObjectStorageTestClient = ReturnType<typeof createObjectStorageTestClient>

let objectStorageClient: ObjectStorageTestClient

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function pollForDbStatus(
  query: string,
  params: any[],
  expectedValue: any,
  timeout = DB_POLL_TIMEOUT,
) {
  const start = Date.now()
  while (Date.now() - start < timeout) {
    const { rows } = await dbPool.query(query, params)
    if (rows.length > 0 && rows[0].status === expectedValue) return
    await sleep(1000)
  }
  throw new Error(`Timed out waiting for DB status '${expectedValue}'`)
}

async function pollForTaskStatus(
  taskId: string,
  expectedStatus: string,
  timeout = TASK_POLL_TIMEOUT,
): Promise<ExportTaskStatus> {
  const start = Date.now()
  while (Date.now() - start < timeout) {
    const response = await fetch(`${BASE_URL}/export-tasks/${taskId}`)
    if (response.ok) {
      const task = (await response.json()) as ExportTaskStatus
      if (task.status === expectedStatus) return task
      if (task.status === 'failed')
        throw new Error(`Export task ${taskId} failed: ${task.error_message ?? 'unknown'}`)
    }
    await sleep(2000)
  }
  throw new Error(`Timed out waiting for export task ${taskId} to be ${expectedStatus}`)
}

async function pollForRealtimeAnalysis(
  userId: string,
  timeout = REALTIME_ANALYZER_POLL_TIMEOUT,
): Promise<RealtimeAnalysisResponse> {
  const start = Date.now()
  while (Date.now() - start < timeout) {
    const response = await fetch(`${BASE_URL}/users/${userId}/analysis`)
    if (response.status === 202) {
      await sleep(REALTIME_ANALYZER_POLL_INTERVAL)
      continue
    }
    if (!response.ok) {
      const body = await response.text()
      throw new Error(`Realtime analyzer request failed with status ${response.status}: ${body}`)
    }
    const payload = (await response.json()) as RealtimeAnalysisResponse
    if (Object.keys(payload.applications ?? {}).length > 0) {
      return payload
    }
    await sleep(REALTIME_ANALYZER_POLL_INTERVAL)
  }
  throw new Error(`Timed out waiting for realtime analysis for user ${userId}`)
}

async function persistRealtimeImages(
  analysis: RealtimeAnalysisResponse,
  participantId: string,
): Promise<string> {
  const safeParticipantId = participantId.replace(/[^a-zA-Z0-9_-]/g, '_')
  const targetDir = path.join(TEST_OUTPUT_DIR, `realtime-${safeParticipantId}`)

  await fs.rm(targetDir, { recursive: true, force: true })
  await fs.mkdir(targetDir, { recursive: true })

  const applications = analysis.applications ?? {}
  for (const [appId, result] of Object.entries(applications)) {
    const safeAppId = appId.replace(/[^a-zA-Z0-9_-]/g, '_')
    const imageArtifacts: Array<[string, string]> = [
      ['psd', result.psd_image],
      ['coherence', result.coherence_image],
    ]

    for (const [label, base64Image] of imageArtifacts) {
      if (!base64Image || base64Image.trim().length === 0) {
        continue
      }
      const filePath = path.join(targetDir, `${safeAppId}_${label}.png`)
      await fs.writeFile(filePath, Buffer.from(base64Image, 'base64'))
    }
  }

  return targetDir
}

function createMockBinaryPayload(
  profile: DeviceProfile,
  numSamples: number,
  triggerEvents: Record<number, number> = {},
  chunkIndex = 0,
): Buffer {
  const numChannels = profile.electrodes.length
  const headerSize = 4 + numChannels * 10
  const sampleSize = numChannels * 2 + 12 + numChannels // signals(ch*2) + accel(6) + gyro(6) + impedance(ch*1)
  const buffer = Buffer.alloc(headerSize + numSamples * sampleSize)
  let offset = 0

  buffer.writeUInt8(0x04, offset++) // version
  buffer.writeUInt8(numChannels, offset++) // num_channels
  buffer.writeUInt16LE(0, offset) // reserved
  offset += 2

  for (const electrode of profile.electrodes) {
    const nameBuf = Buffer.alloc(8)
    nameBuf.write(electrode.name, 'utf-8')
    nameBuf.copy(buffer, offset)
    offset += 8
    buffer.writeUInt8(electrode.type, offset++) // type
    buffer.writeUInt8(0, offset++) // reserved
  }

  const triggerChannelIndex = profile.electrodes.findIndex((e) => e.type === 3)
  const globalSampleOffset = chunkIndex * numSamples

  // Samples
  for (let i = 0; i < numSamples; i++) {
    // EEG/EMG/EOG Signals
    for (let ch = 0; ch < numChannels; ch++) {
      const electrode = profile.electrodes[ch]
      const eventValue = triggerEvents[i]
      if (ch === triggerChannelIndex) {
        buffer.writeInt16LE(eventValue ?? 0, offset)
        offset += 2
        continue
      }

      const sampleIndex = globalSampleOffset + i
      const sampleTime = sampleIndex / profile.samplingRate
      const params = getChannelWaveParams(profile.deviceId, electrode)
      const microVolts = sampleElectrodeMicroVolts(params, electrode.type, sampleTime)
      const lsbToVolts = profile.lsbToVolts > 0 ? profile.lsbToVolts : 1e-6
      const rawCount = (microVolts * 1e-6) / lsbToVolts
      const clamped = Math.max(-32768, Math.min(32767, Math.round(rawCount)))
      buffer.writeInt16LE(clamped, offset)
      offset += 2
    }
    // Accel + Gyro (dummy data)
    buffer.fill(0, offset, offset + 12)
    offset += 12
    // Impedance (dummy data)
    buffer.fill(255, offset, offset + numChannels)
    offset += numChannels
  }
  return buffer
}

describe('Trigger Extraction Utility', () => {
  test('detects triggers that span raw data object boundaries without duplicating events', () => {
    const samplingRate = MOCK_CUSTOM_EEG_DEVICE.samplingRate
    const numSamplesPerPayload = 4
    const chunkDurationMs = Math.round((numSamplesPerPayload / samplingRate) * 1000)
    const bridgeValue = 7

    const payloads = [
      {
        buffer: createMockBinaryPayload(
          MOCK_CUSTOM_EEG_DEVICE,
          numSamplesPerPayload,
          {
            [numSamplesPerPayload - 1]: bridgeValue,
          },
          0,
        ),
        startTimeMs: 0,
        samplingRate,
      },
      {
        buffer: createMockBinaryPayload(
          MOCK_CUSTOM_EEG_DEVICE,
          numSamplesPerPayload,
          {
            0: bridgeValue,
          },
          1,
        ),
        startTimeMs: chunkDurationMs,
        samplingRate,
      },
    ]

    const triggers = parsePayloadsAndExtractTriggerTimestampsUs(payloads)
    expect(triggers).toHaveLength(1)

    const usPerSample = 1_000_000 / samplingRate
    const expectedTimestampUs = BigInt(Math.round((numSamplesPerPayload - 1) * usPerSample))
    expect(triggers[0]).toBe(expectedTimestampUs)
  })
})

async function resetDatabase() {
  await dbPool.query(
    'TRUNCATE TABLE erp_analysis_results, session_object_links, session_events, images, audio_clips, raw_data_objects, sessions, experiment_participants, experiment_stimuli, export_tasks, experiments CASCADE',
  )
  await dbPool.query('TRUNCATE TABLE calibration_items RESTART IDENTITY CASCADE')
}

async function seedCalibrationAssets() {
  for (const asset of [
    { f: 'face01.png', t: 'target' },
    { f: 'house01.png', t: 'nontarget' },
  ]) {
    const objectId = `stimuli/calibration/${asset.f}`
    await objectStorageClient.fPutObject(OBJECT_STORAGE_MEDIA_BUCKET, objectId, path.join(ASSETS_DIR, asset.f))
    await dbPool.query(
      'INSERT INTO calibration_items (file_name, item_type, object_id) VALUES ($1, $2, $3)',
      [asset.f, asset.t, objectId],
    )
  }
}

async function sendCollectorData(
  userId: string,
  sessionId: string | null,
  profile: DeviceProfile,
  start: Date,
  end: Date,
  buffer: Buffer,
): Promise<number> {
  const compressed = Buffer.from(compress(buffer))
  const resp = await fetch(`${BASE_URL}/data`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      user_id: userId,
      session_id: sessionId,
      device_id: profile.deviceId,
      timestamp_start_ms: start.getTime(),
      timestamp_end_ms: end.getTime(),
      sampling_rate: profile.samplingRate,
      lsb_to_volts: profile.lsbToVolts,
      payload_base64: compressed.toString('base64'),
    }),
  })
  return resp.status
}

async function waitForRowCount(
  table: string,
  conditions: string,
  expected: number,
  timeout = 30000,
) {
  const start = Date.now()
  while (Date.now() - start < timeout) {
    const { rows } = await dbPool.query(`SELECT COUNT(*)::int FROM ${table} WHERE ${conditions}`)
    if ((rows[0]?.count ?? 0) >= expected) return rows[0].count
    await sleep(1000)
  }
  throw new Error(`Timed out waiting for ${expected} rows in ${table} where ${conditions}`)
}

async function extractZipArchive(zipArchive: JSZip, destinationDir: string) {
  await fs.rm(destinationDir, { recursive: true, force: true })
  await fs.mkdir(destinationDir, { recursive: true })

  const entries = Object.values(zipArchive.files)
  for (const entry of entries) {
    const targetPath = path.join(destinationDir, entry.name)
    if (entry.dir) {
      await fs.mkdir(targetPath, { recursive: true })
      continue
    }
    await fs.mkdir(path.dirname(targetPath), { recursive: true })
    const content = await entry.async('nodebuffer')
    await fs.writeFile(targetPath, content)
  }
}

async function runTestScenario(config: ScenarioConfig): Promise<WorkflowContext> {
  const { deviceProfile, withEvents, ownerId, participantId, strangerId } = config
  const ctx: WorkflowContext = { deviceProfile, withEvents }

  console.log(
    `\n\n--- 🚀 Starting Test Scenario: ${deviceProfile.deviceId} (Events: ${withEvents}) ---`,
  )

  console.log('\n--- 🧪 [1/8] 実験の作成と刺激のアップロード ---')
  const expResp = await fetch(`${BASE_URL}/experiments`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-User-Id': ownerId },
    body: JSON.stringify({ name: `Test Exp - ${deviceProfile.deviceId}` }),
  })
  const expData = (await expResp.json()) as ExperimentResponse
  ctx.experimentId = expData.experiment_id
  console.log(`✅ Experiment created with ID: ${ctx.experimentId}`)

  const stimuliForm = new FormData()
  stimuliForm.append(
    'stimuli_definition_csv',
    Bun.file(path.join(ASSETS_DIR, 'stimuli_definition.csv')),
  )
  stimuliForm.append(
    'stimulus_files',
    Bun.file(path.join(ASSETS_DIR, 'product_a.png')),
    'product_a.png',
  )
  stimuliForm.append(
    'stimulus_files',
    Bun.file(path.join(ASSETS_DIR, 'product_b.png')),
    'product_b.png',
  )
  const stimuliUploadResp = await fetch(`${BASE_URL}/experiments/${ctx.experimentId}/stimuli`, {
    method: 'POST',
    headers: { 'X-User-Id': ownerId },
    body: stimuliForm,
  })
  ctx.stimuliUploadStatus = stimuliUploadResp.status
  await waitForRowCount('experiment_stimuli', `experiment_id = '${ctx.experimentId}'`, 2)
  console.log('✅ 2 stimulus files uploaded and metadata saved.')

  console.log('\n--- 🧑‍🔬 [2/8] 参加者の実験参加と権限テスト ---')
  await fetch(`${BASE_URL}/auth/experiments/${ctx.experimentId}/join`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user_id: participantId }),
  })
  console.log(`✅ Participant ${participantId} joined the experiment.`)
  const strangerStimuliResp = await fetch(`${BASE_URL}/experiments/${ctx.experimentId}/stimuli`, {
    method: 'POST',
    headers: { 'X-User-Id': strangerId },
    body: new FormData(),
  })
  ctx.unauthorizedStimuliUploadStatus = strangerStimuliResp.status
  console.log(
    `✅ Unauthorized stimuli upload attempt by stranger responded with: ${ctx.unauthorizedStimuliUploadStatus} (expected 403)`,
  )

  console.log('\n--- ▶️ [3/8] セッションの開始 ---')
  const now = Date.now()
  ctx.calibSession = { id: `cal-${now}`, start: new Date(now), type: 'calibration' }
  ctx.mainSession = { id: `main-${now}`, start: new Date(now + 30000), type: 'main_external' }

  for (const s of [ctx.calibSession, ctx.mainSession]) {
    await fetch(`${BASE_URL}/sessions/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-User-Id': participantId },
      body: JSON.stringify({
        session_id: s.id,
        user_id: participantId,
        experiment_id: ctx.experimentId,
        start_time: s.start.toISOString(),
        session_type: s.type,
      }),
    })
    console.log(`✅ Session started: ${s.type} (ID: ${s.id})`)
  }

  console.log('\n--- 🧠 [4/8] 生体データ(EEG)の送信 ---')
  const samplesPerChunk = Math.floor(deviceProfile.samplingRate)
  const chunkDurationMs = (samplesPerChunk / deviceProfile.samplingRate) * 1000
  // [修正] タイムアウトの原因となっていたデータ送信量を5秒から10秒に修正
  // サーバー側の`realtime_analyzer`が10秒分のデータを要求するため
  const ANALYSIS_WINDOW_SECONDS = 15

  console.log(`  - Sending ${ANALYSIS_WINDOW_SECONDS} seconds of data...`)

  for (let i = 0; i < ANALYSIS_WINDOW_SECONDS; i++) {
    // どのセッションのデータとして送信するかを決定 (例: 最初の3秒をキャリブレーションに)
    const session = i < 3 ? ctx.calibSession : ctx.mainSession
    const chunkBaseTime = session.start.getTime()

    const chunkStartTime = new Date(chunkBaseTime + i * chunkDurationMs)
    const chunkEndTime = new Date(chunkStartTime.getTime() + chunkDurationMs)

    const triggerEvents = withEvents ? { [50 + i * 10]: 1, [150 + i * 15]: 2 } : {}
    const buffer = createMockBinaryPayload(deviceProfile, samplesPerChunk, triggerEvents, i)

    await sendCollectorData(
      participantId,
      session.id,
      deviceProfile,
      chunkStartTime,
      chunkEndTime,
      buffer,
    )
    // RabbitMQがメッセージを処理する時間を与える
    await sleep(200)
  }
  console.log(`✅ Data sending complete.`)

  console.log('\n--- ⏹️ [5/8] セッションの終了とイベントログのアップロード ---')
  for (const s of [ctx.calibSession, ctx.mainSession]) {
    s.end = new Date(s.start.getTime() + 25000) // 25秒間のセッションだったとする
    const form = new FormData()
    form.append(
      'metadata',
      JSON.stringify({
        session_id: s.id,
        user_id: participantId,
        experiment_id: ctx.experimentId,
        device_id: deviceProfile.deviceId,
        start_time: s.start.toISOString(),
        end_time: s.end.toISOString(),
        session_type: s.type,
      }),
    )
    if (withEvents) {
      const csvFile = s.type === 'calibration' ? 'calibration_events.csv' : 'main_task_events.csv'
      form.append('events_log_csv', Bun.file(path.join(ASSETS_DIR, csvFile)))
      console.log(`📎 Attaching ${csvFile} for session ${s.id}`)
    }
    await fetch(`${BASE_URL}/sessions/end`, {
      method: 'POST',
      headers: { 'X-User-Id': participantId },
      body: form,
    })
    console.log(`✅ Session ended: ${s.type} (ID: ${s.id})`)
  }

  console.log('\n--- ⏳ [6/8] バックグラウンド処理の完了を待機 ---')
  for (const s of [ctx.calibSession, ctx.mainSession]) {
    console.log(`  - Waiting for DataLinker on session ${s.id}...`)
    await pollForDbStatus(
      'SELECT link_status AS status FROM sessions WHERE session_id = $1',
      [s.id],
      'completed',
    )
    console.log(`    ✅ DataLinker completed.`)
    console.log(`  - Waiting for EventCorrector on session ${s.id}...`)
    await pollForDbStatus(
      'SELECT event_correction_status AS status FROM sessions WHERE session_id = $1',
      [s.id],
      'completed',
    )
    console.log(`    ✅ EventCorrector completed.`)
  }

  if (!ctx.calibSession || !ctx.mainSession) {
    throw new Error('Session metadata is missing from workflow context.')
  }

  console.log('\n--- 📈 [Realtime] リアルタイム解析結果の確認 ---')
  const realtimeAnalysis = await pollForRealtimeAnalysis(participantId)
  ctx.realtimeAnalysis = realtimeAnalysis
  ctx.realtimeImageDir = await persistRealtimeImages(realtimeAnalysis, participantId)
  console.log(
    `✅ Realtime analyzer returned results for ${
      Object.keys(realtimeAnalysis.applications).length
    } applications.`,
  )

  const [calibRawObjectCount, mainRawObjectCount, calibLinkedObjectsCount, mainLinkedObjectsCount] =
    await Promise.all([
      dbPool
        .query<{ count: string }>(
          `SELECT COUNT(*)::int AS count FROM raw_data_objects WHERE session_id = $1`,
          [ctx.calibSession.id],
        )
        .then((res) => Number(res.rows[0]?.count ?? 0)),
      dbPool
        .query<{ count: string }>(
          `SELECT COUNT(*)::int AS count FROM raw_data_objects WHERE session_id = $1`,
          [ctx.mainSession.id],
        )
        .then((res) => Number(res.rows[0]?.count ?? 0)),
      dbPool
        .query<{ count: string }>(
          `SELECT COUNT(*)::int AS count FROM session_object_links WHERE session_id = $1`,
          [ctx.calibSession.id],
        )
        .then((res) => Number(res.rows[0]?.count ?? 0)),
      dbPool
        .query<{ count: string }>(
          `SELECT COUNT(*)::int AS count FROM session_object_links WHERE session_id = $1`,
          [ctx.mainSession.id],
        )
        .then((res) => Number(res.rows[0]?.count ?? 0)),
    ])

  ctx.calibRawObjectCount = calibRawObjectCount
  ctx.mainRawObjectCount = mainRawObjectCount
  ctx.calibLinkedObjectsCount = calibLinkedObjectsCount
  ctx.mainLinkedObjectsCount = mainLinkedObjectsCount

  console.log('\n--- 📦 [7/8] BIDSエクスポートの実行と権限テスト ---')
  if (!ctx.experimentId) {
    throw new Error('Experiment ID was not set')
  }

  const exportResp = await fetch(`${BASE_URL}/experiments/${ctx.experimentId}/export`, {
    method: 'POST',
    headers: { 'X-User-Id': ownerId },
  })
  ctx.bidsTaskStatus = exportResp.status
  const exportData = (await exportResp.json()) as ExportTaskAccepted
  ctx.bidsTaskId = exportData.task_id
  console.log(`✅ BIDS export task started with ID: ${ctx.bidsTaskId}`)

  const strangerExportResp = await fetch(`${BASE_URL}/experiments/${ctx.experimentId}/export`, {
    method: 'POST',
    headers: { 'X-User-Id': strangerId },
  })
  ctx.unauthorizedExportStatus = strangerExportResp.status
  console.log(
    `✅ Unauthorized export attempt by stranger responded with: ${ctx.unauthorizedExportStatus} (expected 403)`,
  )

  if (!ctx.bidsTaskId) {
    throw new Error('BIDS task ID was not set')
  }
  const completedTask = await pollForTaskStatus(ctx.bidsTaskId, 'completed')
  console.log(`✅ BIDS export task completed. Result path: ${completedTask.result_file_path}`)
  const downloadResp = await fetch(`${BASE_URL}/export-tasks/${ctx.bidsTaskId}/download`)
  ctx.zipBuffer = Buffer.from(await downloadResp.arrayBuffer())
  const zip = await JSZip.loadAsync(ctx.zipBuffer)
  ctx.bidsArchiveEntries = Object.keys(zip.files)
  ctx.zip = zip
  console.log(`✅ BIDS archive downloaded and contains ${ctx.bidsArchiveEntries.length} files.`)
  if (ctx.bidsTaskId) {
    const zipOutputPath = path.join(TEST_OUTPUT_DIR, `bids_task_${ctx.bidsTaskId}.zip`)
    await fs.writeFile(zipOutputPath, ctx.zipBuffer)
    const extractionDir = path.join(TEST_OUTPUT_DIR, `bids_task_${ctx.bidsTaskId}`)
    await extractZipArchive(zip, extractionDir)
    ctx.bidsZipPath = zipOutputPath
    ctx.bidsExtractedDir = extractionDir
    console.log(`📁 BIDS archive extracted to ${extractionDir}`)
  }

  if (withEvents) {
    console.log('\n--- 🤖 [8/8] ERPニューロマーケティング分析の実行 ---')
    const erpResp = await fetch(
      `${BASE_URL}/neuro-marketing/experiments/${ctx.experimentId}/analyze`,
      { method: 'POST', headers: { 'X-User-Id': ownerId } },
    )
    ctx.erpAnalysisStatus = erpResp.status
    console.log(`✅ Analysis service responded with status: ${ctx.erpAnalysisStatus}`)
    if (erpResp.ok) {
      ctx.erpAnalysis = (await erpResp.json()) as ErpAnalysisResponse
      console.log('\n---------- 🤖 Geminiからのニューロマーケティング分析サマリー 🤖 ----------')
      console.log(ctx.erpAnalysis.summary)
      console.log('--------------------------------------------------------------------')
    } else {
      const errorBody = (await erpResp.json()) as ErrorResponse
      console.error(`❌ Analysis failed:`, errorBody.detail || 'Unknown error')
    }
  }

  const rawDataQuery = await dbPool.query<RawDataObjectRow>(
    `SELECT object_id, sampling_rate, lsb_to_volts, start_time, end_time
       FROM raw_data_objects
      WHERE user_id = $1
      ORDER BY timestamp_start_ms ASC`,
    [participantId],
  )
  ctx.rawDataObjects = rawDataQuery.rows

  const [calibCorrected, mainCorrected] = await Promise.all([
    dbPool
      .query<{ count: string }>(
        `SELECT COUNT(*)::int AS count FROM session_events WHERE session_id = $1 AND onset_corrected_us IS NOT NULL`,
        [ctx.calibSession.id],
      )
      .then((res) => Number(res.rows[0]?.count ?? 0)),
    dbPool
      .query<{ count: string }>(
        `SELECT COUNT(*)::int AS count FROM session_events WHERE session_id = $1 AND onset_corrected_us IS NOT NULL`,
        [ctx.mainSession.id],
      )
      .then((res) => Number(res.rows[0]?.count ?? 0)),
  ])

  ctx.calibCorrectedCount = calibCorrected
  ctx.mainCorrectedCount = mainCorrected

  return ctx
}

// --- Test Suite ---
beforeAll(async () => {
  await initZstd()
  dbPool = new Pool({ connectionString: DATABASE_URL })
  objectStorageClient = createObjectStorageTestClient(OBJECT_STORAGE_CONFIG)
  await fs.mkdir(TEST_OUTPUT_DIR, { recursive: true })
})

afterAll(async () => {
  await dbPool.end()
})

describe('Integration Test Suite', () => {
  describe('Scenario 1: Custom EEG with Events and Triggers', () => {
    let workflowPromise: Promise<WorkflowContext> | null = null
    const ownerId = `owner-eeg-${Date.now()}`
    const participantId = `part-eeg-${Date.now()}`
    const strangerId = `stranger-eeg-${Date.now()}`

    const ensureWorkflow = async (): Promise<WorkflowContext> => {
      if (!workflowPromise) {
        workflowPromise = (async () => {
          await resetDatabase()
          await seedCalibrationAssets()
          return runTestScenario({
            deviceProfile: MOCK_CUSTOM_EEG_DEVICE,
            withEvents: true,
            ownerId,
            participantId,
            strangerId,
          })
        })()
      }
      return workflowPromise!
    }

    test(
      'Processor saves correct metadata to DB and DataLinker normalizes timestamps',
      async () => {
        const workflow = await ensureWorkflow()
        expect(workflow.rawDataObjects).toBeDefined()
        const rawObjects = workflow.rawDataObjects ?? []
        expect(rawObjects.length).toBeGreaterThanOrEqual(12)
        for (const row of rawObjects) {
          expect(row.sampling_rate).toBe(MOCK_CUSTOM_EEG_DEVICE.samplingRate)
          expect(row.lsb_to_volts).toBeCloseTo(MOCK_CUSTOM_EEG_DEVICE.lsbToVolts)
          const startTime =
            row.start_time instanceof Date ? row.start_time : new Date(row.start_time)
          const endTime = row.end_time instanceof Date ? row.end_time : new Date(row.end_time)
          expect(startTime).toBeInstanceOf(Date)
          expect(endTime).toBeInstanceOf(Date)
          expect(startTime.getTime()).toBeLessThanOrEqual(endTime.getTime())
        }
      },
      { timeout: 180_000 },
    )

    test(
      'DataLinker links all raw data objects without omissions',
      async () => {
        const workflow = await ensureWorkflow()
        expect(workflow.calibRawObjectCount ?? 0).toBeGreaterThan(0)
        expect(workflow.calibLinkedObjectsCount).toBe(workflow.calibRawObjectCount)
        expect(workflow.mainRawObjectCount ?? 0).toBeGreaterThan(1)
        expect(workflow.mainLinkedObjectsCount).toBe(workflow.mainRawObjectCount)
      },
      { timeout: 180_000 },
    )

    test(
      'background processing completes with corrected events',
      async () => {
        const workflow = await ensureWorkflow()
        expect(workflow.calibCorrectedCount ?? 0).toBeGreaterThanOrEqual(3)
        expect(workflow.mainCorrectedCount ?? 0).toBeGreaterThanOrEqual(2)
      },
      { timeout: 180_000 },
    )

    test(
      'realtime analyzer returns PSD and coherence images',
      async () => {
        const workflow = await ensureWorkflow()
        expect(workflow.realtimeAnalysis).toBeDefined()
        const realtimeAnalysis = workflow.realtimeAnalysis!
        const summary = realtimeAnalysis.available_applications.find(
          (application) => application.id === 'psd_coherence',
        )
        expect(summary).toBeDefined()
        const result = realtimeAnalysis.applications.psd_coherence
        expect(result).toBeDefined()
        expect(result.psd_image).toBeString()
        expect(result.psd_image).not.toBeEmpty()
        expect(result.coherence_image).toBeString()
        expect(result.coherence_image).not.toBeEmpty()
        expect(result.analysis_channels.length).toBeGreaterThan(1)
      },
      { timeout: 180_000 },
    )

    test(
      'corrected event onsets remain strictly increasing per session',
      async () => {
        const workflow = await ensureWorkflow()
        const subjectId = participantId.replace(/-/g, '')
        const zipArchive = workflow.zip!
        const calibEventsPath = `bids_dataset/sub-${subjectId}/ses-1/eeg/sub-${subjectId}_ses-1_task-calibration_events.tsv`
        const mainEventsPath = `bids_dataset/sub-${subjectId}/ses-2/eeg/sub-${subjectId}_ses-2_task-mainexternal_events.tsv`
        const calibEvents = await neatCSV(
          (await zipArchive.file(calibEventsPath)?.async('string')) ?? '',
          {
            mapHeaders: ({ header }) => header.toLowerCase(),
            separator: '\t',
          },
        )
        const mainEvents = await neatCSV(
          (await zipArchive.file(mainEventsPath)?.async('string')) ?? '',
          {
            mapHeaders: ({ header }) => header.toLowerCase(),
            separator: '\t',
          },
        )
        type CsvRow = Record<string, string>
        const ensureStrictlyIncreasing = (rows: CsvRow[]) => {
          const onsetValues = rows.map((row) => Number.parseFloat(row.onset ?? '0'))
          onsetValues.forEach((value) => expect(Number.isFinite(value)).toBe(true))
          let hasStrictIncrease = false
          for (let i = 1; i < onsetValues.length; i++) {
            expect(onsetValues[i]).toBeGreaterThanOrEqual(onsetValues[i - 1])
            if (onsetValues[i] > onsetValues[i - 1]) {
              hasStrictIncrease = true
            }
          }
          expect(onsetValues.length === 0 || hasStrictIncrease).toBe(true)
        }
        ensureStrictlyIncreasing(calibEvents)
        ensureStrictlyIncreasing(mainEvents)
      },
      { timeout: 180_000 },
    )

    test(
      'BIDS exporter produces archive with valid events.tsv files',
      async () => {
        const workflow = await ensureWorkflow()
        const subjectId = participantId.replace(/-/g, '')
        const calibEventsPath = `bids_dataset/sub-${subjectId}/ses-1/eeg/sub-${subjectId}_ses-1_task-calibration_events.tsv`
        const mainEventsPath = `bids_dataset/sub-${subjectId}/ses-2/eeg/sub-${subjectId}_ses-2_task-mainexternal_events.tsv`

        const archiveEntries = workflow.bidsArchiveEntries ?? []
        expect(archiveEntries).toContain(calibEventsPath)
        expect(archiveEntries).toContain(mainEventsPath)

        expect(workflow.zip).toBeDefined()
        const zipArchive = workflow.zip!

        const calibTsvContent = await zipArchive.file(calibEventsPath)?.async('string')
        const mainTsvContent = await zipArchive.file(mainEventsPath)?.async('string')

        expect(calibTsvContent).toBeDefined()
        expect(mainTsvContent).toBeDefined()

        const calibEvents = await neatCSV(calibTsvContent!, {
          mapHeaders: ({ header }) => header.toLowerCase(),
          separator: '\t',
        })
        const mainEvents = await neatCSV(mainTsvContent!, {
          mapHeaders: ({ header }) => header.toLowerCase(),
          separator: '\t',
        })

        expect(calibEvents.length).toBe(3)
        expect(mainEvents.length).toBe(2)

        const calibChannelsPath = `bids_dataset/sub-${subjectId}/ses-1/eeg/sub-${subjectId}_ses-1_task-calibration_channels.tsv`
        const mainChannelsPath = `bids_dataset/sub-${subjectId}/ses-2/eeg/sub-${subjectId}_ses-2_task-mainexternal_channels.tsv`
        expect(archiveEntries).toContain(calibChannelsPath)
        expect(archiveEntries).toContain(mainChannelsPath)

        const calibChannelsContent = await zipArchive.file(calibChannelsPath)?.async('string')
        const mainChannelsContent = await zipArchive.file(mainChannelsPath)?.async('string')
        expect(calibChannelsContent).toBeDefined()
        expect(mainChannelsContent).toBeDefined()

        const calibChannels = await neatCSV(calibChannelsContent!, {
          mapHeaders: ({ header }) => header.toLowerCase(),
          separator: '\t',
        })
        const mainChannels = await neatCSV(mainChannelsContent!, {
          mapHeaders: ({ header }) => header.toLowerCase(),
          separator: '\t',
        })

        for (const row of [...calibChannels, ...mainChannels]) {
          if (!row.name) continue
          const status = row.status ?? ''
          const statusDescription = row.status_description ?? ''
          expect(status).not.toBe('')
          expect(statusDescription).not.toBe('')
        }
      },
      { timeout: 180_000 },
    )

    test(
      'BIDS channel quality metadata is generated',
      async () => {
        const workflow = await ensureWorkflow()
        const subjectId = participantId.replace(/-/g, '')
        const calibQualityPath = `bids_dataset/sub-${subjectId}/ses-1/eeg/sub-${subjectId}_ses-1_task-calibration_desc-quality_channels.json`
        const mainQualityPath = `bids_dataset/sub-${subjectId}/ses-2/eeg/sub-${subjectId}_ses-2_task-mainexternal_desc-quality_channels.json`

        const archiveEntries = workflow.bidsArchiveEntries ?? []
        expect(archiveEntries).toContain(calibQualityPath)
        expect(archiveEntries).toContain(mainQualityPath)

        const zipArchive = workflow.zip!
        const calibQualityContent = await zipArchive.file(calibQualityPath)?.async('string')
        const mainQualityContent = await zipArchive.file(mainQualityPath)?.async('string')
        expect(calibQualityContent).toBeDefined()
        expect(mainQualityContent).toBeDefined()

        const calibReport = JSON.parse(calibQualityContent!)
        const mainReport = JSON.parse(mainQualityContent!)

        for (const report of [calibReport, mainReport]) {
          for (const value of Object.values(report) as any[]) {
            expect(typeof value.status).toBe('string')
            expect(Array.isArray(value.reasons)).toBe(true)
          }
          const reportChannels = Object.keys(report)
          const expectedChannels = MOCK_CUSTOM_EEG_DEVICE.electrodes
            .filter((electrode) => electrode.type === 0)
            .map((electrode) => electrode.name)
          for (const channel of expectedChannels) {
            expect(reportChannels).toContain(channel)
          }
        }
      },
      { timeout: 180_000 },
    )

    test(
      'BIDS sidecar JSON includes standardized metadata',
      async () => {
        const workflow = await ensureWorkflow()
        const subjectId = participantId.replace(/-/g, '')
        const zipArchive = workflow.zip!
        const calibSidecarPath = `bids_dataset/sub-${subjectId}/ses-1/eeg/sub-${subjectId}_ses-1_task-calibration_eeg.json`
        const mainSidecarPath = `bids_dataset/sub-${subjectId}/ses-2/eeg/sub-${subjectId}_ses-2_task-mainexternal_eeg.json`
        const calibSidecar = JSON.parse(
          (await zipArchive.file(calibSidecarPath)?.async('string')) ?? '{}',
        )
        const mainSidecar = JSON.parse(
          (await zipArchive.file(mainSidecarPath)?.async('string')) ?? '{}',
        )
        for (const sidecar of [calibSidecar, mainSidecar]) {
          expect(sidecar.PowerLineFrequency).toBe(50)
          expect(sidecar.EEGReference).toBe('n/a')
        }
      },
      { timeout: 180_000 },
    )

    test(
      'ERP neuro-marketing service returns successful analysis',
      async () => {
        const workflow = await ensureWorkflow()
        expect(workflow.erpAnalysisStatus).toBe(200)
        expect(workflow.erpAnalysis).toBeDefined()
        const erpAnalysis = workflow.erpAnalysis!
        expect(erpAnalysis.summary).toBeString()
        expect(erpAnalysis.summary).not.toBeEmpty()
        expect(erpAnalysis.recommendations.length).toBeGreaterThanOrEqual(1)
        const recommendedFiles = erpAnalysis.recommendations.map((r) => r.file_name)
        expect(
          recommendedFiles.find((file: string) => /product_[ab]\.png$/.test(file)),
        ).toBeDefined()
      },
      { timeout: 180_000 },
    )

    test(
      'authorization boundaries are enforced',
      async () => {
        const workflow = await ensureWorkflow()
        expect(workflow.unauthorizedStimuliUploadStatus).toBe(403)
        expect(workflow.unauthorizedExportStatus).toBe(403)
      },
      { timeout: 180_000 },
    )
  })

  describe('Scenario 2: Muse 2 without Events or Triggers', () => {
    let workflowPromise: Promise<WorkflowContext> | null = null
    const ownerId = `owner-muse-${Date.now()}`
    const participantId = `part-muse-${Date.now()}`
    const strangerId = `stranger-muse-${Date.now()}`

    const ensureWorkflow = async (): Promise<WorkflowContext> => {
      if (!workflowPromise) {
        workflowPromise = (async () => {
          await resetDatabase()
          await seedCalibrationAssets()
          return runTestScenario({
            deviceProfile: MOCK_MUSE2_DEVICE,
            withEvents: false,
            ownerId,
            participantId,
            strangerId,
          })
        })()
      }
      return workflowPromise!
    }

    test(
      'background processing completes without events',
      async () => {
        const workflow = await ensureWorkflow()
        expect(workflow.calibCorrectedCount ?? 0).toBe(0)
        expect(workflow.mainCorrectedCount ?? 0).toBe(0)
      },
      { timeout: 180_000 },
    )

    test(
      'realtime analyzer returns PSD and coherence images for Muse device',
      async () => {
        const workflow = await ensureWorkflow()
        expect(workflow.realtimeAnalysis).toBeDefined()
        const realtimeAnalysis = workflow.realtimeAnalysis!
        const summary = realtimeAnalysis.available_applications.find(
          (application) => application.id === 'psd_coherence',
        )
        expect(summary).toBeDefined()
        const result = realtimeAnalysis.applications.psd_coherence
        expect(result).toBeDefined()
        expect(result.psd_image).toBeString()
        expect(result.psd_image).not.toBeEmpty()
        expect(result.coherence_image).toBeString()
        expect(result.coherence_image).not.toBeEmpty()
        expect(result.analysis_channels.length).toBeGreaterThan(1)
      },
      { timeout: 180_000 },
    )

    test(
      'BIDS exporter produces archive without events.tsv files',
      async () => {
        const workflow = await ensureWorkflow()
        const subjectId = participantId.replace(/-/g, '')
        const calibEventsPath = `bids_dataset/sub-${subjectId}/ses-1/eeg/sub-${subjectId}_ses-1_task-calibration_events.tsv`
        const mainEventsPath = `bids_dataset/sub-${subjectId}/ses-2/eeg/sub-${subjectId}_ses-2_task-mainexternal_events.tsv`
        const museArchiveEntries = workflow.bidsArchiveEntries ?? []
        expect(museArchiveEntries).not.toContain(calibEventsPath)
        expect(museArchiveEntries).not.toContain(mainEventsPath)
      },
      { timeout: 180_000 },
    )

    test(
      'ERP neuro-marketing analysis is skipped when triggers are absent',
      async () => {
        const workflow = await ensureWorkflow()
        expect(workflow.erpAnalysisStatus).toBeUndefined()
        expect(workflow.erpAnalysis).toBeUndefined()
      },
      { timeout: 180_000 },
    )

    test(
      'DataLinker still creates session links for raw data streams',
      async () => {
        const workflow = await ensureWorkflow()
        expect(workflow.calibRawObjectCount ?? 0).toBeGreaterThan(0)
        expect(workflow.calibLinkedObjectsCount).toBe(workflow.calibRawObjectCount)
        expect(workflow.mainRawObjectCount ?? 0).toBeGreaterThan(0)
        expect(workflow.mainLinkedObjectsCount).toBe(workflow.mainRawObjectCount)
      },
      { timeout: 180_000 },
    )
  })
})
