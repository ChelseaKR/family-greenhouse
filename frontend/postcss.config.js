export default {
  plugins: {
    // Tailwind v4 ships its PostCSS integration as a separate package
    // (`@tailwindcss/postcss`) instead of using `tailwindcss` directly.
    // Vendor prefixing now happens inside Tailwind's own Lightning CSS
    // pass, so autoprefixer is no longer part of the chain.
    '@tailwindcss/postcss': {},
  },
};
