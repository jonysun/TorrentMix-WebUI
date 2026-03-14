import { spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

export const MARKER_FILE = '.webui-version.json'

export function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

export function sha256Hex(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex')
}

export function createSidecarConfig(env = process.env) {
  return {
    latestUrl: String(env.LATEST_URL || '').trim(),
    targetDir: String(env.TARGET_DIR || '/target').trim(),
    checkIntervalSec: Number.parseInt(String(env.CHECK_INTERVAL_SEC || '3600'), 10),
    tmpRoot: String(env.TMP_ROOT || '/tmp/webui-sidecar').trim(),
    logger: console,
  }
}

export async function fetchJson(url, timeoutMs = 15000) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(url, { cache: 'no-store', signal: controller.signal })
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`)
    return await res.json()
  } finally {
    clearTimeout(timer)
  }
}

export async function download(url, outPath, timeoutMs = 60000) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(url, { cache: 'no-store', signal: controller.signal })
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`)
    const arrayBuffer = await res.arrayBuffer()
    const buf = Buffer.from(arrayBuffer)
    await fs.writeFile(outPath, buf)
    return buf
  } finally {
    clearTimeout(timer)
  }
}

export async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true })
}

export async function emptyDir(dir) {
  await ensureDir(dir)
  const entries = await fs.readdir(dir)
  await Promise.all(entries.map(name => fs.rm(path.join(dir, name), { recursive: true, force: true })))
}

export async function copyDir(src, dest) {
  await fs.cp(src, dest, { recursive: true })
}

export function unzip(zipPath, destDir) {
  const res = spawnSync('unzip', ['-q', '-o', zipPath, '-d', destDir], { stdio: 'inherit' })
  if (res.status !== 0) throw new Error('unzip failed')
}

export async function readInstalledMarker(targetDir) {
  try {
    const raw = await fs.readFile(path.join(targetDir, MARKER_FILE), 'utf8')
    return JSON.parse(raw)
  } catch {
    return null
  }
}

export async function writeInstalledMarker(targetDir, marker) {
  await fs.writeFile(path.join(targetDir, MARKER_FILE), JSON.stringify(marker, null, 2) + '\n', 'utf8')
}

export function resolveZipUrl(latestUrl, latestJson) {
  if (latestJson?.release?.distZip) {
    return new URL(String(latestJson.release.distZip), latestUrl).toString()
  }
  return null
}

export async function validateExtractedWebuiRoot(extractDir) {
  const indexPath = path.join(extractDir, 'index.html')
  let indexStat
  try {
    indexStat = await fs.stat(indexPath)
  } catch {
    throw new Error('invalid zip: index.html not found at root')
  }
  if (!indexStat.isFile()) {
    throw new Error('invalid zip: index.html is not a file')
  }
}

export async function installOnce(config = createSidecarConfig(), overrides = {}) {
  const {
    latestUrl,
    targetDir,
    tmpRoot,
    logger = console,
  } = config

  const deps = {
    fetchJson,
    download,
    ensureDir,
    emptyDir,
    copyDir,
    unzip,
    now: () => new Date(),
    ...overrides,
  }

  if (!latestUrl) {
    throw new Error('LATEST_URL is required (points to latest.json)')
  }

  logger.log(`[sidecar] checking ${latestUrl}`)
  const latest = await deps.fetchJson(latestUrl)
  const version = String(latest?.version || 'unknown')
  const zipUrl = resolveZipUrl(latestUrl, latest)
  const expectedZipSha256 = String(latest?.release?.distZipSha256 || '').trim().toLowerCase()

  if (!zipUrl) {
    throw new Error('latest.json does not contain release.distZip; cannot sidecar-install')
  }

  const installed = await readInstalledMarker(targetDir)
  if (
    installed?.version === version &&
    installed?.zipUrl === zipUrl &&
    (!expectedZipSha256 || installed?.zipSha256 === expectedZipSha256)
  ) {
    logger.log(`[sidecar] up-to-date: ${version}`)
    return { status: 'up-to-date', version, zipUrl }
  }

  logger.log(`[sidecar] downloading ${zipUrl}`)
  const zipPath = path.join(tmpRoot, 'dist.zip')
  const extractDir = path.join(tmpRoot, 'extract')
  await deps.ensureDir(tmpRoot)
  await fs.rm(extractDir, { recursive: true, force: true })

  const zipBuf = await deps.download(zipUrl, zipPath)
  const zipSha256 = sha256Hex(zipBuf)
  if (expectedZipSha256 && zipSha256 !== expectedZipSha256) {
    throw new Error(`zip sha256 mismatch: expected=${expectedZipSha256}, got=${zipSha256}`)
  }

  logger.log('[sidecar] extracting…')
  await Promise.resolve(deps.unzip(zipPath, extractDir))
  await validateExtractedWebuiRoot(extractDir)

  logger.log(`[sidecar] installing to ${targetDir}`)
  await deps.emptyDir(targetDir)
  await deps.copyDir(extractDir, targetDir)
  await writeInstalledMarker(targetDir, {
    version,
    zipUrl,
    zipSha256,
    installedAt: deps.now().toISOString(),
  })

  logger.log(`[sidecar] installed: ${version}`)
  return { status: 'installed', version, zipUrl, zipSha256 }
}

export async function main(config = createSidecarConfig()) {
  const { targetDir, checkIntervalSec, logger = console } = config
  await ensureDir(targetDir)

  if (!Number.isFinite(checkIntervalSec) || checkIntervalSec <= 0) {
    await installOnce(config)
    return
  }

  let stopped = false
  const stop = (signal) => {
    if (stopped) return
    stopped = true
    logger.log(`[sidecar] ${signal} received, stopping…`)
  }

  process.on('SIGTERM', () => stop('SIGTERM'))
  process.on('SIGINT', () => stop('SIGINT'))

  while (!stopped) {
    try {
      await installOnce(config)
    } catch (err) {
      logger.error('[sidecar] update failed:', err?.stack || err?.message || err)
    }

    if (stopped) break
    await sleep(checkIntervalSec * 1000)
  }
}

function isDirectExecution(metaUrl) {
  if (!process.argv[1]) return false
  return metaUrl === pathToFileURL(path.resolve(process.argv[1])).href
}

if (isDirectExecution(import.meta.url)) {
  await main()
}
