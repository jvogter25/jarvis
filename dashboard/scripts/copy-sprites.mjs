/**
 * Copies the Kenney 1-Bit sprite sheet from the repo root public/sprites/
 * into the dashboard's own public/sprites/ so Next.js can serve it statically.
 * Run automatically before dev and build via package.json scripts.
 */
import { copyFileSync, mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..', '..');
const srcDir = join(repoRoot, 'public', 'sprites');
const dstDir = join(__dirname, '..', 'public', 'sprites');

const sprites = ['tilemap_packed.png', 'tilemap_colored_packed.png', 'sample_interior.png'];

mkdirSync(dstDir, { recursive: true });

for (const file of sprites) {
  const src = join(srcDir, file);
  const dst = join(dstDir, file);
  if (existsSync(src)) {
    copyFileSync(src, dst);
    console.log(`[copy-sprites] Copied ${file}`);
  } else {
    console.warn(`[copy-sprites] Source not found: ${src}`);
  }
}
