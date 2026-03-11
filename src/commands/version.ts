#!/usr/bin/env tsx
/**
 * Artisan command: version
 * Usage: tsx src/commands/version.ts
 * Outputs: Jarvis v1.0.0 (abc1234)
 */

import { execSync } from 'child_process';
import { readFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '../../');

function getVersion(): string {
  // 1. Check for a VERSION file first
  const versionFile = resolve(root, 'VERSION');
  if (existsSync(versionFile)) {
    return readFileSync(versionFile, 'utf8').trim();
  }

  // 2. Fall back to package.json
  const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
  return pkg.version ?? '0.0.0';
}

function getGitHash(): string | null {
  try {
    return execSync('git rev-parse --short HEAD', { cwd: root, stdio: ['pipe', 'pipe', 'pipe'] })
      .toString()
      .trim();
  } catch {
    return null;
  }
}

const version = getVersion();
const hash = getGitHash();
const label = hash ? `Jarvis v${version} (${hash})` : `Jarvis v${version}`;

console.log(label);
