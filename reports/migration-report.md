# Parkjets Archive — migration report

_Generated 2026-09-29T12:56:47.810Z by `npm run report` from the actual archive artefacts.
Every number below is computed from `data/aircraft.json` and `data/archive-manifest.json`._

## 1. Source

| | |
|---|---|
| Original site | https://www.parkjets.com |
| Plan collection | /free-plans |
| Platform | Squarespace 7.1 commerce + MemberSpace membership |
| URLs in sitemap.xml | 419 |
| Collection item count reported by the platform | 118 |

The collection JSON, `sitemap.xml` and the eight category pages were all read
and cross-checked. They agree exactly: **0 URLs in the sitemap
missing from the collection, 0 collection items missing from the sitemap, 0 duplicate slugs.**
The "135+ plans" figure in the original page's marketing copy is not reflected
in the published collection, which contains **109 items**.

## 2. Outcome

| Metric | Count | |
|---|---:|---|
| Aircraft discovered | 109 | 100% |
| Aircraft imported | 109 | 100% |
| Import failures | 0 | |
| **Plans archived locally** | **0** | |
| **Source-only (member-gated)** | **109** | 100% |
| Unavailable | 0 | |
| Manual review | 0 | |
| Records flagged for review | 20 | |
| Aircraft with structured specifications | 90 | 83% |
| Parsed specification values | 503 | |
| Designers credited | 50 | |
| Entries with no designer credit | 2 | |
| Categories | 7 | |
| Photographs archived | 419 | |
| Image files (2 sizes each) | 838 | 48.1 MB |
| Build-thread links preserved | 110 | |
| Other external links preserved | 134 | |

## 3. Why no plan files are mirrored

Parkjets published every plan file as a Squarespace digital good released only
to signed-in MemberSpace members. There is no public, unauthenticated
download URL for any of them. This archive respects that access control and
does not attempt to circumvent it.

For every aircraft the pipeline probes the endpoints the source site actually
exposes, records the result, and then classifies the record:

| Status | Meaning |
|---|---|
| `ARCHIVED` | A validated file lives in `public/plans/<slug>/` and downloads from this site. |
| `SOURCE_ONLY` | Entry, imagery and original filename archived; the file comes from the original product page. |
| `UNAVAILABLE` | The source entry publishes no file. |
| `MANUAL_REVIEW` | A file is present but failed validation. |

Current distribution: 0 archived, 109 source-only, 0 unavailable, 0 manual review.

Declared plan file types at the source: `ZIP` ×105, `PDF` ×4.

**If the site owner releases any of these files for redistribution**, dropping them into
`public/plans/<slug>/` with their original filename is the only step required. The next
`npm run archive` validates them, records a SHA-256 and the site's download
buttons switch from "Open original source" to a real download automatically.

## 4. Categories (verbatim from the source taxonomy)

| Foam | 107 |
| Pusher | 91 |
| Profile | 35 |
| Fantasy | 24 |
| EDF | 8 |
| 3D | 4 |
| Decals | 1 |

## 5. Designers

- **Steve Shumate** — 11
- **Dennis Schmalzel** — 9
- **Jamie Rothwell** — 7
- **Robertus** — 6
- **Marcel du Plessis** — 5
- **Nick Cara** — 5
- **Tomas Hellberg** — 5
- **GGRN** — 4
- **Domenico Sebastiani** — 3
- **Robert Viskil** — 3
- **Ben Song (Beanie)** — 2
- **Chris Carpenter** — 2
- **DCobra** — 2
- **Eduardo Flores** — 2
- **Fuelsguy** — 2
- **Hans-Joachim** — 2
- **Pat Gagnon** — 2
- **Sean Correia** — 2
- **Steven Wong** — 2
- **Adriel Baskoro** — 1
- **BadDog and Woody** — 1
- **Beanie** — 1
- **Bigglesjets** — 1
- **Bob Templeton** — 1
- **Brent Hecht** — 1
- **Brice Faucillon** — 1
- **David Martel** — 1
- **Denis CyberD** — 1
- **FoamyFactory (Tim Hart)** — 1
- **FuelsGuy** — 1
- **Hansie** — 1
- **Jason Swisher** — 1
- **Jim Wagoner** — 1
- **John Bright** — 1
- **Matt Halton** — 1
- **Matti Huaviala** — 1
- **Maybz** — 1
- **Mike DiMonte** — 1
- **Mike Jackson** — 1
- **Miroslav Matousu** — 1
- **Mr. Boogie** — 1
- **Mr. Flash** — 1
- **Rane** — 1
- **RC CAL** — 1
- **RSteel** — 1
- **Sabastian Gulde** — 1
- **StarCad** — 1
- **Steven Wong and Fuelsguy** — 1
- **SuperHornet** — 1
- **Thomas Nelson** — 1

## 6. Known limitations (all inherited from the source)

### 6.1 No structured specifications (19)

- `a-6-intruder` — A-6 Intruder
- `avro-arrow` — Avro Arrow
- `decal-pack` — Decal Pack for Parkjets
- `decent-spaceship` — Decent Spaceship
- `f-104-starfighter` — F-104 Starfighter
- `f-106-delta-dart` — F-106 Delta Dart
- `f-117-night-hawk` — F-117 Night Hawk
- `f-14-tomcat-3` — F-14 Tomcat
- `f-14-tomcat-2` — F-14 Tomcat MH
- `f-16-falcon-1` — F-16 Falcon HJ
- `f-18e-super-hornet-1` — F-18E Super Hornet — BadDog and Woody
- `f-20-tigershark-1` — F-20 Tigershark DC
- `f-28-hammer` — F-28 Hammer
- `f-4-phantom-ii` — F-4 Phantom II
- `f4d-skyray-1` — F4D Skyray — Brent Hecht
- `hunter` — Hunter
- `mirage-2000` — Mirage 2000
- `super-bandit` — Super Bandit
- `xb-70` — XB-70

These entries were published with no labelled specification block. Their pages
show the designer's own words verbatim instead of guessed values.

### 6.2 No designer credit (2)

- `decal-pack` — Decal Pack for Parkjets
- `hydro-plane` — Hydro-Plane

The archive records the absence rather than guessing an author.

### 6.3 Uncategorised (0)

_None — every record is filed under at least one source category._

## 7. Failures

_No failures in the final run. Every aircraft imported and every image downloaded successfully._

## 8. Data quality policy

The importer never invents data.

* A specification is recorded only when the designer literally wrote `Key: value`,
  `Key = value`, `Key - value` or `Key value` for a recognised field name.
* Unlabelled fragments such as `GWS 20 A ESC | 9X7 slowfly prop` are **never**
  promoted into a motor/ESC/propeller field. They are preserved verbatim and shown
  under "What you'll need to build it".
* Where a designer wrote a value that could plausibly belong to two fields, it is
  left exactly as written and flagged rather than split.
* Every source page is permanently linked from its archive record.
