# Family Greenhouse — Brand Guidelines

## Logo

The Family Greenhouse logo consists of a greenhouse icon with two plants inside and the wordmark "Family Greenhouse" set in Gloock (serif). The tagline "GROW TOGETHER" appears in spaced caps beneath.

### Clear Space

Always maintain a minimum clear space of 1× the icon height on all sides of the logo.

### Minimum Size

- Full logo: 200px wide (digital), 60mm (print)
- Icon only: 32px (digital), 10mm (print)

---

## Color Palette

| Name       | Hex       | Usage                             |
| ---------- | --------- | --------------------------------- |
| Forest     | `#173404` | Deep backgrounds, dark mode fills |
| Canopy     | `#27500A` | Primary text, wordmark            |
| Leaf Dark  | `#3B6D11` | Icon frames, strokes, accents     |
| Leaf Mid   | `#639922` | Primary brand green, CTA buttons  |
| Leaf Light | `#97C459` | Highlights, hover states, tagline |
| Pale Fern  | `#C0DD97` | Light backgrounds, roof fills     |
| Greenhouse | `#EAF3DE` | Page background, card fills       |
| Soil       | `#888780` | Neutral, borders, muted text      |
| White      | `#FFFFFF` | Reversed text, light surfaces     |

---

## Typography

| Role         | Font            | Weight | Notes                     |
| ------------ | --------------- | ------ | ------------------------- |
| Display/Logo | Gloock          | 400    | Headlines, hero text      |
| Body         | Instrument Sans | 400    | Body copy, UI text        |
| Labels       | Instrument Sans | 500    | Buttons, tags, small caps |

Font stacks:

```css
--font-display: 'Gloock', Georgia, serif;
--font-body: 'Instrument Sans', system-ui, sans-serif;
```

---

## Logo Files

| File                    | Format | Use Case                       |
| ----------------------- | ------ | ------------------------------ |
| `svg/logo.svg`          | SVG    | Web, scalable, primary         |
| `svg/logo-dark.svg`     | SVG    | Dark backgrounds               |
| `svg/icon.svg`          | SVG    | Icon-only uses                 |
| `logo-light.png`        | PNG    | Transparent bg, light contexts |
| `logo-on-white.png`     | PNG    | White background               |
| `logo-dark.png`         | PNG    | Dark/forest background         |
| `icon-512.png`          | PNG    | App stores, large icon uses    |
| `icon-512-on-green.png` | PNG    | App icon with green background |
| `icon-192.png`          | PNG    | PWA manifest icon              |
| `favicon.ico`           | ICO    | Browser tab favicon            |
| `favicon-32x32.png`     | PNG    | Browser favicon PNG            |
| `apple-touch-icon.png`  | PNG    | iOS home screen icon           |
| `og-image.png`          | PNG    | Open Graph / link previews     |
| `twitter-card.png`      | PNG    | Twitter/X card image           |

---

## HTML Head Snippet

```html
<!-- Favicon -->
<link rel="icon" href="/favicon.ico" sizes="any" />
<link rel="icon" href="/favicon-32x32.png" type="image/png" />
<link rel="apple-touch-icon" href="/apple-touch-icon.png" />

<!-- Open Graph -->
<meta property="og:image" content="https://app.familygreenhouse.com/og-image.png" />
<meta property="og:image:width" content="1200" />
<meta property="og:image:height" content="630" />

<!-- Twitter -->
<meta name="twitter:card" content="summary_large_image" />
<meta name="twitter:image" content="https://app.familygreenhouse.com/twitter-card.png" />
```

---

## PWA Manifest Snippet

```json
{
  "name": "Family Greenhouse",
  "short_name": "Greenhouse",
  "icons": [
    { "src": "/icon-192.png", "sizes": "192x192", "type": "image/png" },
    { "src": "/icon-512.png", "sizes": "512x512", "type": "image/png" }
  ],
  "theme_color": "#639922",
  "background_color": "#EAF3DE"
}
```

---

## Do's & Don'ts

✅ Use the logo on white, cream, or forest-dark backgrounds  
✅ Maintain the aspect ratio — never stretch  
✅ Use the SVG version whenever possible for crisp rendering  
✅ Use the dark variant (`logo-dark.svg` / `logo-dark.png`) on dark backgrounds

❌ Don't recolor the icon  
❌ Don't place on busy photographic backgrounds without a solid backdrop  
❌ Don't use the icon smaller than 32px  
❌ Don't add drop shadows, outlines, or effects to the logo
