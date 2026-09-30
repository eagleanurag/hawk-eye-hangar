# HawkEye Hangar — performance & accessibility audit

_Generated 2026-09-30T12:09:00.345Z by `npm run audit`._

## Payload

| | |
|---|---|
| Shared JavaScript | 13.8 KB (6 files) |
| Shared CSS | 54.5 KB (6 files) |
| HTML | 2848.9 KB across 114 pages |
| Archived media | 48.1 MB across 838 files |

No third-party JavaScript is shipped. The only external request the site can make is a webfont stylesheet, loaded non-render-blocking.

## First load (390px viewport, up to `networkidle`)

| Page | Requests | JS | CSS | Images | Other |
|---|---:|---:|---:|---:|---:|
| home | 12 | 5.0 KB | 46.0 KB | 113.2 KB | 149.7 KB |
| catalog | 16 | 8.5 KB | 37.9 KB | 799.9 KB | 394.4 KB |
| detail | 15 | 5.7 KB | 43.8 KB | 98.1 KB | 129.3 KB |
| designers | 10 | 2.8 KB | 34.0 KB | 51.5 KB | 154.4 KB |
| about | 10 | 2.8 KB | 36.5 KB | 51.5 KB | 122.3 KB |

## Checks

- ✓ home: tap targets >= 24px (WCAG 2.5.8, 68 measured, 57 standalone)
- ✓ catalog: tap targets >= 24px (WCAG 2.5.8, 185 measured, 182 standalone)
- ✓ detail: tap targets >= 24px (WCAG 2.5.8, 48 measured, 39 standalone)
- ✓ designers: tap targets >= 24px (WCAG 2.5.8, 169 measured, 166 standalone)
- ✓ about: tap targets >= 24px (WCAG 2.5.8, 28 measured, 23 standalone)

## Notes

- ⚠ home: target-size — 68 measured, 11 inline-exempt, 57/57 standalone pass; smallest standalone 69x31
- ⚠ catalog: target-size — 185 measured, 3 inline-exempt, 182/182 standalone pass; smallest standalone 69x31
- ⚠ detail: target-size — 48 measured, 9 inline-exempt, 39/39 standalone pass; smallest standalone 96x29
- ⚠ designers: target-size — 169 measured, 3 inline-exempt, 166/166 standalone pass; smallest standalone 125x25
- ⚠ about: target-size — 28 measured, 5 inline-exempt, 23/23 standalone pass; smallest standalone 132x29

**No problems found.**
