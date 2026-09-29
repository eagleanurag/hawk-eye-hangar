# Parkjets Archive — performance & accessibility audit

_Generated 2026-09-29T12:52:27.780Z by `npm run audit`._

## Payload

| | |
|---|---|
| Shared JavaScript | 12.0 KB (6 files) |
| Shared CSS | 49.3 KB (6 files) |
| HTML | 2905.2 KB across 114 pages |
| Archived media | 48.1 MB across 838 files |

No third-party JavaScript is shipped. The only external request the site can make is a webfont stylesheet, loaded non-render-blocking.

## First load (390px viewport, up to `networkidle`)

| Page | Requests | JS | CSS | Images | Other |
|---|---:|---:|---:|---:|---:|
| home | 12 | 3.6 KB | 40.7 KB | 46.2 KB | 148.5 KB |
| catalog | 16 | 9.0 KB | 38.0 KB | 876.0 KB | 413.8 KB |
| detail | 14 | 6.6 KB | 43.9 KB | 46.6 KB | 129.8 KB |
| designers | 9 | 3.6 KB | 34.1 KB | 0.0 KB | 155.8 KB |
| about | 9 | 3.6 KB | 36.6 KB | 0.0 KB | 122.2 KB |

## Checks

- ✓ home: tap targets >= 24px (WCAG 2.5.8, 66 measured, 57 standalone)
- ✓ catalog: tap targets >= 24px (WCAG 2.5.8, 185 measured, 182 standalone)
- ✓ detail: tap targets >= 24px (WCAG 2.5.8, 48 measured, 39 standalone)
- ✓ designers: tap targets >= 24px (WCAG 2.5.8, 169 measured, 166 standalone)
- ✓ about: tap targets >= 24px (WCAG 2.5.8, 28 measured, 23 standalone)

## Notes

- ⚠ home: target-size — 66 measured, 9 inline-exempt, 57/57 standalone pass; smallest standalone 69x31
- ⚠ catalog: target-size — 185 measured, 3 inline-exempt, 182/182 standalone pass; smallest standalone 69x31
- ⚠ detail: target-size — 48 measured, 9 inline-exempt, 39/39 standalone pass; smallest standalone 96x29
- ⚠ designers: target-size — 169 measured, 3 inline-exempt, 166/166 standalone pass; smallest standalone 125x25
- ⚠ about: target-size — 28 measured, 5 inline-exempt, 23/23 standalone pass; smallest standalone 132x29

**No problems found.**
