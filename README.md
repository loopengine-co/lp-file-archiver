# lp-file-archiver

A [loopengine](https://github.com/loopengine-co/loopengine) ability: a
`create_zip_archive` tool that bundles a set of files into one zip
archive, plus a skill on when it's actually worth doing that. Built to
compose with any batch tool's output — not tied to any one ability —
so an operator can get one downloadable artifact instead of picking
through many separate files or links.

## What's in it

- **Tool** — `create_zip_archive(files, archive_name?)`. `files` is an
  array where each entry is either an `http(s)` URL (fetched), a local
  filesystem path (read directly), or another loopengine ability's own
  `/storage-redirect` URL (looped back through this same server, with the
  same `LOOPENGINE_ADMIN_AUTH` credentials a browser session would
  already have cached — see
  [lp-product-ad-images](https://github.com/loopengine-co/lp-product-ad-images)'s
  own `path`/`download_path` for an example of a tool that returns one)
  — not `gs://` or any other scheme. Runs synchronously and returns
  once the archive is written:
  ```json
  {
    "archive_path": "...",
    "file_count": 24,
    "total_bytes": 18234112,
    "results": [
      { "source": "https://.../a.png", "status": "included", "entry_name": "a.png", "bytes": 512340 },
      { "source": "https://.../b.png", "status": "failed", "error": "HTTP 404" }
    ]
  }
  ```
  A source that fails to fetch/read is skipped and reported in
  `results`, not treated as fatal for the whole archive — only every
  source failing is an error, since then there'd be nothing to zip.
  Duplicate basenames across sources are automatically disambiguated
  (`image.png`, `image-2.png`, ...) rather than one silently overwriting
  another inside the archive.

  Fetching URLs uses the same hostname-blocking SSRF guard
  [lp-web-search](https://github.com/loopengine-co/lp-web-search)'s own
  `web_fetch` tool does (localhost, private network ranges, link-local/
  cloud-metadata addresses) — this tool fetches whatever URL a model
  hands it, and a model's choice of URL can be influenced by content it
  already read elsewhere, not just the operator.

  **Storage**, chosen once via `ARCHIVE_STORAGE` (default `local`):
  - `local` — writes the zip under `ARCHIVE_OUTPUT_DIR`; `archive_path`
    is a real filesystem path.
  - `gcs` — uploads it to `ARCHIVE_GCS_BUCKET` (optionally under
    `ARCHIVE_GCS_PREFIX`); `archive_path` is a short
    `/storage-redirect?...` URL — loopengine core's own generic route
    (requires loopengine >= 0.1.55), which signs a fresh, short-lived V4
    URL and redirects on every click, rather than this tool signing one
    long-lived URL itself at generation time. Only openable from a
    browser already authenticated to this same loopengine server (the
    same Basic Auth every other route there needs) — not a standalone
    link you can share outside it. If Application Default Credentials
    alone can't sign (plain `gcloud auth application-default login`
    can't; a service account key or IAM `signBlob` via impersonation
    can), set `GOOGLE_APPLICATION_CREDENTIALS_JSON` to the entire
    contents of a downloaded service-account key file — the one setup
    path that needs nothing but the GCP Console and the Admin UI's
    Environment tab, no shell/SSH access to wherever this is running
    required; a click just 502s otherwise, since `/storage-redirect` has no
    fallback for that the way this tool's own upload step does. Requires
    `npm install @google-cloud/storage` in your own project (lazily
    imported by both this tool's own upload step and loopengine core's
    redirect route, so `local` users never need it).
- **Skill** — `file-archiving`: when bundling into a zip is actually
  worth it versus leaving individual files/URLs as-is, what counts as a
  valid source, and how to report partial failures rather than treating
  one bad entry as a reason to fail the whole archive.
- **actauth rule** — `create-zip-archive-allowed`, `decision: allow`.
  No metered cost and no destructive side effect to gate — see the rule
  file's own comment for why, and for how the real risk (fetching an
  arbitrary URL) is bounded instead.

## Install

```
npx loopengine add-ability lp-file-archiver --agent <your-agent>
```

Then:

1. Optionally set `ARCHIVE_OUTPUT_DIR` if you don't want zips landing
   under `./generated/archives`.
2. Optionally set `ARCHIVE_STORAGE=gcs` plus `ARCHIVE_GCS_BUCKET` (and
   optionally `ARCHIVE_GCS_PREFIX`, `ARCHIVE_GCS_SIGNED_URL_EXPIRY`) to
   upload archives to GCS instead of writing them locally.
3. `npm install jszip` in your own project. If you set
   `ARCHIVE_STORAGE=gcs`, also `npm install @google-cloud/storage`.
   Installing an ability copies its files in, it doesn't manage your
   project's own `package.json`, so these are one-time manual steps (see
   loopengine's own `ABILITIES.md` on why abilities are copied rather
   than imported).
4. If using `local` storage, add wherever archives land
   (`ARCHIVE_OUTPUT_DIR`, default `generated/archives`) to your
   project's own `.gitignore` if you don't want to commit them.

## Upgrading

```
npx loopengine upgrade-ability lp-file-archiver --agent <your-agent>
```

See loopengine's own `ABILITIES.md` for how abilities, installs, and
upgrades work in general.
