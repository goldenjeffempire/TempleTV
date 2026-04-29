#!/usr/bin/env tsx
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..', '..');
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
