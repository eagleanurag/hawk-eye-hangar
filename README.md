# Parkjets Archive

**An independent, self-hosted preservation of the Parkjets RC parkjet & park flyer plan catalogue.**

Live site: **<https://eagleanurag.github.io/eagleeye-hangar/>**

109 aircraft · 419 photographs · 49 credited designers · fully searchable · no backend, no trackers, no Squarespace.

---

## What this is

Parkjets has published a large catalogue of free RC aircraft plans since 2016 — foam park
flyers, pusher jets, EDFs, profiles and fantasy craft — each written up by an independent
modeller with their own specifications, build notes, build threads and photographs.

That catalogue is an archive, not a shop. This project preserves it on GitHub Pages so it
keeps working independently of the original hosting, at effectively zero running cost.

* Every catalogue entry, its designer credit, its published specifications and build notes
* Every photograph, re-hosted locally at two resolutions
* A permanent link back to the original product page for every single entry
* Instant client-side search and filtering over the whole catalogue

## What this is **not**

* It is **not** the Parkjets shop, and it is not endorsed by Parkjets.
* It does **not** redistribute plan files. See [Plan files](#plan-files) below.
* It does **not** contain anything that was behind a login, a paywall or a CAPTCHA.
* It does **not** run any third-party JavaScript, analytics or advertising.

---

## Source and attribution

| | |
|---|---|
| **Original website** | <https://www.parkjets.com/> |
| **Original plan collection** | <https://www.parkjets.com/free-plans> |
| **Original owner** | Parkjets, Mesa, Arizona — `parkjets@gmail.com` |
| **Platform** | Squarespace 7.1 commerce, with MemberSpace membership gating the plan files |

### Project code vs archived content

These are licensed differently, and the difference matters.

**Project code — MIT licensed.** The website, the migration tooling, the validators, the
tests and the documentation in this repository. See [`LICENSE`](LICENSE).

**Archived third-party content — not ours to license.** The aircraft designs, plan
filenames, specifications, build notes, links and photographs preserved under
`data/aircraft.json`, `data/archive-manifest.json` and `public/media/` remain the
intellectual property of the individual designers and photographers who made them, and of
Parkjets. This project asserts no redistribution right over any of it and the MIT licence
expressly does not apply to it.

Every archived item is credited:

* the **designer** is named on the aircraft page and in `designerKey` in the dataset,
* the **original page** is linked from every record as `sourceUrl`,
* the **original filename** of the plan file is preserved in the manifest,
* photographs are credited to the contributor named in the original image description and
  to Parkjets for hosting.

If you are a designer or photographer and want something removed, contact the site owner
and it will be taken down.

### Data collection method

The catalogue was read from the public, machine-readable representation the source site
already publishes for its own product grid, cross-checked against `sitemap.xml` and against
all eight category pages. The three sources agree exactly, which is how we know nothing is
missing or duplicated. Nothing behind an account was accessed, and no access control was
circumvented.

### One policy, stated once

> The importer never invents data. A specification is recorded only when a designer
> literally wrote it. Where the source is silent, the page says so. Where the designer's
> wording is ambiguous, it is reproduced verbatim rather than reinterpreted.

---

## Plan files

Parkjets published its plan files as member-only digital goods. They were released only to
accounts signed in to the Parkjets membership, and there is no public, unauthenticated
download address for any of them. That is a deliberate commercial decision by the site
owner, and this project respects it.

So the site never shows a download button that would not work. Every aircraft page shows
one of two honest states, decided by checking what is actually stored in this repository:

| Status | What you see |
|---|---|
| `ARCHIVED` | A **Download** button serving a validated copy stored in this repo, with size, type and SHA-256. |
| `SOURCE_ONLY` | An **Open original source** button linking to the Parkjets product page, with the original filename and format shown. |

Current state: **0 archived, 109 source-only.** See
[`reports/migration-report.md`](reports/migration-report.md) for the per-aircraft detail and
the exact endpoints that were probed.

### Adding a plan file later

1. Put the file in `public/plans/<slug>/`, keeping its **original filename**.
2. Run `npm run archive:local`. This is the offline ingest: it validates and
   hashes whatever is sitting in `public/plans/`, and carries every other entry
   forward from the existing manifest so no recorded probe history is lost. It
   makes no network requests and takes about a second.
   Use plain `npm run archive` only if you specifically want to re-probe the
   public endpoints of the source site — that run is slow and needs repeating
   never for a drop-in.
3. The file is validated (ZIP central directory + per-entry CRC-32, PDF structure, DXF
   sections, SVG root), a SHA-256 is recorded, the manifest is updated, and the aircraft
   page's button switches to a real download on the next build.
4. Commit and push.

Drop as many files in as you like before running the command; a single run ingests all
of them. Only one file per aircraft directory is used — the first entry in
alphabetical order among the accepted extensions (`.zip .pdf .dxf .svg .dwg .rar .7z
.skp .blend .igs .step .stp`) — so keep one plan file per aircraft.

Nothing else needs to change. If validation fails, the aircraft is marked `MANUAL_REVIEW`
rather than being silently offered as a download.

---

## Adding a new aircraft

No code changes required. Four steps:

1. **Add metadata.** Append one object to `data/aircraft.json`. Copy the shape of an
   existing entry:

   ```jsonc
   {
     "id": "unique-stable-id",
     "slug": "my-new-parkjet",              // lowercase kebab-case, must be unique
     "name": "My New Parkjet",
     "displayName": "My New Parkjet",       // add " — Designer" if the name collides
     "category": ["Foam", "Pusher"],        // from the source taxonomy
     "designer": "A Designer",
     "designerKey": "a designer",           // lowercase key used for filtering
     "description": "…",
     "summary": "…",
     "designerNotes": "…",
     "specifications": { "wingspan": "71 cm", "length": "104 cm" },
     "specificationsExtra": [],
     "images": [ { "alt": "…", "card": "/media/aircraft/my-new-parkjet/01-400.webp",
                   "full": "/media/aircraft/my-new-parkjet/01-1200.webp",
                   "width": 1024, "height": 728, "sourceUrl": "…" } ],
     "sourceUrl": "https://www.parkjets.com/free-plans/p/…",
     "archiveStatus": "SOURCE_ONLY",
     "download": { "type": "source", "file": null, "sourceUrl": "…", "status": "…" },
     "license": { "status": "…", "notes": "…" },
     "source": { "parkjetsId": "…", "addedOn": null, "updatedOn": null },
     "review": []
   }
   ```

   Only include what you actually know. Omit a field you cannot source; the validator and
   the page design both handle absence gracefully.

2. **Add photographs.** Put them in `public/media/aircraft/<slug>/` as `01-400.webp` /
   `01-1200.webp`, `02-400.webp` / `02-1200.webp`, … and reference them in `images`.

3. **Add a plan file** if one may be redistributed — see above.

4. **Verify and push.**

   ```bash
   npm install
   npm run validate     # fails on duplicates, missing images, broken downloads
   npm test             # 29 integrity tests
   npm run build        # validate + astro build
   ```

   Then `git add`, `git commit`, `git push`. GitHub Actions rebuilds the site and the new
   aircraft appears automatically — in the catalogue, in search, in the filters, in the
   designer list and in the sitemap. No page, menu or index needs editing by hand.

---

## Project layout

```
├── data/
│   ├── aircraft.json           ← the catalogue (source of truth for the site)
│   ├── archive-manifest.json   ← per-aircraft archive audit trail
│   ├── site.json               ← site name, origin and deployment base
│   └── _raw/                   ← evidence captured during migration (git-ignored)
├── public/
│   ├── media/aircraft/<slug>/  ← archived photographs (400w + 1200w WebP)
│   ├── plans/<slug>/           ← archived plan files, when any are released
│   └── robots.txt, icons, OG image
├── src/
│   ├── pages/                  ← index, catalog, aircraft/[slug], designers, about, 404
│   ├── layouts/                ← Base (head/SEO) and Shell (header/footer)
│   ├── components/             ← AircraftCard
│   ├── lib/catalog.ts          ← data layer + every derived statistic
│   ├── scripts/                ← motion.js, catalog.js, gallery.js (dependency-free)
│   └── styles/global.css       ← design system
├── scripts/                    ← migration + validation tooling
├── tests/                      ← node --test suite
├── reports/                    ← migration report, image report, QA report
└── .github/workflows/          ← deploy-pages.yml, security.yml
```

## Commands

| Command | What it does |
|---|---|
| `npm run dev` | Local dev server with hot reload |
| `npm run build` | Validate, then build to `dist/` |
| `npm run preview` | Serve the production build |
| `npm run validate` | Data integrity gate — **must pass before deploy** |
| `npm test` | 29 unit/integrity tests |
| `npm run check-links` | Post-build audit of links, assets, alt text and ARIA wiring |
| `npm run audit` | Payload measurement + accessibility audit |
| `npm run report` | Regenerate `reports/migration-report.{json,md}` |
| `npm run qa` | Headless-browser test matrix across 8 viewports |
| `npm run qa -- --url <pages url>` | The same matrix against the deployed site |
| `npm run verify` | validate + test + build + check-links + audit |
| `npm run migrate` | Re-run the whole import pipeline against the live site |
| `npm run archive:local` | Offline ingest of plan files dropped into `public/plans/<slug>/` — no network |
| `npm run resume` | Crash / power-loss recovery (see below) |

The `npm run migrate` chain is a **one-shot migration tool**. The deployed site never calls
it and never depends on parkjets.com being online.

## Technology

| | |
|---|---|
| Framework | [Astro 7](https://astro.build) — static output, zero runtime |
| Styling | Hand-written CSS with cascade layers, custom properties and container-free fluid type |
| Animation | CSS keyframes + a ~3 KB dependency-free observer script (`src/scripts/motion.js`) |
| Interactivity | Progressive enhancement over pre-rendered HTML — the catalogue works with JavaScript disabled |
| Hosting | GitHub Pages (static) |
| Deployment | GitHub Actions → `actions/deploy-pages` |
| Runtime dependencies | Astro only. Zero third-party JavaScript ships to the browser except a webfont stylesheet. |

### Accessibility & motion

Semantic landmarks, a skip link, visible focus rings, keyboard-operable search (`/` focuses
it), filters, gallery and lightbox, `aria-pressed` / `aria-selected` / `aria-live` state,
and descriptive alt text derived from the original captions. Every animation — hero
entrance, scroll reveal, counters, parallax, card hover, page transitions, grid drift — is
disabled under `prefers-reduced-motion: reduce`, and the site remains fully usable.

### Privacy

No cookies, no analytics, no advertising, no fingerprinting, no third-party scripts. The
only external request the site can make is for the webfont stylesheet, and that loads
non-render-blocking. Aircraft pages link out to the original sources, but the archive itself
phones home to nobody.

## Reports

* [`reports/migration-report.md`](reports/migration-report.md) — what was found, what was
  imported, what could not be archived and why
* [`reports/qa-report.md`](reports/qa-report.md) — the browser test matrix, per viewport and
  per check
* [`reports/audit-report.md`](reports/audit-report.md) — payload measurements and the
  accessibility checks
* [`reports/image-extraction.json`](reports/image-extraction.json) — image download log
* [`data/archive-manifest.json`](data/archive-manifest.json) — per-aircraft checksum and
  validation audit trail

---

## Crash and power-loss recovery

The migration is driven by a durable state file rather than by memory, so a power cut, a
crashed terminal or a reboot can never lose track of what is done.

```
.migration/
├── state.json       status, phase, last commit, evidence snapshot
├── queue.json       every task and whether it is done
├── completed.json   completed tasks, with the evidence that proves each one
├── failed.json      failures, with attempt counts and retry guidance
├── checkpoint.json  last checkpoint (commit, dirty-file count, in-sync flag)
└── logs/            append-only human-readable log
```

Nothing in that state is asserted; every flag is derived from the repository itself by
`scripts/migration-state.mjs`.

```bash
npm run state            # full status, with live evidence
npm run state:next       # the single next task
npm run state:evidence   # the raw evidence as JSON
```

### Resuming by hand

```powershell
npm run resume:status     # show the decision, launch nothing
npm run resume:dry-run    # show the exact command AND whether a real run would launch
npm run resume            # actually resume
```

or double-click **`scripts\resume-parkjets.cmd`**.

### Resuming automatically

Install the Windows scheduled task once:

```powershell
npm run resume:install-task
```

This registers **`ParkjetsArchiveRecovery`**, which runs at every logon (with a one-minute
delay) and once a day. `-StartWhenAvailable` means a logon that happened while the machine
was off is not missed, and `-MultipleInstances IgnoreNew` means overlapping triggers cannot
stack. To remove it:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\resume-parkjets.ps1 -UninstallTask
```

### What the resume script will never do

| Guard | Behaviour |
|---|---|
| Project complete | Reads `status: "completed"` **and** cross-checks that the queue and failure list are empty, then exits 0 without launching. A stale or hand-edited state file cannot cause a relaunch loop. |
| Already running | Two independent guards: a lock file holding a live PID, and a process scan for any running `opencode`. If either trips, it exits 0 without launching. |
| Crashed previous run | A lock file whose PID no longer exists is detected, logged and cleared, so a crash does not wedge the project permanently. |
| Your work | Only ever runs `git status` for the record. It never resets, cleans, checks out or otherwise touches the working tree. |
| Failed task | Recorded in `failed.json` with its reason and attempt count. Recoverable failures are retried first on the next run. |

Each run appends to `.migration/logs/resume-YYYY-MM.log`.

> **Windows PowerShell 5.1 note.** `scripts\resume-parkjets.ps1` is deliberately ASCII-only
> and carries a UTF-8 BOM, because 5.1 mis-decodes a BOM-less UTF-8 file and turns an
> em dash into a syntax error. `npm run icons` is unrelated, but
> `node scripts/normalize-scripts.mjs` re-asserts this and is run before every commit.

## Licence

Project code: MIT. Archived third-party content: not licensed by this project — see
[`LICENSE`](LICENSE) and "Source and attribution" above.
