# Parkjets Archive — browser QA report

_Generated 2026-09-29T12:35:21.171Z by `npm run qa`._

**Target:** https://eagleanurag.github.io/parkjet-aircraft-archive

**Result: 240/240 checks passed across 8 viewports.**

## Viewports

| Viewport | Width | Height | Result |
|---|---:|---:|---|
| desktop-1920 | 1920 | 1080 | ✓ 29/29 |
| desktop-1440 | 1440 | 900 | ✓ 29/29 |
| desktop-1366 | 1366 | 768 | ✓ 29/29 |
| tablet-1024 | 1024 | 1366 | ✓ 29/29 |
| tablet-768 | 768 | 1024 | ✓ 31/31 |
| mobile-430 | 430 | 932 | ✓ 31/31 |
| mobile-390 | 390 | 844 | ✓ 31/31 |
| mobile-375 | 375 | 812 | ✓ 31/31 |

## What is covered

- Horizontal overflow (the hard "no sideways scroll" requirement)
- Console errors and failed network requests
- Broken images, and **paint-level** verification that the gallery hero image is actually on screen
- Search: matches, live result count, no-result empty state, clear button, and that filtering really hides cards
- Filters: category, designer and plan-availability, including that each narrows the result set
- Query-string deep links and fallback for unknown filter values
- Browser back button after a state change
- Aircraft detail: title, plan action resolves (local file or source URL), gallery thumbnails, counter, keyboard nav
- Mobile navigation: hamburger visible, opens, closes
- 404 handling

## Full results

### desktop-1920

| | Check | Detail |
|---|---|---|
| ✓ | home: no horizontal overflow |  |
| ✓ | home: h1 present (PARKJETS ARCHIVE) |  |
| ✓ | home: 8 featured cards |  |
| ✓ | catalog: no horizontal overflow |  |
| ✓ | catalog: 109 cards rendered |  |
| ✓ | catalog: search "f-22" -> 109 |  |
| ✓ | catalog: count "36 OF 109 AIRCRAFT MATCH" |  |
| ✓ | catalog: empty state shown |  |
| ✓ | catalog: no-result hides every card |  |
| ✓ | catalog: clear restores all |  |
| ✓ | catalog: filter Foam -> 107 |  |
| ✓ | catalog: designer Steve Shumate -> 11 |  |
| ✓ | catalog: plan filter Source link only -> 109 |  |
| ✓ | catalog: deep link -> 12 |  |
| ✓ | catalog: unknown filter falls back to All |  |
| ✓ | catalog: back button restores |  |
| ✓ | detail: hero image paints on screen (237 distinct samples) |  |
| ✓ | detail: no horizontal overflow |  |
| ✓ | detail: "F-22 Raptor" |  |
| ✓ | detail: no broken images |  |
| ✓ | detail: gallery thumbnails render |  |
| ✓ | detail: source link OK (Open original source) |  |
| ✓ | gallery: 8 thumbnails |  |
| ✓ | gallery: thumbnail changes image |  |
| ✓ | gallery: counter 3 / 8 |  |
| ✓ | gallery: stage image paints (variance 34) |  |
| ✓ | 404 page served |  |
| ✓ | no console errors |  |
| ✓ | no failed requests |  |

### desktop-1440

| | Check | Detail |
|---|---|---|
| ✓ | home: no horizontal overflow |  |
| ✓ | home: h1 present (PARKJETS ARCHIVE) |  |
| ✓ | home: 8 featured cards |  |
| ✓ | catalog: no horizontal overflow |  |
| ✓ | catalog: 109 cards rendered |  |
| ✓ | catalog: search "f-22" -> 36 |  |
| ✓ | catalog: count "36 OF 109 AIRCRAFT MATCH" |  |
| ✓ | catalog: empty state shown |  |
| ✓ | catalog: no-result hides every card |  |
| ✓ | catalog: clear restores all |  |
| ✓ | catalog: filter Foam -> 107 |  |
| ✓ | catalog: designer Steve Shumate -> 11 |  |
| ✓ | catalog: plan filter Source link only -> 109 |  |
| ✓ | catalog: deep link -> 12 |  |
| ✓ | catalog: unknown filter falls back to All |  |
| ✓ | catalog: back button restores |  |
| ✓ | detail: hero image paints on screen (237 distinct samples) |  |
| ✓ | detail: no horizontal overflow |  |
| ✓ | detail: "F-22 Raptor" |  |
| ✓ | detail: no broken images |  |
| ✓ | detail: gallery thumbnails render |  |
| ✓ | detail: source link OK (Open original source) |  |
| ✓ | gallery: 8 thumbnails |  |
| ✓ | gallery: thumbnail changes image |  |
| ✓ | gallery: counter 3 / 8 |  |
| ✓ | gallery: stage image paints (variance 34) |  |
| ✓ | 404 page served |  |
| ✓ | no console errors |  |
| ✓ | no failed requests |  |

### desktop-1366

| | Check | Detail |
|---|---|---|
| ✓ | home: no horizontal overflow |  |
| ✓ | home: h1 present (PARKJETS ARCHIVE) |  |
| ✓ | home: 8 featured cards |  |
| ✓ | catalog: no horizontal overflow |  |
| ✓ | catalog: 109 cards rendered |  |
| ✓ | catalog: search "f-22" -> 36 |  |
| ✓ | catalog: count "36 OF 109 AIRCRAFT MATCH" |  |
| ✓ | catalog: empty state shown |  |
| ✓ | catalog: no-result hides every card |  |
| ✓ | catalog: clear restores all |  |
| ✓ | catalog: filter Foam -> 107 |  |
| ✓ | catalog: designer Steve Shumate -> 11 |  |
| ✓ | catalog: plan filter Source link only -> 109 |  |
| ✓ | catalog: deep link -> 12 |  |
| ✓ | catalog: unknown filter falls back to All |  |
| ✓ | catalog: back button restores |  |
| ✓ | detail: hero image paints on screen (256 distinct samples) |  |
| ✓ | detail: no horizontal overflow |  |
| ✓ | detail: "F-22 Raptor" |  |
| ✓ | detail: no broken images |  |
| ✓ | detail: gallery thumbnails render |  |
| ✓ | detail: source link OK (Open original source) |  |
| ✓ | gallery: 8 thumbnails |  |
| ✓ | gallery: thumbnail changes image |  |
| ✓ | gallery: counter 3 / 8 |  |
| ✓ | gallery: stage image paints (variance 34) |  |
| ✓ | 404 page served |  |
| ✓ | no console errors |  |
| ✓ | no failed requests |  |

### tablet-1024

| | Check | Detail |
|---|---|---|
| ✓ | home: no horizontal overflow |  |
| ✓ | home: h1 present (PARKJETS ARCHIVE) |  |
| ✓ | home: 8 featured cards |  |
| ✓ | catalog: no horizontal overflow |  |
| ✓ | catalog: 109 cards rendered |  |
| ✓ | catalog: search "f-22" -> 36 |  |
| ✓ | catalog: count "36 OF 109 AIRCRAFT MATCH" |  |
| ✓ | catalog: empty state shown |  |
| ✓ | catalog: no-result hides every card |  |
| ✓ | catalog: clear restores all |  |
| ✓ | catalog: filter Foam -> 107 |  |
| ✓ | catalog: designer Steve Shumate -> 11 |  |
| ✓ | catalog: plan filter Source link only -> 109 |  |
| ✓ | catalog: deep link -> 12 |  |
| ✓ | catalog: unknown filter falls back to All |  |
| ✓ | catalog: back button restores |  |
| ✓ | detail: hero image paints on screen (240 distinct samples) |  |
| ✓ | detail: no horizontal overflow |  |
| ✓ | detail: "F-22 Raptor" |  |
| ✓ | detail: no broken images |  |
| ✓ | detail: gallery thumbnails render |  |
| ✓ | detail: source link OK (Open original source) |  |
| ✓ | gallery: 8 thumbnails |  |
| ✓ | gallery: thumbnail changes image |  |
| ✓ | gallery: counter 3 / 8 |  |
| ✓ | gallery: stage image paints (variance 34) |  |
| ✓ | 404 page served |  |
| ✓ | no console errors |  |
| ✓ | no failed requests |  |

### tablet-768

| | Check | Detail |
|---|---|---|
| ✓ | home: no horizontal overflow |  |
| ✓ | home: h1 present (PARKJETS ARCHIVE) |  |
| ✓ | home: 8 featured cards |  |
| ✓ | catalog: no horizontal overflow |  |
| ✓ | catalog: 109 cards rendered |  |
| ✓ | catalog: search "f-22" -> 36 |  |
| ✓ | catalog: count "36 OF 109 AIRCRAFT MATCH" |  |
| ✓ | catalog: empty state shown |  |
| ✓ | catalog: no-result hides every card |  |
| ✓ | catalog: clear restores all |  |
| ✓ | catalog: filter Foam -> 107 |  |
| ✓ | catalog: designer Steve Shumate -> 11 |  |
| ✓ | catalog: plan filter Source link only -> 109 |  |
| ✓ | catalog: deep link -> 12 |  |
| ✓ | catalog: unknown filter falls back to All |  |
| ✓ | catalog: back button restores |  |
| ✓ | nav: hamburger visible |  |
| ✓ | nav: opens on tap |  |
| ✓ | detail: hero image paints on screen (256 distinct samples) |  |
| ✓ | detail: no horizontal overflow |  |
| ✓ | detail: "F-22 Raptor" |  |
| ✓ | detail: no broken images |  |
| ✓ | detail: gallery thumbnails render |  |
| ✓ | detail: source link OK (Open original source) |  |
| ✓ | gallery: 8 thumbnails |  |
| ✓ | gallery: thumbnail changes image |  |
| ✓ | gallery: counter 3 / 8 |  |
| ✓ | gallery: stage image paints (variance 34) |  |
| ✓ | 404 page served |  |
| ✓ | no console errors |  |
| ✓ | no failed requests |  |

### mobile-430

| | Check | Detail |
|---|---|---|
| ✓ | home: no horizontal overflow |  |
| ✓ | home: h1 present (PARKJETS ARCHIVE) |  |
| ✓ | home: 8 featured cards |  |
| ✓ | catalog: no horizontal overflow |  |
| ✓ | catalog: 109 cards rendered |  |
| ✓ | catalog: search "f-22" -> 36 |  |
| ✓ | catalog: count "36 OF 109 AIRCRAFT MATCH" |  |
| ✓ | catalog: empty state shown |  |
| ✓ | catalog: no-result hides every card |  |
| ✓ | catalog: clear restores all |  |
| ✓ | catalog: filter Foam -> 107 |  |
| ✓ | catalog: designer Steve Shumate -> 11 |  |
| ✓ | catalog: plan filter Source link only -> 109 |  |
| ✓ | catalog: deep link -> 12 |  |
| ✓ | catalog: unknown filter falls back to All |  |
| ✓ | catalog: back button restores |  |
| ✓ | nav: hamburger visible |  |
| ✓ | nav: opens on tap |  |
| ✓ | detail: hero image paints on screen (256 distinct samples) |  |
| ✓ | detail: no horizontal overflow |  |
| ✓ | detail: "F-22 Raptor" |  |
| ✓ | detail: no broken images |  |
| ✓ | detail: gallery thumbnails render |  |
| ✓ | detail: source link OK (Open original source) |  |
| ✓ | gallery: 8 thumbnails |  |
| ✓ | gallery: thumbnail changes image |  |
| ✓ | gallery: counter 3 / 8 |  |
| ✓ | gallery: stage image paints (variance 34) |  |
| ✓ | 404 page served |  |
| ✓ | no console errors |  |
| ✓ | no failed requests |  |

### mobile-390

| | Check | Detail |
|---|---|---|
| ✓ | home: no horizontal overflow |  |
| ✓ | home: h1 present (PARKJETS ARCHIVE) |  |
| ✓ | home: 8 featured cards |  |
| ✓ | catalog: no horizontal overflow |  |
| ✓ | catalog: 109 cards rendered |  |
| ✓ | catalog: search "f-22" -> 36 |  |
| ✓ | catalog: count "36 OF 109 AIRCRAFT MATCH" |  |
| ✓ | catalog: empty state shown |  |
| ✓ | catalog: no-result hides every card |  |
| ✓ | catalog: clear restores all |  |
| ✓ | catalog: filter Foam -> 107 |  |
| ✓ | catalog: designer Steve Shumate -> 11 |  |
| ✓ | catalog: plan filter Source link only -> 109 |  |
| ✓ | catalog: deep link -> 12 |  |
| ✓ | catalog: unknown filter falls back to All |  |
| ✓ | catalog: back button restores |  |
| ✓ | nav: hamburger visible |  |
| ✓ | nav: opens on tap |  |
| ✓ | detail: hero image paints on screen (256 distinct samples) |  |
| ✓ | detail: no horizontal overflow |  |
| ✓ | detail: "F-22 Raptor" |  |
| ✓ | detail: no broken images |  |
| ✓ | detail: gallery thumbnails render |  |
| ✓ | detail: source link OK (Open original source) |  |
| ✓ | gallery: 8 thumbnails |  |
| ✓ | gallery: thumbnail changes image |  |
| ✓ | gallery: counter 3 / 8 |  |
| ✓ | gallery: stage image paints (variance 34) |  |
| ✓ | 404 page served |  |
| ✓ | no console errors |  |
| ✓ | no failed requests |  |

### mobile-375

| | Check | Detail |
|---|---|---|
| ✓ | home: no horizontal overflow |  |
| ✓ | home: h1 present (PARKJETS ARCHIVE) |  |
| ✓ | home: 8 featured cards |  |
| ✓ | catalog: no horizontal overflow |  |
| ✓ | catalog: 109 cards rendered |  |
| ✓ | catalog: search "f-22" -> 36 |  |
| ✓ | catalog: count "36 OF 109 AIRCRAFT MATCH" |  |
| ✓ | catalog: empty state shown |  |
| ✓ | catalog: no-result hides every card |  |
| ✓ | catalog: clear restores all |  |
| ✓ | catalog: filter Foam -> 107 |  |
| ✓ | catalog: designer Steve Shumate -> 11 |  |
| ✓ | catalog: plan filter Source link only -> 109 |  |
| ✓ | catalog: deep link -> 12 |  |
| ✓ | catalog: unknown filter falls back to All |  |
| ✓ | catalog: back button restores |  |
| ✓ | nav: hamburger visible |  |
| ✓ | nav: opens on tap |  |
| ✓ | detail: hero image paints on screen (256 distinct samples) |  |
| ✓ | detail: no horizontal overflow |  |
| ✓ | detail: "F-22 Raptor" |  |
| ✓ | detail: no broken images |  |
| ✓ | detail: gallery thumbnails render |  |
| ✓ | detail: source link OK (Open original source) |  |
| ✓ | gallery: 8 thumbnails |  |
| ✓ | gallery: thumbnail changes image |  |
| ✓ | gallery: counter 3 / 8 |  |
| ✓ | gallery: stage image paints (variance 34) |  |
| ✓ | 404 page served |  |
| ✓ | no console errors |  |
| ✓ | no failed requests |  |
