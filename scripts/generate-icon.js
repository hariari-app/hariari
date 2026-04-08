/**
 * Generate Hariari vector icon — abstract geometric dragonfly.
 * Clean SVG with proper vector paths, rendered to PNG at all sizes.
 * Run: node scripts/generate-icon.js
 */
const sharp = require('sharp');
const fs = require('fs');
const path = require('path');

// Design tokens
const BG_COLOR = '#1a1b26';
const CORNER_RADIUS = 80;
const VIEWBOX = 512;

/**
 * Build Option A: Gradient version (blue-to-green wings)
 */
function buildGradientSvg() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${VIEWBOX} ${VIEWBOX}">
  <defs>
    <linearGradient id="wingGrad" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#7aa2f7"/>
      <stop offset="100%" stop-color="#9ece6a"/>
    </linearGradient>
    <linearGradient id="wingGrad2" x1="100%" y1="0%" x2="0%" y2="100%">
      <stop offset="0%" stop-color="#7aa2f7"/>
      <stop offset="100%" stop-color="#9ece6a"/>
    </linearGradient>
  </defs>

  <!-- Background rounded square -->
  <rect width="${VIEWBOX}" height="${VIEWBOX}" rx="${CORNER_RADIUS}" fill="${BG_COLOR}"/>

  <!-- Dragonfly: abstract geometric design -->
  <!-- Centered at (256, 240), body runs vertical -->

  <!-- Upper-left wing -->
  <ellipse cx="206" cy="185" rx="72" ry="28"
    transform="rotate(-35 206 185)"
    fill="url(#wingGrad)" opacity="0.85"/>

  <!-- Upper-right wing -->
  <ellipse cx="306" cy="185" rx="72" ry="28"
    transform="rotate(35 306 185)"
    fill="url(#wingGrad2)" opacity="0.85"/>

  <!-- Lower-left wing -->
  <ellipse cx="212" cy="235" rx="62" ry="24"
    transform="rotate(-25 212 235)"
    fill="url(#wingGrad)" opacity="0.6"/>

  <!-- Lower-right wing -->
  <ellipse cx="300" cy="235" rx="62" ry="24"
    transform="rotate(25 300 235)"
    fill="url(#wingGrad2)" opacity="0.6"/>

  <!-- Body: tapered vertical shape -->
  <path d="
    M 256 160
    C 264 170, 266 200, 266 220
    C 266 260, 264 320, 260 370
    C 259 380, 253 380, 252 370
    C 248 320, 246 260, 246 220
    C 246 200, 248 170, 256 160
    Z"
    fill="#c0caf5" opacity="0.9"/>

  <!-- Head: small circle -->
  <circle cx="256" cy="155" r="14" fill="#c0caf5" opacity="0.95"/>

  <!-- Wing overlap highlight (center thorax glow) -->
  <circle cx="256" cy="210" r="8" fill="#ffffff" opacity="0.15"/>
</svg>`;
}

/**
 * Build Option B: Monochrome silver/white version
 */
function buildMonochromeSvg() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${VIEWBOX} ${VIEWBOX}">
  <defs>
    <linearGradient id="bodyGrad" x1="50%" y1="0%" x2="50%" y2="100%">
      <stop offset="0%" stop-color="#c0caf5"/>
      <stop offset="100%" stop-color="#7a85a8"/>
    </linearGradient>
  </defs>

  <!-- Background rounded square -->
  <rect width="${VIEWBOX}" height="${VIEWBOX}" rx="${CORNER_RADIUS}" fill="${BG_COLOR}"/>

  <!-- Upper-left wing -->
  <ellipse cx="206" cy="185" rx="72" ry="28"
    transform="rotate(-35 206 185)"
    fill="#c0caf5" opacity="0.7"/>

  <!-- Upper-right wing -->
  <ellipse cx="306" cy="185" rx="72" ry="28"
    transform="rotate(35 306 185)"
    fill="#c0caf5" opacity="0.7"/>

  <!-- Lower-left wing -->
  <ellipse cx="212" cy="235" rx="62" ry="24"
    transform="rotate(-25 212 235)"
    fill="#c0caf5" opacity="0.45"/>

  <!-- Lower-right wing -->
  <ellipse cx="300" cy="235" rx="62" ry="24"
    transform="rotate(25 300 235)"
    fill="#c0caf5" opacity="0.45"/>

  <!-- Body -->
  <path d="
    M 256 160
    C 264 170, 266 200, 266 220
    C 266 260, 264 320, 260 370
    C 259 380, 253 380, 252 370
    C 248 320, 246 260, 246 220
    C 246 200, 248 170, 256 160
    Z"
    fill="url(#bodyGrad)" opacity="0.9"/>

  <!-- Head -->
  <circle cx="256" cy="155" r="14" fill="#c0caf5" opacity="0.95"/>

  <!-- Wing overlap highlight -->
  <circle cx="256" cy="210" r="8" fill="#ffffff" opacity="0.1"/>
</svg>`;
}

const OUTPUT_SIZES = [16, 32, 48, 64, 128, 256, 512, 1024];

async function main() {
  const iconsDir = path.join(__dirname, '..', 'resources', 'icons');
  const resourcesDir = path.join(__dirname, '..', 'resources');

  // Clean existing icons
  if (fs.existsSync(iconsDir)) {
    const existing = fs.readdirSync(iconsDir);
    for (const file of existing) {
      fs.unlinkSync(path.join(iconsDir, file));
    }
  }
  fs.mkdirSync(iconsDir, { recursive: true });

  // Generate gradient version (primary)
  const gradientSvg = buildGradientSvg();
  fs.writeFileSync(path.join(iconsDir, 'icon.svg'), gradientSvg);
  console.log('Created icon.svg (gradient)');

  // Also save monochrome variant
  const monoSvg = buildMonochromeSvg();
  fs.writeFileSync(path.join(iconsDir, 'icon-mono.svg'), monoSvg);
  console.log('Created icon-mono.svg (monochrome)');

  // Render gradient SVG to all PNG sizes (lanczos for smooth anti-aliasing)
  const svgBuffer = Buffer.from(gradientSvg);
  for (const size of OUTPUT_SIZES) {
    const outPath = path.join(iconsDir, `${size}x${size}.png`);
    await sharp(svgBuffer)
      .resize(size, size)
      .png()
      .toFile(outPath);

    const stat = fs.statSync(outPath);
    console.log(`Created ${size}x${size}.png (${stat.size} bytes)`);
  }

  // Copy 512x512 to resources/icon.png
  const src512 = path.join(iconsDir, '512x512.png');
  const destIcon = path.join(resourcesDir, 'icon.png');
  fs.copyFileSync(src512, destIcon);
  console.log('Copied 512x512.png -> resources/icon.png');

  console.log('\nDone! All icons generated.');
  console.log('Gradient version: resources/icons/icon.svg');
  console.log('Monochrome version: resources/icons/icon-mono.svg');
}

main().catch((err) => {
  console.error('Error generating icons:', err);
  process.exit(1);
});
