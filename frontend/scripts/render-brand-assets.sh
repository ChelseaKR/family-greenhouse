#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FRONTEND_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$FRONTEND_DIR/.." && pwd)"
PUBLIC="$FRONTEND_DIR/public/brand"
SOURCES="$SCRIPT_DIR/brand-assets"
ANDROID="$FRONTEND_DIR/android/app/src/main/res"
IOS="$FRONTEND_DIR/ios/App/App/Assets.xcassets"
STORE="$REPO_ROOT/store-assets"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/family-greenhouse-brand.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT

cd "$FRONTEND_DIR"
mkdir -p "$STORE/google-play" "$STORE/app-store"
export FONTCONFIG_FILE="$SOURCES/fonts.conf"
export XDG_CACHE_HOME="$TMP/font-cache"
# Homebrew Pango defaults to CoreText on macOS, which cannot see the fonts
# declared in fonts.conf. Force the Fontconfig backend for deterministic
# cross-platform text rendering.
export PANGOCAIRO_BACKEND=fc

for command in rsvg-convert ffmpeg; do
  if ! command -v "$command" >/dev/null 2>&1; then
    echo "Missing required command: $command" >&2
    exit 1
  fi
done

render() {
  local source="$1" width="$2" height="$3" output="$4"
  rsvg-convert --width "$width" --height "$height" "$source" --output "$output"
}

composite_on_color() {
  local foreground="$1" color="$2" width="$3" height="$4" output="$5"
  ffmpeg -loglevel error -y \
    -f lavfi -i "color=c=${color}:s=${width}x${height}" \
    -i "$foreground" \
    -filter_complex "[0:v][1:v]overlay=(W-w)/2:(H-h)/2:format=auto" \
    -frames:v 1 -pix_fmt rgb24 "$output"
}

render_splash() {
  local width="$1" height="$2" output="$3"
  local side="$width"
  if (( height < side )); then side="$height"; fi
  local square="$TMP/splash-${width}x${height}.png"
  render "$SOURCES/launch-screen.svg" "$side" "$side" "$square"
  composite_on_color "$square" "0x173404" "$width" "$height" "$output"
}

# Web, PWA, social, and reusable exports.
render "$PUBLIC/icon.svg" 32 32 "$PUBLIC/favicon-32x32.png"
render "$PUBLIC/icon.svg" 64 64 "$PUBLIC/favicon-64.png"
render "$PUBLIC/icon.svg" 16 16 "$TMP/favicon-16.png"
render "$PUBLIC/icon.svg" 48 48 "$TMP/favicon-48.png"
render "$PUBLIC/icon.svg" 192 192 "$PUBLIC/icon-192.png"
render "$PUBLIC/icon.svg" 512 512 "$PUBLIC/icon-512.png"
render "$PUBLIC/icon-on-green.svg" 512 512 "$PUBLIC/icon-512-on-green.png"
render "$PUBLIC/icon-on-green.svg" 180 180 "$PUBLIC/apple-touch-icon.png"
node "$SCRIPT_DIR/pack-ico.mjs" \
  "$PUBLIC/favicon.ico" \
  "$TMP/favicon-16.png" \
  "$PUBLIC/favicon-32x32.png" \
  "$TMP/favicon-48.png"

render "$PUBLIC/logo.svg" 800 460 "$PUBLIC/logo-light.png"
composite_on_color "$PUBLIC/logo-light.png" "white" 800 460 "$PUBLIC/logo-on-white.png"
render "$PUBLIC/logo-dark.svg" 800 460 "$PUBLIC/logo-dark.png"
render "$SOURCES/og-image.svg" 1200 630 "$PUBLIC/og-image.png"
render "$SOURCES/twitter-card.svg" 1200 600 "$PUBLIC/twitter-card.png"

# Store listing artwork. These are generated beside the metadata so the exact
# binaries uploaded to the stores are reviewable and reproducible.
render "$PUBLIC/icon.svg" 512 512 "$STORE/google-play/app-icon-512.png"
render "$SOURCES/play-feature-graphic.svg" 1024 500 "$STORE/google-play/feature-graphic-1024x500.png"
render "$PUBLIC/icon-on-green.svg" 1024 1024 "$STORE/app-store/app-icon-1024.png"

# iOS app icon and universal launch art.
render "$PUBLIC/icon-on-green.svg" 1024 1024 "$IOS/AppIcon.appiconset/AppIcon-512@2x.png"
for splash in \
  "$IOS/Splash.imageset/splash-2732x2732.png" \
  "$IOS/Splash.imageset/splash-2732x2732-1.png" \
  "$IOS/Splash.imageset/splash-2732x2732-2.png"; do
  render "$SOURCES/launch-screen.svg" 2732 2732 "$splash"
done

# Android legacy and adaptive launcher bitmaps.
declare -A launcher_sizes=(
  [mdpi]=48 [hdpi]=72 [xhdpi]=96 [xxhdpi]=144 [xxxhdpi]=192
)
declare -A foreground_sizes=(
  [mdpi]=108 [hdpi]=162 [xhdpi]=216 [xxhdpi]=324 [xxxhdpi]=432
)
for density in mdpi hdpi xhdpi xxhdpi xxxhdpi; do
  render "$PUBLIC/icon-on-green.svg" "${launcher_sizes[$density]}" "${launcher_sizes[$density]}" "$ANDROID/mipmap-$density/ic_launcher.png"
  render "$SOURCES/icon-round.svg" "${launcher_sizes[$density]}" "${launcher_sizes[$density]}" "$ANDROID/mipmap-$density/ic_launcher_round.png"
  render "$SOURCES/icon-foreground.svg" "${foreground_sizes[$density]}" "${foreground_sizes[$density]}" "$ANDROID/mipmap-$density/ic_launcher_foreground.png"
done

# Android full-screen splash raster fallbacks.
render_splash 480 320 "$ANDROID/drawable/splash.png"
render_splash 480 320 "$ANDROID/drawable-land-mdpi/splash.png"
render_splash 800 480 "$ANDROID/drawable-land-hdpi/splash.png"
render_splash 1280 720 "$ANDROID/drawable-land-xhdpi/splash.png"
render_splash 1600 960 "$ANDROID/drawable-land-xxhdpi/splash.png"
render_splash 1920 1280 "$ANDROID/drawable-land-xxxhdpi/splash.png"
render_splash 320 480 "$ANDROID/drawable-port-mdpi/splash.png"
render_splash 480 800 "$ANDROID/drawable-port-hdpi/splash.png"
render_splash 720 1280 "$ANDROID/drawable-port-xhdpi/splash.png"
render_splash 960 1600 "$ANDROID/drawable-port-xxhdpi/splash.png"
render_splash 1280 1920 "$ANDROID/drawable-port-xxxhdpi/splash.png"

echo "Rendered Family Greenhouse brand assets."
