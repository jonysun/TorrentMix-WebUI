import { execSync, spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const ROOT = process.cwd()
const DIST_DIR = path.join(ROOT, 'dist')
const OUT_DIR = path.join(ROOT, 'artifacts', 'publish')
const CHANNEL = process.env.CHANNEL?.trim() || 'stable'

export function run(cmd, opts = {}) {
  execSync(cmd, { stdio: 'inherit', ...opts })
}

export function runCapture(cmd, opts = {}) {
  return execSync(cmd, { stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8', ...opts }).trim()
}

export async function ensureEmptyDir(dir) {
  await fs.rm(dir, { recursive: true, force: true })
  await fs.mkdir(dir, { recursive: true })
}

export async function copyDir(src, dest) {
  await fs.cp(src, dest, { recursive: true })
}

export async function listFilesRecursive(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true })
  const files = []
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      files.push(...await listFilesRecursive(full))
      continue
    }
    if (entry.isFile()) files.push(full)
  }
  return files
}

export function sha256Hex(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex')
}

export function sha256Base64(buf) {
  return crypto.createHash('sha256').update(buf).digest('base64')
}

export function toIntegrity(sha256b64) {
  return `sha256-${sha256b64}`
}

export function normalizeRelPath(relPath) {
  return String(relPath || '').replace(/\\/g, '/').replace(/^\.\//, '')
}

function isRelativeContractPath(value) {
  const raw = String(value || '').trim()
  if (!raw) return false
  if (/^[a-z]+:\/\//i.test(raw)) return false
  if (raw.startsWith('/')) return false
  if (raw.startsWith('../')) return false
  return true
}

export function getCanonicalReleaseFileSet(version) {
  return {
    topLevel: ['latest.json', 'manifest.json', 'loader.html'],
    versioned: [
      `releases/${version}/manifest.json`,
      `releases/${version}/loader.html`,
      `releases/${version}/dist.zip`,
    ],
  }
}

export function validateLatestReleaseContract(latest) {
  const errors = []
  const release = latest?.release
  const refs = [
    ['release.path', release?.path],
    ['release.manifest', release?.manifest],
    ['release.loader', release?.loader],
    ['release.distZip', release?.distZip],
  ]

  for (const [label, value] of refs) {
    if (!isRelativeContractPath(value)) {
      errors.push(`${label} must be a non-empty relative path`)
    }
  }

  const zipSha = String(release?.distZipSha256 || '').trim()
  if (!/^[a-f0-9]{64}$/i.test(zipSha)) {
    errors.push('release.distZipSha256 must be a 64-character hex digest')
  }

  if (errors.length > 0) {
    throw new Error(`latest.json contract invalid:\n- ${errors.join('\n- ')}`)
  }

  return latest
}

export function validateManifestContract(manifest) {
  const errors = []
  const files = Array.isArray(manifest?.files) ? manifest.files : []
  const fileMap = new Map()

  for (const file of files) {
    const rel = normalizeRelPath(file?.path)
    if (!isRelativeContractPath(rel)) {
      errors.push(`files[].path must be relative: ${String(file?.path || '')}`)
      continue
    }

    if (!Number.isFinite(file?.size) || file.size < 0) {
      errors.push(`files[].size must be a non-negative number for ${rel}`)
    }
    if (!/^[a-f0-9]{64}$/i.test(String(file?.sha256 || ''))) {
      errors.push(`files[].sha256 must be a 64-character hex digest for ${rel}`)
    }
    if (!String(file?.integrity || '').startsWith('sha256-')) {
      errors.push(`files[].integrity must be sha256-based for ${rel}`)
    }

    fileMap.set(rel, file)
  }

  const entryAssets = [
    ...(Array.isArray(manifest?.entry?.js) ? manifest.entry.js : []),
    ...(Array.isArray(manifest?.entry?.css) ? manifest.entry.css : []),
  ].map(normalizeRelPath)

  for (const rel of entryAssets) {
    if (!fileMap.has(rel)) {
      errors.push(`entry asset missing file record: ${rel}`)
    }
  }

  if (errors.length > 0) {
    throw new Error(`manifest.json contract invalid:\n- ${errors.join('\n- ')}`)
  }

  return manifest
}

export function parseHtmlEntries(html) {
  const js = []
  const css = []

  const scriptRe = /<script[^>]*type="module"[^>]*src="([^"]+)"[^>]*><\/script>/g
  const cssRe = /<link[^>]*rel="stylesheet"[^>]*href="([^"]+)"[^>]*>/g

  for (const match of html.matchAll(scriptRe)) {
    if (match[1]) js.push(match[1])
  }
  for (const match of html.matchAll(cssRe)) {
    if (match[1]) css.push(match[1])
  }

  const clean = (value) => normalizeRelPath(String(value || '').trim().replace(/^\//, ''))
  return {
    js: js.map(clean).filter(Boolean),
    css: css.map(clean).filter(Boolean),
  }
}

export async function tryParseViteManifestEntries(releaseDir) {
  const manifestPath = path.join(releaseDir, '.vite', 'manifest.json')
  let raw = ''
  try {
    raw = await fs.readFile(manifestPath, 'utf8')
  } catch {
    return null
  }

  let manifest
  try {
    manifest = JSON.parse(raw)
  } catch {
    return null
  }
  if (!manifest || typeof manifest !== 'object') return null

  const records = Object.values(manifest)
  const entry =
    manifest['index.html'] ||
    records.find((record) => record && typeof record === 'object' && record.isEntry === true)

  if (!entry || typeof entry !== 'object') return null

  const js = entry.file ? [String(entry.file)] : []
  const css = Array.isArray(entry.css) ? entry.css.map(String) : []

  return {
    js: js.map(normalizeRelPath).filter(Boolean),
    css: css.map(normalizeRelPath).filter(Boolean),
  }
}

export async function resolveEntryAssets(releaseDir) {
  const fromVite = await tryParseViteManifestEntries(releaseDir)
  if (fromVite) return fromVite

  const indexHtml = await fs.readFile(path.join(releaseDir, 'index.html'), 'utf8')
  return parseHtmlEntries(indexHtml)
}

export function buildCspMeta({ scriptSha256B64 }) {
  const scriptHash = `sha256-${scriptSha256B64}`
  return [
    "default-src 'self'",
    `script-src 'self' '${scriptHash}'`,
    "style-src 'self' 'unsafe-inline'",
    "font-src 'self' data:",
    "img-src 'self' data:",
    "connect-src 'self'",
  ].join('; ')
}

export function buildPortableHtml({ baseHtml, cssText, jsText }) {
  let html = baseHtml
    .replace(/<link[^>]*href="\.\/fonts\.css"[^>]*>\s*/g, '')
    .replace(/<script[^>]*type="module"[^>]*src="[^"]+"[^>]*><\/script>\s*/g, '')
    .replace(/<link[^>]*rel="stylesheet"[^>]*href="[^"]+"[^>]*>\s*/g, '')

  html = html.replace('</head>', `  <style>\n${cssText}\n  </style>\n</head>`)
  html = html.replace('</body>', `  <script type="module">\n${jsText}\n  </script>\n</body>`)

  const csp = buildCspMeta({ scriptSha256B64: sha256Base64(Buffer.from(jsText, 'utf8')) })
  if (/<meta\s+http-equiv="Content-Security-Policy"/i.test(html)) {
    html = html.replace(
      /<meta\s+http-equiv="Content-Security-Policy"[^>]*content="[^"]*"[^>]*>/i,
      `<meta http-equiv="Content-Security-Policy" content="${csp}">`,
    )
  } else {
    html = html.replace('<head>', `<head>\n    <meta http-equiv="Content-Security-Policy" content="${csp}">`)
  }

  return html
}

export function deriveGhPagesLatestUrl(repoFullName) {
  const value = String(repoFullName || '').trim()
  const parts = value.split('/')
  if (parts.length !== 2) return ''
  const [ownerRaw, repoRaw] = parts
  const owner = String(ownerRaw || '').trim()
  const repo = String(repoRaw || '').trim()
  if (!owner || !repo) return ''

  const ownerLower = owner.toLowerCase()
  const repoLower = repo.toLowerCase()
  if (repoLower === `${ownerLower}.github.io`) {
    return `https://${owner}.github.io/latest.json`
  }
  return `https://${owner}.github.io/${repo}/latest.json`
}

export function tryDeriveRepoFromGitRemote() {
  try {
    const origin = runCapture('git config --get remote.origin.url')
    if (!origin) return ''

    const https = origin.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/i)
    if (https) return `${https[1]}/${https[2]}`

    const ssh = origin.match(/^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?$/i)
    if (ssh) return `${ssh[1]}/${ssh[2]}`
  } catch {}

  return ''
}

export function deriveRepoFullName(env = process.env) {
  return String(env.GITHUB_REPOSITORY || '').trim() || tryDeriveRepoFromGitRemote()
}

export function deriveDefaultLatestCandidates({ env = process.env, repoFullName = deriveRepoFullName(env) } = {}) {
  const explicit = String(env.DEFAULT_LATEST_URL || '').trim()
  if (explicit) return [explicit]
  if (!repoFullName) return []

  const ghPages = deriveGhPagesLatestUrl(repoFullName)
  const jsDelivr = `https://cdn.jsdelivr.net/gh/${repoFullName}@gh-pages/latest.json`

  return [ghPages, jsDelivr].filter(Boolean)
}

export function loaderNormalizePinnedVersion(ver) {
  const raw = String(ver || '').trim()
  if (!raw) return ''
  const value = raw.startsWith('v') ? raw.slice(1) : raw
  if (!/^[0-9A-Za-z][0-9A-Za-z._-]{0,63}$/.test(value)) return ''
  return value
}

export function loaderResolvePinnedVersion({ search = '', storedValue = '', configPinnedVersion = '' } = {}) {
  const qs = new URLSearchParams(search)
  return (
    loaderNormalizePinnedVersion(qs.get('ver') || qs.get('version') || qs.get('tag') || '') ||
    loaderNormalizePinnedVersion(storedValue) ||
    loaderNormalizePinnedVersion(configPinnedVersion)
  )
}

export function loaderDedupeStrings(list) {
  const out = []
  const seen = new Set()
  for (const value of list) {
    const item = String(value || '').trim()
    if (!item || seen.has(item)) continue
    seen.add(item)
    out.push(item)
  }
  return out
}

export function loaderPickCandidates({
  search = '',
  inputValue = '',
  savedValue = '',
  configLatestUrl = '',
  configCandidates = [],
  defaultCandidates = [],
} = {}) {
  const qs = new URLSearchParams(search)
  const fromQuery = qs.get('latest') || qs.get('manifest') || ''
  const defaults = ['./latest.json']

  return loaderDedupeStrings([
    fromQuery,
    inputValue,
    savedValue,
    configLatestUrl,
    ...(Array.isArray(configCandidates) ? configCandidates : []),
    ...(Array.isArray(defaultCandidates) ? defaultCandidates : []),
    ...defaults,
  ])
}

export async function loaderResolveManifest({ latestUrlOrManifestUrl, pinnedVersion = '', locationHref, fetchJson }) {
  const url = new URL(latestUrlOrManifestUrl, locationHref)

  if (pinnedVersion) {
    if (url.pathname.toLowerCase().endsWith('manifest.json')) {
      const manifest = await fetchJson(url.toString())
      return { manifest, manifestUrl: url.toString() }
    }

    const manifestUrl = new URL(`releases/${pinnedVersion}/manifest.json`, url).toString()
    const manifest = await fetchJson(manifestUrl)
    return { manifest, manifestUrl }
  }

  const data = await fetchJson(url.toString())
  if (data && data.files && data.entry) {
    return { manifest: data, manifestUrl: url.toString() }
  }

  const releasePath = loaderNormalizeAssetPath(String(data?.release?.path || ''))
  const manifestRel = loaderNormalizeAssetPath(String(data?.release?.manifest || 'manifest.json'))
  const base = releasePath
    ? new URL(releasePath.replace(/\/+$/, '') + '/', url).toString()
    : url.toString().replace(/[^/]*$/, '')
  const manifestUrl = new URL(manifestRel, base).toString()
  const manifest = await fetchJson(manifestUrl)
  return { manifest, manifestUrl }
}

export function loaderNormalizeAssetPath(value) {
  let normalized = String(value || '').trim()
  while (normalized.startsWith('/')) normalized = normalized.slice(1)
  if (normalized.startsWith('./')) normalized = normalized.slice(2)
  return normalized
}

export function loaderFileMap(manifest) {
  const map = new Map()
  for (const file of manifest?.files || []) {
    if (file?.path) map.set(String(file.path), file)
  }
  return map
}

export function loaderLoadAssets({ document, manifestUrl, manifest }) {
  const base = manifestUrl.replace(/[^/]*$/, '')
  const entry = manifest?.entry || {}
  const jsList = Array.isArray(entry.js) ? entry.js : (entry.js ? [entry.js] : [])
  const cssList = Array.isArray(entry.css) ? entry.css : (entry.css ? [entry.css] : [])
  const files = loaderFileMap(manifest)

  for (const href0 of cssList) {
    const rel = loaderNormalizeAssetPath(href0)
    const href = new URL(rel, base).toString()
    const link = document.createElement('link')
    link.rel = 'stylesheet'
    link.href = href
    const meta = files.get(rel)
    if (meta?.integrity) {
      link.integrity = String(meta.integrity)
      link.crossOrigin = 'anonymous'
    }
    document.head.appendChild(link)
  }

  for (const src0 of jsList) {
    const rel = loaderNormalizeAssetPath(src0)
    const src = new URL(rel, base).toString()
    const script = document.createElement('script')
    script.type = 'module'
    script.src = src
    const meta = files.get(rel)
    if (meta?.integrity) {
      script.integrity = String(meta.integrity)
      script.crossOrigin = 'anonymous'
    }
    document.head.appendChild(script)
  }
}

export function buildLoaderScript({ defaultCandidates = deriveDefaultLatestCandidates() } = {}) {
  return `
      const STORAGE_KEY = 'torrent-webui:latest-url'
      const PIN_KEY = 'torrent-webui:pinned-version'
      const CACHE_KEY = 'torrent-webui:cached-manifest'
      const RELOAD_ONCE_KEY = 'torrent-webui:reload-once'
      const CONFIG_URL = './config.json'
      const DEFAULT_CANDIDATES = ${JSON.stringify(defaultCandidates)}

      const loaderNormalizePinnedVersion = ${loaderNormalizePinnedVersion.toString()}
      const loaderResolvePinnedVersion = ${loaderResolvePinnedVersion.toString()}
      const loaderDedupeStrings = ${loaderDedupeStrings.toString()}
      const loaderPickCandidates = ${loaderPickCandidates.toString()}
      const loaderResolveManifest = ${loaderResolveManifest.toString()}
      const loaderNormalizeAssetPath = ${loaderNormalizeAssetPath.toString()}
      const loaderFileMap = ${loaderFileMap.toString()}
      const loaderLoadAssets = ${loaderLoadAssets.toString()}

      const els = {
        input: document.getElementById('manifestUrl'),
        save: document.getElementById('saveBtn'),
        load: document.getElementById('loadBtn'),
        pin: document.getElementById('pinVersion'),
        pinBtn: document.getElementById('pinBtn'),
        unpinBtn: document.getElementById('unpinBtn'),
        status: document.getElementById('status'),
        error: document.getElementById('error'),
      }

      function setStatus(text) {
        els.status.textContent = '状态：' + text
      }

      function setError(err) {
        if (!err) {
          els.error.style.display = 'none'
          els.error.textContent = ''
          return
        }
        els.error.style.display = 'block'
        els.error.textContent = String(err)
      }

      async function fetchJson(url, timeoutMs = 3500) {
        const controller = new AbortController()
        const t = setTimeout(() => controller.abort(), timeoutMs)
        try {
          const res = await fetch(url, { cache: 'no-store', signal: controller.signal })
          if (!res.ok) throw new Error('HTTP ' + res.status + ' ' + res.statusText)
          return await res.json()
        } finally {
          clearTimeout(t)
        }
      }

      async function tryLoadConfig() {
        const u = new URL(CONFIG_URL, location.href)
        try {
          const data = await fetchJson(u.toString(), 300)
          if (!data || typeof data !== 'object') return null
          return data
        } catch {
          return null
        }
      }

      function readCachedManifest() {
        try {
          const raw = localStorage.getItem(CACHE_KEY)
          if (!raw) return null
          const data = JSON.parse(raw)
          if (!data || typeof data !== 'object') return null
          if (!data.manifestUrl || !data.manifest) return null
          return data
        } catch {
          return null
        }
      }

      function writeCachedManifest(manifestUrl, manifest) {
        try {
          const payload = {
            version: String(manifest?.version || ''),
            manifestUrl: String(manifestUrl || ''),
            manifest,
            savedAt: new Date().toISOString(),
          }
          localStorage.setItem(CACHE_KEY, JSON.stringify(payload))
        } catch {}
      }

      function pickCandidates(config) {
        return loaderPickCandidates({
          search: location.search,
          inputValue: String(els.input?.value || ''),
          savedValue: String(localStorage.getItem(STORAGE_KEY) || ''),
          configLatestUrl: String(config?.latestUrl || ''),
          configCandidates: Array.isArray(config?.candidates) ? config.candidates : [],
          defaultCandidates: DEFAULT_CANDIDATES,
        })
      }

      function resolveManifest(latestUrlOrManifestUrl, pinnedVersion) {
        return loaderResolveManifest({
          latestUrlOrManifestUrl,
          pinnedVersion,
          locationHref: location.href,
          fetchJson,
        })
      }

      function loadAssets(manifestUrl, manifest) {
        return loaderLoadAssets({ document, manifestUrl, manifest })
      }

      async function tryBoot() {
        setError('')

        const qs = new URLSearchParams(location.search)
        const config = await tryLoadConfig()
        if (config?.latestUrl && !localStorage.getItem(STORAGE_KEY) && !(qs.get('latest') || qs.get('manifest'))) {
          els.input.value = String(config.latestUrl || '').trim()
        }
        if (config?.pinnedVersion && !localStorage.getItem(PIN_KEY)) {
          els.pin.value = loaderNormalizePinnedVersion(config.pinnedVersion)
        }

        const pinnedVersion = loaderResolvePinnedVersion({
          search: location.search,
          storedValue: localStorage.getItem(PIN_KEY) || '',
          configPinnedVersion: config?.pinnedVersion || '',
        })

        const candidates = pickCandidates(config)
        if (candidates.length === 0) {
          setStatus('未配置 latest.json；请手动填写并保存')
          return
        }

        if (pinnedVersion) {
          setStatus('固定版本：' + pinnedVersion + '（探测 CDN）…')
        }

        if (!pinnedVersion) {
          const cached = readCachedManifest()
          if (cached?.manifestUrl && cached?.manifest) {
            const cachedVersion = String(cached.version || cached.manifest?.version || 'unknown')
            setStatus('离线缓存启动：' + cachedVersion)
            loadAssets(String(cached.manifestUrl), cached.manifest)

            void (async () => {
              if (sessionStorage.getItem(RELOAD_ONCE_KEY)) return
              try {
                for (const url of candidates) {
                  try {
                    const { manifest, manifestUrl } = await resolveManifest(url, '')
                    const nextVersion = String(manifest?.version || 'unknown')
                    writeCachedManifest(manifestUrl, manifest)
                    if (nextVersion && cachedVersion && nextVersion !== cachedVersion) {
                      sessionStorage.setItem(RELOAD_ONCE_KEY, '1')
                      location.reload()
                    }
                    return
                  } catch {}
                }
              } catch {}
            })()

            return
          }

          setStatus('探测更新源…')
        }

        let lastErr = null
        for (const url of candidates) {
          try {
            setStatus('读取：' + url)
            const { manifest, manifestUrl } = await resolveManifest(url, pinnedVersion)
            writeCachedManifest(manifestUrl, manifest)
            setStatus('加载资源：' + (manifest?.version || pinnedVersion || 'unknown'))
            loadAssets(manifestUrl, manifest)
            return
          } catch (error) {
            lastErr = error
          }
        }

        setStatus('启动失败')
        setError(lastErr ? (lastErr?.stack || lastErr?.message || String(lastErr)) : 'unknown error')
      }

      function saveUrl() {
        const v = String(els.input.value || '').trim()
        if (!v) return
        localStorage.setItem(STORAGE_KEY, v)
        setStatus('已保存，点击“加载”尝试启动')
      }

      function pinVersion() {
        const v = loaderNormalizePinnedVersion(els.pin.value || '')
        if (!v) return
        localStorage.setItem(PIN_KEY, v)
        location.reload()
      }

      function unpinVersion() {
        localStorage.removeItem(PIN_KEY)
        els.pin.value = ''
        location.reload()
      }

      els.input.value = String(localStorage.getItem(STORAGE_KEY) || DEFAULT_CANDIDATES[0] || '').trim()
      els.pin.value = String(localStorage.getItem(PIN_KEY) || '').trim()
      els.save.addEventListener('click', saveUrl)
      els.load.addEventListener('click', tryBoot)
      els.pinBtn.addEventListener('click', pinVersion)
      els.unpinBtn.addEventListener('click', unpinVersion)

      void tryBoot()
  `.trim()
}

export function buildLoaderHtml({ defaultCandidates = deriveDefaultLatestCandidates() } = {}) {
  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta http-equiv="Content-Security-Policy"
      content="default-src 'self';
               script-src 'self' 'unsafe-inline' https:;
               style-src 'self' 'unsafe-inline' https:;
               img-src 'self' data:;
               connect-src 'self' https:;
               font-src 'self' data:;">
    <title>Torrent WebUI Loader</title>
    <style>
      :root { color-scheme: light; }
      body { margin: 0; font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif; background: #fafafa; color: #111827; }
      .wrap { min-height: 100vh; display: grid; place-items: center; padding: 24px; }
      .card { width: min(720px, 100%); background: #fff; border: 1px solid #e5e7eb; border-radius: 16px; box-shadow: 0 1px 2px rgba(0,0,0,.04); padding: 18px; }
      h1 { font-size: 18px; margin: 0 0 8px; }
      p { margin: 8px 0; color: #4b5563; font-size: 14px; line-height: 1.5; }
      code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px; background: #f3f4f6; padding: 2px 6px; border-radius: 6px; }
      .row { display: flex; gap: 8px; align-items: center; margin-top: 12px; flex-wrap: wrap; }
      input { flex: 1 1 360px; min-width: 240px; padding: 10px 12px; border: 1px solid #d1d5db; border-radius: 10px; font-size: 14px; }
      button { padding: 10px 12px; border-radius: 10px; border: 1px solid #111827; background: #111827; color: #fff; font-weight: 600; cursor: pointer; }
      button.secondary { background: #fff; color: #111827; }
      .status { margin-top: 10px; font-size: 13px; color: #374151; }
      .warn { margin-top: 10px; padding: 10px 12px; background: #fffbeb; border: 1px solid #f59e0b33; border-radius: 12px; color: #92400e; font-size: 13px; }
      .err { margin-top: 10px; padding: 10px 12px; background: #fef2f2; border: 1px solid #ef444433; border-radius: 12px; color: #991b1b; font-size: 13px; white-space: pre-wrap; }
      a { color: #111827; }
    </style>
  </head>
  <body>
    <div id="app">
      <div class="wrap">
        <div class="card">
          <h1>WebUI Loader</h1>
          <p>用途：把这一页当作 <code>index.html</code> 放到 qBittorrent/Transmission 的 WebUI 目录里；它会从远端 <code>latest.json</code> 读取版本，再按 <code>manifest.json</code> 从 CDN 加载 JS/CSS（页面保持同源，后端 API 仍访问当前域名）。</p>
          <div class="warn">
            安全提示：启用“远端更新”本质是在信任远端脚本。建议使用自建域名/私有源，并配合完整 HTTPS、严格 CSP、以及可审计的发布流程。
          </div>

          <div class="row">
            <input id="manifestUrl" placeholder="latest.json URL（例如 https://YOUR.DOMAIN/latest.json）" />
            <button id="saveBtn" class="secondary" type="button">保存</button>
            <button id="loadBtn" type="button">加载</button>
          </div>

          <div class="row">
            <input id="pinVersion" placeholder="固定版本（例如 0.1.0，可留空）" />
            <button id="pinBtn" class="secondary" type="button">固定</button>
            <button id="unpinBtn" class="secondary" type="button">解除</button>
          </div>

          <div class="status" id="status">状态：等待配置</div>
          <div class="err" id="error" style="display:none"></div>
        </div>
      </div>
    </div>

    <script type="module">
      ${buildLoaderScript({ defaultCandidates })}
    </script>
  </body>
</html>`
}

export async function buildManifest({ releaseDir, version, name, commit, builtAtIso, channel = CHANNEL }) {
  const entry = await resolveEntryAssets(releaseDir)
  const allFiles = await listFilesRecursive(releaseDir)
  const files = []

  for (const absPath of allFiles) {
    const rel = normalizeRelPath(path.relative(releaseDir, absPath))
    if (!rel || rel === 'manifest.json' || rel === 'dist.zip') continue

    const buf = await fs.readFile(absPath)
    const sha256b64 = sha256Base64(buf)
    files.push({
      path: rel,
      size: buf.byteLength,
      sha256: sha256Hex(buf),
      integrity: toIntegrity(sha256b64),
    })
  }

  files.sort((a, b) => a.path.localeCompare(b.path))

  const manifest = validateManifestContract({
    schema: 1,
    name,
    channel,
    version,
    commit,
    builtAt: builtAtIso,
    entry: {
      html: 'index.html',
      js: entry.js,
      css: entry.css,
    },
    files,
  })

  await fs.writeFile(path.join(releaseDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8')
  return manifest
}

export async function zipRelease({ releaseDir, outZipPath }) {
  await fs.rm(outZipPath, { force: true })

  if (process.platform === 'win32') {
    const ps = [
      'powershell',
      '-NoProfile',
      '-Command',
      `Compress-Archive -Path "${releaseDir}\\*" -DestinationPath "${outZipPath}" -Force`,
    ]
    const res = spawnSync(ps[0], ps.slice(1), { stdio: 'inherit' })
    if (res.status !== 0) throw new Error('Compress-Archive failed')
    return
  }

  const res = spawnSync('zip', ['-r', '-q', outZipPath, '.'], { cwd: releaseDir, stdio: 'inherit' })
  if (res.status !== 0) throw new Error('zip failed (missing zip?)')
}

export function buildLatestMetadata({ name, version, commit, builtAtIso, zipSha256, channel = CHANNEL }) {
  return validateLatestReleaseContract({
    schema: 2,
    name,
    channel,
    version,
    commit,
    builtAt: builtAtIso,
    release: {
      path: `releases/${version}/`,
      manifest: 'manifest.json',
      loader: 'loader.html',
      distZip: `releases/${version}/dist.zip`,
      distZipSha256: zipSha256,
    },
  })
}

async function loadPackageMeta(root) {
  const pkgRaw = await fs.readFile(path.join(root, 'package.json'), 'utf8')
  const pkg = JSON.parse(pkgRaw)
  return {
    name: String(pkg.name || 'torrent-webui'),
    version: String(pkg.version || '0.0.0'),
  }
}

export async function buildPublishArtifacts({
  root = ROOT,
  distDir = DIST_DIR,
  outDir = OUT_DIR,
  channel = CHANNEL,
  shouldRunBuild = true,
  buildCommand = 'pnpm run build',
  name,
  version,
  commit,
  builtAtIso,
} = {}) {
  const pkg = await loadPackageMeta(root)
  const resolvedName = name || pkg.name
  const resolvedVersion = version || pkg.version
  let resolvedCommit = commit || 'unknown'

  if (!commit) {
    try {
      resolvedCommit = runCapture('git rev-parse --short HEAD')
    } catch {}
  }

  const resolvedBuiltAt = builtAtIso || new Date().toISOString()
  const releaseDir = path.join(outDir, 'releases', resolvedVersion)

  await ensureEmptyDir(outDir)
  await fs.mkdir(path.dirname(releaseDir), { recursive: true })

  if (shouldRunBuild) {
    console.log(`[publish] build core dist… (${resolvedName}@${resolvedVersion} ${resolvedCommit})`)
    run(buildCommand, { cwd: root })
  }

  console.log('[publish] stage release dir…')
  await ensureEmptyDir(releaseDir)
  await copyDir(distDir, releaseDir)

  console.log('[publish] generate loader.html…')
  const loader = buildLoaderHtml()
  await fs.writeFile(path.join(releaseDir, 'loader.html'), loader, 'utf8')
  await fs.writeFile(path.join(outDir, 'loader.html'), loader, 'utf8')

  console.log('[publish] generate manifest.json…')
  const manifest = await buildManifest({
    releaseDir,
    version: resolvedVersion,
    name: resolvedName,
    commit: resolvedCommit,
    builtAtIso: resolvedBuiltAt,
    channel,
  })

  console.log('[publish] zip dist.zip…')
  const tmpZip = path.join(outDir, 'dist.zip')
  await zipRelease({ releaseDir, outZipPath: tmpZip })
  const zipBuf = await fs.readFile(tmpZip)
  const zipSha256 = sha256Hex(zipBuf)
  await fs.rename(tmpZip, path.join(releaseDir, 'dist.zip'))

  console.log('[publish] write latest.json…')
  const latest = buildLatestMetadata({
    name: resolvedName,
    version: resolvedVersion,
    commit: resolvedCommit,
    builtAtIso: resolvedBuiltAt,
    zipSha256,
    channel,
  })
  await fs.writeFile(path.join(outDir, 'latest.json'), JSON.stringify(latest, null, 2) + '\n', 'utf8')
  await fs.writeFile(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8')

  return {
    outDir,
    releaseDir,
    manifest,
    latest,
    zipSha256,
    name: resolvedName,
    version: resolvedVersion,
    commit: resolvedCommit,
    builtAtIso: resolvedBuiltAt,
  }
}

export async function main(options = {}) {
  const result = await buildPublishArtifacts(options)
  console.log('[publish] done')
  console.log(`- ${path.relative(result.outDir.startsWith(ROOT) ? ROOT : process.cwd(), result.outDir)}`)
  console.log(`- releases/${result.version}/dist.zip sha256=${result.zipSha256}`)
  return result
}

function isDirectExecution(metaUrl) {
  if (!process.argv[1]) return false
  return metaUrl === pathToFileURL(path.resolve(process.argv[1])).href
}

if (isDirectExecution(import.meta.url)) {
  await main()
}
