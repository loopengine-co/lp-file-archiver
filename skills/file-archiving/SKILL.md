---
name: file-archiving
description: When to bundle a batch of files into one zip with create_zip_archive, what it does and doesn't accept as a source, and how to handle files that fail to include.
---

# File archiving

`create_zip_archive` bundles a list of files — each an http(s) URL, a
local filesystem path, or another ability's own `/gcs-redirect` URL —
into one zip. It's built to compose with whatever already produced
those files, not just one specific ability: the common case is a batch
tool that just finished (e.g. an image-generation job) handing over its
own output paths/URLs so the operator gets one downloadable artifact
instead of picking through dozens of separate files or links.

## When to use it

Only when the operator actually wants one combined artifact — most
requests are fine with the individual paths/URLs a batch tool already
returned, and archiving adds a step (and, for GCS storage, another
upload) that isn't free. Reach for it when the request says something
like "zip these up," "give me one file I can download," or "package the
results" — not automatically after every batch just because it's
available.

## What counts as a valid source

`http://`/`https://` URLs, local filesystem paths, and another
loopengine ability's own `/gcs-redirect` URL (e.g.
lp-product-ad-images' own `path`/`download_path`) — looped back through
this same server rather than fetched externally, so it works
regardless of what's actually in front of this deployment. A bare
`gs://bucket/object` URI is **not** supported and will fail for that
one entry. Don't pass in URLs a source didn't actually give you — this
fetches whatever string you provide, so cite real output paths/URLs,
not guesses.

## Partial results are normal, not a failure

One dead URL or missing file doesn't fail the whole archive — that
entry is skipped and reported in the response's `results` array
(`{ source, status: "failed", error }`), while everything else still
gets bundled. Only every source failing is a hard error (nothing to
archive). After calling it, report both what got archived (`file_count`,
`archive_path`) and any entries that failed, rather than silently
dropping the failures from what you tell the operator.

## No job, no polling

Unlike a slow generation job, this runs synchronously and returns once
the archive is written — bundling files is fast compared to whatever
produced them, so there's no `job_id` to poll here. Very large batches
(dozens of large files) still take some real time to fetch and compress,
but not the multi-minute scale a generation job can take.

## Where the archive ends up

`archive_path` in the response is where it actually landed — a local
filesystem path by default, or (when the deployment has
`ARCHIVE_STORAGE=gcs` set) a short `/gcs-redirect` URL, relative to
this same loopengine server, that resolves to the actual zip when
opened from a browser already logged into it. Report it as-is — don't
retype or reformat any part of it.

That relative `/gcs-redirect?bucket=...` value is the whole, complete,
correct URL — no `https://` scheme or host — not a shorthand or
placeholder standing in for a "real" one. Don't "complete" it into
`https://<bucket>.storage.googleapis.com/<object>` or
`https://storage.googleapis.com/<bucket>/<object>` just because that
shape looks more familiar or finished than a bare relative path.
Confirmed live: doing that produces a URL that was never signed at
all, and `AccessDenied`s — a silent failure the reply itself gives no
hint of, since the text looks like a normal, working link either way.
