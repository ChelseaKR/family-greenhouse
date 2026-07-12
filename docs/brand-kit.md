# Family Greenhouse asset kit

The creative rules and voice live in [brand.md](brand.md). This file documents export use and dimensions.

## Logo

The Family Greenhouse mark shows two plants growing inside one glasshouse. The stacked wordmark uses Gloock 400; “GROW TOGETHER” uses tracked Instrument Sans.

### Clear space and minimum size

- Keep clear space equal to at least one quarter of the greenhouse width.
- Full lockup: minimum 200px wide digitally / 60mm in print.
- Icon: minimum 32px digitally.
- Do not stretch, outline, shadow, or place the mark on a busy image.

## Core colors

| Name       | Hex       | Use                             |
| ---------- | --------- | ------------------------------- |
| Forest     | `#173404` | Native chrome, dark backgrounds |
| Canopy     | `#27500A` | Wordmark, greenhouse frame      |
| Leaf dark  | `#3B6D11` | Strokes                         |
| Leaf mid   | `#639922` | Plant fills                     |
| Leaf light | `#97C459` | Highlights                      |
| Glass      | `#DDEEE7` | Panes                           |
| Dew        | `#B7D9D1` | Quiet structure and borders     |
| Paper      | `#F7F8F2` | Main light background           |
| Parchment  | `#EEF1E6` | Secondary light background      |
| Terracotta | `#DC6C1F` | Threshold/pot accent            |

## Typography

| Role           | Font                     | Weight            |
| -------------- | ------------------------ | ----------------- |
| Display / logo | Gloock                   | 400 only          |
| Body / UI      | Instrument Sans Variable | 400–600           |
| Utility labels | Instrument Sans Variable | 600 with tracking |

## Public exports

All paths are relative to `frontend/public/brand/`.

| File                                                 | Use                                |
| ---------------------------------------------------- | ---------------------------------- |
| `icon.svg`                                           | Light-surface icon and SVG favicon |
| `icon-on-green.svg`                                  | Dark/maskable source               |
| `logo.svg`                                           | Stacked light-context lockup       |
| `logo-dark.svg`                                      | Stacked forest lockup              |
| `logo-light.png`                                     | Transparent raster lockup          |
| `logo-on-white.png`                                  | White-background raster lockup     |
| `logo-dark.png`                                      | Forest-background raster lockup    |
| `icon-192.png`                                       | PWA and browser notification icon  |
| `icon-512.png`                                       | PWA/schema icon                    |
| `icon-512-on-green.png`                              | Maskable PWA icon                  |
| `apple-touch-icon.png`                               | iOS home-screen web clip           |
| `favicon.ico`, `favicon-32x32.png`, `favicon-64.png` | Browser icons                      |
| `og-image.png`                                       | Open Graph card, 1200×630          |
| `twitter-card.png`                                   | X/Twitter card, 1200×600           |

Social cards keep pane lines below 12% opacity and reserve a clean text field.

## Native exports

The renderer updates:

- iOS 1024×1024 AppIcon and universal launch artwork.
- Android legacy square/round launchers for mdpi through xxxhdpi.
- Android adaptive foregrounds and Android 13 monochrome artwork.
- Android portrait and landscape splash fallbacks.

The forest background fills the full canvas. Important artwork stays within the central adaptive-icon safe area.

## Rebuild

```sh
cd frontend
./scripts/render-brand-assets.sh
```

Requires `rsvg-convert` and `ffmpeg`. Source compositions live in `frontend/scripts/brand-assets/`.

## PWA settings

```json
{
  "theme_color": "#173404",
  "background_color": "#F7F8F2"
}
```

Use `icon-512-on-green.png` with `purpose: "maskable"`.
