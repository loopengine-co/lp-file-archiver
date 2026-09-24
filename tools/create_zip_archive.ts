import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import JSZip from 'jszip'
import type { ToolDefinition } from 'loopengine'

interface EntryResult {
  source: string
  status: 'included' | 'failed'
  entry_name?: string
  bytes?: number
  error?: string
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
}

// Same hostname check web_fetch.ts (lp-web-search) uses — this tool
// fetches whatever URL a model hands it, and a model's choice of URL
// can be influenced by content it already read elsewhere, not just the
// operator. Duplicated rather than imported since abilities can't share
// modules with each other (each tool file is copied standalone).
function isBlockedHost(hostname: string): boolean {
  const lower = hostname.toLowerCase()
  if (lower === 'localhost' || lower === '::1') return true
  if (/^127\./.test(lower)) return true
  if (/^10\./.test(lower)) return true
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(lower)) return true
  if (/^192\.168\./.test(lower)) return true
  if (/^169\.254\./.test(lower)) return true // link-local — includes cloud metadata endpoints
  if (/^fc[0-9a-f]{2}:/.test(lower) || /^fe80:/.test(lower)) return true
  return false
}

// A source is either an http(s) URL (fetched) or a local filesystem
// path (read directly) — deliberately not gs:// or any other scheme:
// supporting that would mean this tool also needing GCS read
// credentials/the @google-cloud/storage package just to consume another
// ability's output, when that other ability can usually just hand back
// a real https:// URL instead (e.g. lp-product-ad-images's own signed
// GCS URLs). A bare gs:// URI passed here fails clearly rather than
// silently trying and failing deep inside some other client.
async function fetchSource(source: string): Promise<Buffer> {
  let url: URL | undefined
  try {
    url = new URL(source)
  } catch {
    url = undefined
  }

  if (url) {
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new Error(`unsupported URL scheme "${url.protocol}" — only http(s) URLs and local filesystem paths are supported`)
    }
    if (isBlockedHost(url.hostname)) {
      throw new Error('refusing to fetch a local/private-network address')
    }
    const res = await fetch(url)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return Buffer.from(await res.arrayBuffer())
  }

  return readFile(source)
}

function sourceBasename(source: string): string {
  try {
    const url = new URL(source)
    return basename(url.pathname) || 'file'
  } catch {
    return basename(source) || 'file'
  }
}

// Two sources can share a basename (two different URLs both ending in
// "image.png") — rather than silently letting the second overwrite the
// first inside the zip, suffix it before the extension.
function uniqueEntryName(name: string, used: Set<string>): string {
  if (!used.has(name)) {
    used.add(name)
    return name
  }
  const dot = name.lastIndexOf('.')
  const stem = dot > 0 ? name.slice(0, dot) : name
  const ext = dot > 0 ? name.slice(dot) : ''
  let i = 2
  let candidate = `${stem}-${i}${ext}`
  while (used.has(candidate)) {
    i++
    candidate = `${stem}-${i}${ext}`
  }
  used.add(candidate)
  return candidate
}

// Same disambiguation as uniqueEntryName above, one level up — the
// archive's own output filename, not an entry inside it. Only matters
// when archive_name was given explicitly: the omitted-name default
// already bakes in Date.now() and can't collide with a prior call.  A
// model-chosen name can be generic enough to repeat across genuinely
// different batches (e.g. "google-ads-landscape-images" for any
// landscape-ratio run) — without this, a second call with the same name
// would silently overwrite the first archive, locally or in GCS alike,
// with zero warning. `exists` is async since the GCS case needs a real
// API call to check; the local case just wraps existsSync.
async function uniqueArchiveFilename(filename: string, exists: (name: string) => Promise<boolean>): Promise<string> {
  if (!(await exists(filename))) return filename
  const dot = filename.lastIndexOf('.')
  const stem = dot > 0 ? filename.slice(0, dot) : filename
  const ext = dot > 0 ? filename.slice(dot) : ''
  let i = 2
  let candidate = `${stem}-${i}${ext}`
  while (await exists(candidate)) {
    i++
    candidate = `${stem}-${i}${ext}`
  }
  return candidate
}

// Builds the Storage client — Application Default Credentials (a real
// key file via GOOGLE_APPLICATION_CREDENTIALS, gcloud user credentials,
// or the GCE/Cloud Run metadata server) by default, needing zero setup
// here. GOOGLE_APPLICATION_CREDENTIALS_JSON is the one non-ADC path this
// reads itself: the *entire contents* of a downloaded service-account
// key file, pasted directly into an env var — for an operator who can
// create a key via the GCP Console's own UI but has no way to get a
// file onto wherever this is actually running (no SSH, no shell). Same
// design as saveImage's own buildGcsStorageClient — duplicated here
// rather than shared since abilities can't import each other's code.
function buildGcsStorageClient(gcs: any): any {
  const credentialsJson = process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON
  if (!credentialsJson) return new gcs.Storage()
  let credentials: { project_id?: string }
  try {
    credentials = JSON.parse(credentialsJson)
  } catch {
    throw new Error(
      'create_zip_archive: GOOGLE_APPLICATION_CREDENTIALS_JSON is not valid JSON — paste the entire contents of the downloaded service-account key file, unedited.',
    )
  }
  return new gcs.Storage({ credentials, projectId: credentials.project_id })
}

// Archive status files (none exist for this tool — it's synchronous,
// unlike lp-product-ad-images' job-based tools) always stay local
// regardless of ARCHIVE_STORAGE; this validates the storage config the
// same way that ability does, ahead of doing any real work.
function validateStorageConfig(): void {
  const storage = process.env.ARCHIVE_STORAGE || 'local'
  if (storage !== 'local' && storage !== 'gcs') {
    throw new Error(`create_zip_archive: ARCHIVE_STORAGE must be "local" or "gcs" — got "${storage}"`)
  }
  if (storage === 'gcs' && !process.env.ARCHIVE_GCS_BUCKET) {
    throw new Error('create_zip_archive: ARCHIVE_GCS_BUCKET is not set (required when ARCHIVE_STORAGE=gcs)')
  }
}

// Saves the finished zip and returns where it landed — a local
// filesystem path by default, or (ARCHIVE_STORAGE=gcs) a signed HTTPS
// URL, falling back to a bare gs://bucket/object URI if the configured
// credentials can't sign one. Same design as lp-product-ad-images'
// saveImage — see that function's own doc comment for the full
// reasoning (lazy import, signing fallback); duplicated here rather
// than shared since abilities can't import each other's code.
async function saveArchive(args: { buffer: Buffer; filename: string; outputDir: string }): Promise<string> {
  const storage = process.env.ARCHIVE_STORAGE || 'local'
  if (storage === 'gcs') {
    const bucketName = process.env.ARCHIVE_GCS_BUCKET as string // validateStorageConfig already required this
    const prefix = process.env.ARCHIVE_GCS_PREFIX || ''
    const gcsModuleName = '@google-cloud/storage' // see saveImage's own comment on why this is a variable, not a literal
    let gcs: any
    try {
      gcs = await import(gcsModuleName)
    } catch {
      throw new Error(
        'create_zip_archive: ARCHIVE_STORAGE=gcs requires the @google-cloud/storage package — npm install @google-cloud/storage in your own project.',
      )
    }
    const client = buildGcsStorageClient(gcs)
    const bucket = client.bucket(bucketName)
    const filename = await uniqueArchiveFilename(args.filename, async (name) => {
      const [exists] = await bucket.file(`${prefix}${name}`).exists()
      return exists
    })
    const objectName = `${prefix}${filename}`
    const file = bucket.file(objectName)
    await file.save(args.buffer, { contentType: 'application/zip' })

    try {
      const expirySecondsRaw = Number(process.env.ARCHIVE_GCS_SIGNED_URL_EXPIRY || '604800')
      const expirySeconds = Number.isFinite(expirySecondsRaw) && expirySecondsRaw > 0 ? expirySecondsRaw : 604800
      const [signedUrl] = await file.getSignedUrl({ action: 'read', expires: Date.now() + expirySeconds * 1000 })
      return signedUrl
    } catch {
      return `gs://${bucketName}/${objectName}`
    }
  }
  await mkdir(args.outputDir, { recursive: true })
  const filename = await uniqueArchiveFilename(args.filename, async (name) => existsSync(join(args.outputDir, name)))
  const outputPath = join(args.outputDir, filename)
  await writeFile(outputPath, args.buffer)
  return outputPath
}

export const createZipArchive: ToolDefinition = {
  name: 'create_zip_archive',
  description:
    'Bundle a set of files into one zip archive — typically the output paths/URLs from a prior batch tool call (e.g. a set of generated images) that the operator wants as one downloadable artifact instead of many separate ones. Each entry in files is either an http(s) URL (fetched) or a local filesystem path (read directly) — not gs:// or any other scheme; if a source is a signed GCS URL that already works fine here. A source that fails (dead URL, missing file) is skipped and reported, not treated as a fatal error for the whole archive, unless every source fails. Runs synchronously and returns once the archive is written — no job/polling involved, since bundling files is fast compared to whatever generated them.',
  input_schema: {
    type: 'object',
    properties: {
      files: {
        type: 'array',
        minItems: 1,
        items: { type: 'string' },
        description: 'The files to include, each an http(s) URL or a local filesystem path.',
      },
      archive_name: {
        type: 'string',
        description: 'Base name for the resulting archive, without the .zip extension. Defaults to a timestamp-based name if omitted.',
      },
    },
    required: ['files'],
  },
  execute: async (input) => {
    validateStorageConfig()

    const files = Array.isArray(input.files) ? input.files.map(String) : []
    if (files.length === 0) throw new Error('create_zip_archive: files must be a non-empty array')

    const zip = new JSZip()
    const usedNames = new Set<string>()
    const results: EntryResult[] = []

    for (const source of files) {
      try {
        const buffer = await fetchSource(source)
        const entryName = uniqueEntryName(sourceBasename(source), usedNames)
        zip.file(entryName, buffer)
        results.push({ source, status: 'included', entry_name: entryName, bytes: buffer.length })
      } catch (err) {
        results.push({ source, status: 'failed', error: err instanceof Error ? err.message : String(err) })
      }
    }

    const included = results.filter((r) => r.status === 'included')
    if (included.length === 0) {
      throw new Error('create_zip_archive: every file failed to include — nothing to archive. See each entry\'s own error.')
    }

    const zipBuffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })

    const outputDir = process.env.ARCHIVE_OUTPUT_DIR || './generated/archives'
    const baseName = typeof input.archive_name === 'string' && input.archive_name ? slugify(input.archive_name) : `archive-${Date.now()}`
    const archivePath = await saveArchive({ buffer: zipBuffer, filename: `${baseName || 'archive'}.zip`, outputDir })

    return JSON.stringify({ archive_path: archivePath, file_count: included.length, total_bytes: zipBuffer.length, results })
  },
  // Writes only its own uniquely-named archive file (uniqueArchiveFilename
  // disambiguates on an actual name collision, not just the omitted-name
  // default), reads nothing shared, no risk of two calls conflicting.
  safe: true,
}
