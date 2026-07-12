# Store release assets

Generated artwork and reviewed English metadata for the iOS App Store and
Google Play. Run `npm run brand:render --workspace frontend` after changing a
source SVG, then `npm run mobile:validate` before building a release.

Screenshots must come from the final synchronized build and must not include
real user data. Reviewer credentials and signing material are intentionally
not stored here.
