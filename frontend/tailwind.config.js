/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        // Deep brand green used for hand-drawn strokes and serif titles.
        // Lives at the top so it can sit alongside primary/accent without
        // duplicating the `colors` key (a duplicate key would silently
        // wipe out the brand scales).
        ink: '#27500A',
        // Daylight surfaces: the prior cream/parchment pair leaned hard into
        // a generic stationery look. These cooler neutrals pick up the color
        // of greenhouse glass while keeping the journal warmth in the copy
        // and terracotta details.
        paper: '#F7F8F2',
        parchment: '#EEF1E6',
        glass: '#DDEEE7',
        dew: '#B7D9D1',
        // Brand primary scale. Built around the greenhouse-asset palette
        // (#27500A, #639922, #97C459) with a 50–950 ramp interpolated for
        // UI use. WCAG: 700 (#27500A) on white = 9.3:1, 600 on white =
        // 5.5:1 — both clear AA. The 100/200 tints come straight from the
        // brand SVGs (#EAF3DE / #C0DD97) so logo + UI accents harmonize.
        primary: {
          50: '#f5fae9',
          100: '#eaf3de',
          200: '#c0dd97',
          300: '#97c459',
          400: '#7aad3a',
          500: '#639922',
          600: '#4f7a1b',
          700: '#3b6d11',
          800: '#27500a',
          900: '#173404',
          950: '#0e2103',
        },
        // Warm terracotta accent — used sparingly for secondary CTAs and
        // illustrations. Distinct from anything in the default palette.
        accent: {
          50: '#fdf4ed',
          100: '#fae6d4',
          200: '#f4caa4',
          300: '#eda86a',
          400: '#e58a3f',
          500: '#dc6c1f',
          600: '#c8541a',
          700: '#a23f1a',
          800: '#7e3219',
          900: '#5e2614',
        },
        secondary: {
          50: '#fefce8',
          100: '#fef9c3',
          200: '#fef08a',
          300: '#fde047',
          400: '#facc15',
          500: '#eab308',
          600: '#ca8a04',
          700: '#a16207',
          800: '#854d0e',
          900: '#713f12',
          950: '#422006',
        },
      },
      fontFamily: {
        // Body font per brand guidelines: Instrument Sans (variable
        // woff2, self-hosted via @fontsource). Inter + system stack as
        // fallbacks so unloaded body text still reads cleanly.
        sans: [
          '"Instrument Sans Variable"',
          'Inter',
          'system-ui',
          '-apple-system',
          'BlinkMacSystemFont',
          'Segoe UI',
          'Roboto',
          'sans-serif',
        ],
        // Display font per brand guidelines: Bitter Variable (100–900,
        // self-hosted). Used on the wordmark and major headlines.
        //
        // We mount Bitter Variable as `font-serif` rather than a custom
        // `font-display` key on purpose: `font-display` collides with the
        // CSS `font-display` keyword and Tailwind's `@apply` engine
        // rejects it. Using the built-in `serif` slot avoids the clash
        // and is also semantically accurate.
        serif: [
          '"Bitter Variable"',
          'Bitter',
          'Georgia',
          'Cambria',
          '"Times New Roman"',
          'Times',
          'serif',
        ],
      },
      spacing: {
        18: '4.5rem',
        88: '22rem',
      },
      minHeight: {
        touch: '44px',
      },
      minWidth: {
        touch: '44px',
      },
      // Re-export the named greenhouse surfaces so existing `bg-paper` and
      // `bg-parchment` callers plus the newer glass accents share one source.
      backgroundColor: ({ theme }) => ({
        ...theme('colors'),
        paper: '#F7F8F2',
        parchment: '#EEF1E6',
        glass: '#DDEEE7',
        dew: '#B7D9D1',
      }),
      // Brand-green-tinted shadows. `card` is the original; `journal` is
      // softer + lifted as if a paper page rests on the desk; `lifted` is
      // hover variant.
      boxShadow: {
        card: '0 1px 2px 0 rgb(23 52 4 / 0.05), 0 1px 3px 0 rgb(23 52 4 / 0.06)',
        'card-hover': '0 4px 6px -1px rgb(23 52 4 / 0.09), 0 2px 4px -2px rgb(23 52 4 / 0.06)',
        journal: '0 1px 0 0 rgb(23 52 4 / 0.04), 0 10px 30px -20px rgb(23 52 4 / 0.22)',
        'journal-hover': '0 1px 0 0 rgb(23 52 4 / 0.04), 0 18px 40px -22px rgb(23 52 4 / 0.28)',
      },
      keyframes: {
        // Subtle entrance for cards as they hydrate. 200ms is the sweet
        // spot — long enough to feel intentional, short enough that the
        // page never feels sluggish.
        'fade-in': {
          '0%': { opacity: '0', transform: 'translateY(4px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
      },
      animation: {
        'fade-in': 'fade-in 200ms ease-out both',
      },
    },
  },
  plugins: [],
};
