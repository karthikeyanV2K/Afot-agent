/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

const rootDir = process.cwd();
const cliDir = path.resolve(rootDir, 'packages/cli');
const cliPkgPath = path.resolve(cliDir, 'package.json');
const cliPkgBakPath = path.resolve(cliDir, 'package.json.bak');

if (process.argv.includes('--restore')) {
  console.log('--- Restoring packages/cli/package.json ---');
  if (fs.existsSync(cliPkgBakPath)) {
    fs.copyFileSync(cliPkgBakPath, cliPkgPath);
    fs.rmSync(cliPkgBakPath);
  }
  const destBundleDir = path.resolve(cliDir, 'bundle');
  if (fs.existsSync(destBundleDir)) {
    fs.rmSync(destBundleDir, { recursive: true, force: true });
  }
  const cliReadme = path.resolve(cliDir, 'README.md');
  if (fs.existsSync(cliReadme)) fs.rmSync(cliReadme);
  const cliLicense = path.resolve(cliDir, 'LICENSE');
  if (fs.existsSync(cliLicense)) fs.rmSync(cliLicense);
  console.log('Restored packages/cli successfully.');
  process.exit(0);
}

console.log('--- 1. Ensuring fresh clean bundle ---');
const sourceBundleDir = path.resolve(rootDir, 'bundle');
if (fs.existsSync(sourceBundleDir)) {
  fs.rmSync(sourceBundleDir, { recursive: true, force: true });
}
execSync('npm run bundle', { stdio: 'inherit', cwd: rootDir });

console.log('--- 2. Backing up packages/cli/package.json ---');
fs.copyFileSync(cliPkgPath, cliPkgBakPath);

try {
  console.log('--- 3. Preparing packages/cli for release ---');
  const sourceBundleDir = path.resolve(rootDir, 'bundle');
  const destBundleDir = path.resolve(cliDir, 'bundle');
  if (fs.existsSync(sourceBundleDir)) {
    fs.rmSync(destBundleDir, { recursive: true, force: true });
    fs.cpSync(sourceBundleDir, destBundleDir, { recursive: true });
  }

  fs.copyFileSync(path.resolve(rootDir, 'README.md'), path.resolve(cliDir, 'README.md'));
  fs.copyFileSync(path.resolve(rootDir, 'LICENSE'), path.resolve(cliDir, 'LICENSE'));

  const rootPkg = JSON.parse(fs.readFileSync(path.resolve(rootDir, 'package.json'), 'utf-8'));
  const optionalDependencies = { ...(rootPkg.optionalDependencies || {}) };
  delete optionalDependencies['gemini-cli-devtools'];

  const cliPkg = JSON.parse(fs.readFileSync(cliPkgPath, 'utf-8'));
  cliPkg.name = 'afot-cli';
  cliPkg.version = '1.1.0';
  cliPkg.description = 'AFOT CLI (All For One Tech) - Terminal-first autonomous AI coding agent with multi-provider support, interactive diffs, and instant undo.';
  cliPkg.files = ['bundle/', 'README.md', 'LICENSE'];
  cliPkg.bin = {
    afot: 'bundle/gemini.js',
  };
  cliPkg.repository = {
    type: 'git',
    url: 'git+https://github.com/karthikeyanV2K/Afot-agent.git',
  };
  cliPkg.homepage = 'https://github.com/karthikeyanV2K/Afot-agent#readme';
  cliPkg.bugs = {
    url: 'https://github.com/karthikeyanV2K/Afot-agent/issues',
  };
  cliPkg.author = 'All For One Tech';
  cliPkg.license = 'Apache-2.0';
  cliPkg.keywords = [
    'afot',
    'all-for-one-tech',
    'ai',
    'agent',
    'coding-agent',
    'terminal',
    'cli',
    'opencode',
    'nvidia',
    'deepseek',
    'gemini'
  ];

  delete cliPkg.dependencies;
  delete cliPkg.devDependencies;
  delete cliPkg.scripts;
  delete cliPkg.main;
  delete cliPkg.config;
  cliPkg.optionalDependencies = optionalDependencies;

  fs.writeFileSync(cliPkgPath, JSON.stringify(cliPkg, null, 2));

  console.log('--- 4. Testing package with npm pack --dry-run ---');
  execSync('npm pack --dry-run', { stdio: 'inherit', cwd: cliDir });

  const isPrepareOnly = process.argv.includes('--prepare');
  if (isPrepareOnly) {
    console.log('\nPackage prepared in packages/cli! You can now run:');
    console.log('  cd packages/cli');
    console.log('  npm publish --access public');
    console.log('And enter your 2FA OTP code directly when prompted.\n');
  } else if (process.argv.includes('--publish')) {
    console.log('--- 5. Publishing to npm registry ---');
    const tokenArg = process.argv.find((arg) => arg.startsWith('--token='));
    const token = tokenArg ? tokenArg.split('=')[1] : process.env.NPM_TOKEN;
    const cliNpmrc = path.resolve(cliDir, '.npmrc');

    if (token) {
      console.log('Using configured npm auth token...');
      fs.writeFileSync(cliNpmrc, `//registry.npmjs.org/:_authToken=${token.trim()}\n`);
    }

    const tokenFlag = token ? ` --//registry.npmjs.org/:_authToken="${token.trim()}"` : '';
    const otpArg = process.argv.find((arg) => arg.startsWith('--otp='));
    const otpFlag = otpArg ? ` ${otpArg}` : '';
    try {
      execSync(`npm publish --access public${tokenFlag}${otpFlag}`, { stdio: 'inherit', cwd: cliDir });
      console.log('🎉 Successfully published afot-cli to npm registry!');
      console.log('Updating dist-tag latest to 1.1.0...');
      execSync(`npm dist-tag add afot-cli@1.1.0 latest${tokenFlag}`, { stdio: 'inherit', cwd: cliDir });
      console.log('Dist-tag latest updated to 1.1.0.');
    } finally {
      if (fs.existsSync(cliNpmrc)) {
        fs.rmSync(cliNpmrc, { force: true });
      }
    }
  } else {
    console.log('\nDry run complete! Run with --publish to publish live to npm.');
  }
} finally {
  const isPrepareOnly = process.argv.includes('--prepare');
  if (!isPrepareOnly) {
    console.log('--- Restoring packages/cli/package.json ---');
    if (fs.existsSync(cliPkgBakPath)) {
      fs.copyFileSync(cliPkgBakPath, cliPkgPath);
      fs.rmSync(cliPkgBakPath);
    }
    const destBundleDir = path.resolve(cliDir, 'bundle');
    if (fs.existsSync(destBundleDir)) {
      fs.rmSync(destBundleDir, { recursive: true, force: true });
    }
    const cliReadme = path.resolve(cliDir, 'README.md');
    if (fs.existsSync(cliReadme)) fs.rmSync(cliReadme);
    const cliLicense = path.resolve(cliDir, 'LICENSE');
    if (fs.existsSync(cliLicense)) fs.rmSync(cliLicense);
  }
}
