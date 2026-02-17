#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execSync } = require('child_process');

const distDir = path.join(__dirname, '..', 'dist');

if (!fs.existsSync(distDir)) {
  console.error(`Error: dist/ directory does not exist at ${distDir}`);
  console.error('Run "tsc" first to compile TypeScript.');
  process.exit(1);
}

// Hash all files in dist/ (excluding version.json itself)
function hashDistDir(dir) {
  const hash = crypto.createHash('sha256');
  const files = [];

  function walk(d) {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const fullPath = path.join(d, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.name !== 'version.json') {
        files.push(fullPath);
      }
    }
  }

  walk(dir);
  files.sort(); // Deterministic ordering

  for (const file of files) {
    hash.update(fs.readFileSync(file));
  }

  return hash.digest('hex').slice(0, 12);
}

// Get git commit
let gitCommit = 'unknown';
try {
  gitCommit = execSync('git rev-parse --short HEAD', { encoding: 'utf-8' }).trim();
} catch {
  // Not in a git repo or git not available
}

const version = {
  buildHash: hashDistDir(distDir),
  builtAt: new Date().toISOString(),
  gitCommit,
};

const outputPath = path.join(distDir, 'version.json');
fs.writeFileSync(outputPath, JSON.stringify(version, null, 2) + '\n');
console.log(`Wrote ${outputPath}:`, version);
