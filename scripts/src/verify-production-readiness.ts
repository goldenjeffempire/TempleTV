#!/usr/bin/env tsx
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..', '..');
const failures: string[] = [];

type Workspace = {
  name: string;
  packageJson: string;
  webManifest?: string;
  robotsTxt?: string;
  mainEntrypoint: string;
};

const workspaces: Workspace[] = [
  {
    name: 'admin',
    packageJson: 'artifacts/admin/package.json',
    mainEntrypoint: 'artifacts/admin/src/main.tsx',
  },
  {
    name: 'tv',
    packageJson: 'artifacts/tv/package.json',
    webManifest: 'artifacts/tv/public/manifest.webmanifest',
    robotsTxt: 'artifacts/tv/public/robots.txt',
    mainEntrypoint: 'artifacts/tv/src/main.tsx',
  },
  {
    name: 'mobile',
    packageJson: 'artifacts/mobile/package.json',
    mainEntrypoint: 'artifacts/mobile/index.ts',
  },
];

const requiredRootFiles = ['render.yaml', 'docker-compose.yml', 'RELEASE_AUDIT.md'];
for (const rel of requiredRootFiles) if (!existsSync(join(ROOT, rel))) failures.push(`missing required file: ${rel}`);

function parseJson<T = unknown>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    failures.push(`invalid json: ${path}`);
    return null;
  }
}

for (const ws of workspaces) {
  const pkgPath = join(ROOT, ws.packageJson);
  if (!existsSync(pkgPath)) {
    failures.push(`missing ${ws.name} package.json: ${ws.packageJson}`);
    continue;
  }

  const pkg = parseJson<{ scripts?: Record<string, string>; devDependencies?: Record<string, string>; dependencies?: Record<string, string> }>(pkgPath);
  if (!pkg) continue;

  const scripts = pkg.scripts ?? {};
  if (!scripts.typecheck) failures.push(`${ws.name} missing typecheck script`);
  if (!scripts.build) failures.push(`${ws.name} missing build script`);

  if (!existsSync(join(ROOT, ws.mainEntrypoint))) {
    failures.push(`${ws.name} missing entrypoint: ${ws.mainEntrypoint}`);
  }

  if (ws.webManifest && !existsSync(join(ROOT, ws.webManifest))) {
    failures.push(`${ws.name} missing web manifest: ${ws.webManifest}`);
  }
  if (ws.robotsTxt && !existsSync(join(ROOT, ws.robotsTxt))) {
    failures.push(`${ws.name} missing robots.txt: ${ws.robotsTxt}`);
  }

  const allDeps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
  if (!allDeps['@tanstack/react-query'] && ws.name !== 'mobile') {
    failures.push(`${ws.name} missing @tanstack/react-query for resilient API state/cache`);
  }
}

const render = readFileSync(join(ROOT, 'render.yaml'), 'utf8');
if (!/healthCheckPath:\s*\/api\/healthz/.test(render)) failures.push('api health check path missing or incorrect');
if (!/MALLOC_ARENA_MAX/.test(render)) failures.push('MALLOC_ARENA_MAX memory hardening env var missing');
if (!/NODE_OPTIONS/.test(render)) failures.push('NODE_OPTIONS runtime hardening env var missing');
if (!/fromGroup:\s*temple-tv-shared-secrets/.test(render)) failures.push('shared secrets env group not wired');
if (!/fromGroup:\s*temple-tv-aws/.test(render)) failures.push('AWS env group not wired');

const compose = readFileSync(join(ROOT, 'docker-compose.yml'), 'utf8');
if (!/restart:\s*unless-stopped|restart:\s*always/.test(compose)) failures.push('docker-compose services do not declare restart policy');

if (failures.length > 0) {
  console.error('[verify:production-readiness] FAIL');
  failures.forEach((f) => console.error(` - ${f}`));
  process.exit(1);
}

console.log('[verify:production-readiness] PASS — frontend + backend production guardrails are present.');
=======
const requiredFiles = [
  'render.yaml',
  'docker-compose.yml',
  'RELEASE_AUDIT.md',
  'docs/oom-diagnosis-2026-04-28.md',
];

const failures: string[] = [];

for (const rel of requiredFiles) {
  if (!existsSync(join(ROOT, rel))) failures.push(`missing required file: ${rel}`);
}

const renderYamlPath = join(ROOT, 'render.yaml');
if (existsSync(renderYamlPath)) {
  const render = readFileSync(renderYamlPath, 'utf8');
  const checks: Array<[RegExp, string]> = [
    [/healthCheckPath:\s*\/api\/healthz/, 'api health check path missing or incorrect'],
    [/MALLOC_ARENA_MAX/, 'MALLOC_ARENA_MAX memory hardening env var missing'],
    [/NODE_OPTIONS/, 'NODE_OPTIONS runtime hardening env var missing'],
    [/fromGroup:\s*temple-tv-shared-secrets/, 'shared secrets env group not wired'],
    [/fromGroup:\s*temple-tv-aws/, 'AWS env group not wired'],
    [/pullRequestPreviewsEnabled:\s*false/, 'PR preview isolation guardrail not configured'],
  ];
  for (const [pattern, message] of checks) {
    if (!pattern.test(render)) failures.push(message);
  }
}

const composePath = join(ROOT, 'docker-compose.yml');
if (existsSync(composePath)) {
  const compose = readFileSync(composePath, 'utf8');
  if (!/restart:\s*unless-stopped|restart:\s*always/.test(compose)) {
    failures.push('docker-compose services do not declare restart policy');
  }
}

if (failures.length > 0) {
  console.error('[verify:production-readiness] FAIL');
  for (const failure of failures) console.error(` - ${failure}`);
  process.exit(1);
}

console.log('[verify:production-readiness] PASS — baseline production controls present.');