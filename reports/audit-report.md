# EagleEye Hangar — performance & accessibility audit

_Generated 2026-09-29T22:41:57.773Z by `npm run audit`._

## Payload

| | |
|---|---|
| Shared JavaScript | 13.8 KB (6 files) |
| Shared CSS | 54.3 KB (6 files) |
| HTML | 2967.4 KB across 114 pages |
| Archived media | 48.1 MB across 838 files |

No third-party JavaScript is shipped. The only external request the site can make is a webfont stylesheet, loaded non-render-blocking.

## First load (390px viewport, up to `networkidle`)

| Page | Requests | JS | CSS | Images | Other |
|---|---:|---:|---:|---:|---:|
| home | 10 | 5.0 KB | 45.7 KB | 12.6 KB | 150.9 KB |
| catalog | 15 | 8.5 KB | 37.9 KB | 748.4 KB | 399.0 KB |
| detail | 14 | 5.7 KB | 43.8 KB | 46.6 KB | 130.5 KB |
| designers | 9 | 2.8 KB | 34.0 KB | 0.0 KB | 156.5 KB |
| about | 9 | 2.8 KB | 36.5 KB | 0.0 KB | 123.1 KB |

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
