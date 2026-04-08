// Hariari dragonfly logo — inline SVG for use in UI components

/** Dragonfly logo with gradient wings (for color contexts like onboarding). */
export function logoSvg(size: number): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="${size}" height="${size}">
  <defs>
    <linearGradient id="wg1" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#7aa2f7"/>
      <stop offset="100%" stop-color="#9ece6a"/>
    </linearGradient>
    <linearGradient id="wg2" x1="100%" y1="0%" x2="0%" y2="100%">
      <stop offset="0%" stop-color="#7aa2f7"/>
      <stop offset="100%" stop-color="#9ece6a"/>
    </linearGradient>
  </defs>
  <ellipse cx="206" cy="185" rx="72" ry="28" transform="rotate(-35 206 185)" fill="url(#wg1)" opacity="0.85"/>
  <ellipse cx="306" cy="185" rx="72" ry="28" transform="rotate(35 306 185)" fill="url(#wg2)" opacity="0.85"/>
  <ellipse cx="212" cy="235" rx="62" ry="24" transform="rotate(-25 212 235)" fill="url(#wg1)" opacity="0.6"/>
  <ellipse cx="300" cy="235" rx="62" ry="24" transform="rotate(25 300 235)" fill="url(#wg2)" opacity="0.6"/>
  <path d="M256 160 C264 170,266 200,266 220 C266 260,264 320,260 370 C259 380,253 380,252 370 C248 320,246 260,246 220 C246 200,248 170,256 160Z" fill="#c0caf5" opacity="0.9"/>
  <circle cx="256" cy="155" r="14" fill="#c0caf5" opacity="0.95"/>
  <circle cx="256" cy="210" r="8" fill="#ffffff" opacity="0.15"/>
</svg>`;
}

/** Monochrome dragonfly logo using currentColor (for sidebar/toolbar contexts). */
export function logoMonoSvg(size: number): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="${size}" height="${size}">
  <ellipse cx="206" cy="185" rx="72" ry="28" transform="rotate(-35 206 185)" fill="currentColor" opacity="0.7"/>
  <ellipse cx="306" cy="185" rx="72" ry="28" transform="rotate(35 306 185)" fill="currentColor" opacity="0.7"/>
  <ellipse cx="212" cy="235" rx="62" ry="24" transform="rotate(-25 212 235)" fill="currentColor" opacity="0.45"/>
  <ellipse cx="300" cy="235" rx="62" ry="24" transform="rotate(25 300 235)" fill="currentColor" opacity="0.45"/>
  <path d="M256 160 C264 170,266 200,266 220 C266 260,264 320,260 370 C259 380,253 380,252 370 C248 320,246 260,246 220 C246 200,248 170,256 160Z" fill="currentColor" opacity="0.9"/>
  <circle cx="256" cy="155" r="14" fill="currentColor" opacity="0.95"/>
  <circle cx="256" cy="210" r="8" fill="currentColor" opacity="0.1"/>
</svg>`;
}
