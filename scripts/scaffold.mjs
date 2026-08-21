#!/usr/bin/env node
// Generates the workspace package.json / tsconfig.json stubs for every package
// and app. Idempotent: safe to re-run. Source files are written by hand.
import { mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

/** @type {Array<{dir: string, name: string, deps?: string[], ext?: Record<string, string>}>} */
const LIBS = [
  { dir: 'packages/shared', name: 'shared', deps: ['zod'] },
  { dir: 'packages/shot-schema', name: 'shot-schema', deps: ['zod', '@masterclip/shared'] },
  { dir: 'packages/domain', name: 'domain', deps: ['zod', '@masterclip/shared', '@masterclip/shot-schema'] },
  { dir: 'packages/database', name: 'database', deps: ['@masterclip/shared', 'pg'] },
  { dir: 'packages/queue', name: 'queue', deps: ['@masterclip/shared', '@masterclip/database'] },
  { dir: 'packages/asset-storage', name: 'asset-storage', deps: ['@masterclip/shared'] },
  { dir: 'packages/auth', name: 'auth', deps: ['@masterclip/shared', '@masterclip/database'] },
  {
    dir: 'packages/provider-core',
    name: 'provider-core',
    deps: ['zod', '@masterclip/shared', '@masterclip/shot-schema'],
  },
  {
    dir: 'packages/media-tools',
    name: 'media-tools',
    deps: ['@masterclip/shared'],
  },
  {
    dir: 'packages/provider-mock',
    name: 'provider-mock',
    deps: ['@masterclip/shared', '@masterclip/provider-core', '@masterclip/media-tools'],
  },
  ...['muapi', 'google', 'fal', 'runway', 'luma', 'replicate', 'selfhosted'].map((p) => ({
    dir: `packages/provider-${p}`,
    name: `provider-${p}`,
    deps: ['@masterclip/shared', '@masterclip/provider-core'],
  })),
  {
    dir: 'packages/cost-engine',
    name: 'cost-engine',
    deps: ['@masterclip/shared', '@masterclip/database', '@masterclip/provider-core'],
  },
  {
    dir: 'packages/prompt-compiler',
    name: 'prompt-compiler',
    deps: ['@masterclip/shared', '@masterclip/shot-schema', '@masterclip/provider-core'],
  },
  {
    dir: 'packages/model-router',
    name: 'model-router',
    deps: [
      '@masterclip/shared',
      '@masterclip/shot-schema',
      '@masterclip/provider-core',
      '@masterclip/cost-engine',
    ],
  },
  {
    dir: 'packages/qc-engine',
    name: 'qc-engine',
    deps: ['@masterclip/shared', '@masterclip/shot-schema', '@masterclip/media-tools'],
  },
  {
    dir: 'packages/runtime',
    name: 'runtime',
    deps: [
      '@masterclip/shared','@masterclip/database','@masterclip/queue','@masterclip/asset-storage','@masterclip/auth',
      '@masterclip/domain','@masterclip/provider-core','@masterclip/provider-mock','@masterclip/provider-muapi',
      '@masterclip/provider-google','@masterclip/provider-fal','@masterclip/provider-runway','@masterclip/provider-luma',
      '@masterclip/provider-replicate','@masterclip/provider-selfhosted','@masterclip/cost-engine','@masterclip/model-router',
      '@masterclip/prompt-compiler','@masterclip/qc-engine','@masterclip/media-tools','@masterclip/agents',
    ],
  },
  {
    dir: 'packages/agents',
    name: 'agents',
    deps: ['@masterclip/shared', '@masterclip/shot-schema', '@masterclip/provider-core'],
  },
]

const APPS = [
  {
    dir: 'apps/api',
    name: 'api',
    scripts: { dev: 'tsx watch src/main.ts', start: 'node ../../dist/api.js' },
    deps: [
      '@fastify/cookie',
      '@fastify/multipart',
      '@fastify/static',
      'fastify',
      'zod',
      '@masterclip/shared',
      '@masterclip/domain',
      '@masterclip/database',
      '@masterclip/queue',
      '@masterclip/asset-storage',
      '@masterclip/auth',
      '@masterclip/provider-core',
      '@masterclip/cost-engine',
      '@masterclip/model-router',
      '@masterclip/prompt-compiler',
      '@masterclip/shot-schema',
      '@masterclip/agents',
      '@masterclip/media-tools',
    ],
  },
  {
    dir: 'apps/worker',
    name: 'worker',
    scripts: { dev: 'tsx watch src/main.ts', start: 'node ../../dist/worker.js' },
    deps: [
      '@masterclip/shared',
      '@masterclip/domain',
      '@masterclip/database',
      '@masterclip/queue',
      '@masterclip/asset-storage',
      '@masterclip/provider-core',
      '@masterclip/cost-engine',
      '@masterclip/qc-engine',
      '@masterclip/media-tools',
      '@masterclip/agents',
    ],
  },
  {
    dir: 'apps/cli',
    name: 'cli',
    scripts: { start: 'tsx src/main.ts' },
    bin: { masterclip: 'src/main.ts' },
    deps: [
      '@masterclip/shared',
      '@masterclip/database',
      '@masterclip/domain',
      '@masterclip/provider-core',
      '@masterclip/shot-schema',
      '@masterclip/media-tools',
    ],
  },
  {
    dir: 'apps/web',
    name: 'web',
    scripts: { dev: 'vite', build: 'vite build', preview: 'vite preview' },
    deps: ['react', 'react-dom', '@masterclip/shot-schema', '@masterclip/shared'],
  },
]

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n')
}

// Third-party dependency versions are declared once, at the workspace root, and
// hoisted (see .npmrc `node-linker=hoisted`). Package manifests therefore only
// pin their workspace-internal edges — which is what the dependency graph and
// the build order actually care about.
function depsBlock(deps = []) {
  const out = {}
  for (const d of deps.slice().sort()) {
    if (d.startsWith('@masterclip/')) out[d] = 'workspace:*'
  }
  return out
}

for (const lib of LIBS) {
  const pkgPath = join(root, lib.dir, 'package.json')
  writeJson(pkgPath, {
    name: `@masterclip/${lib.name}`,
    version: '0.1.0',
    private: true,
    type: 'module',
    main: 'src/index.ts',
    types: 'src/index.ts',
    exports: { '.': './src/index.ts' },
    dependencies: depsBlock(lib.deps),
  })
  writeJson(join(root, lib.dir, 'tsconfig.json'), {
    extends: '../../tsconfig.base.json',
    compilerOptions: { noEmit: true },
    include: ['src/**/*.ts', 'test/**/*.ts'],
  })
  mkdirSync(join(root, lib.dir, 'src'), { recursive: true })
}

for (const app of APPS) {
  writeJson(join(root, app.dir, 'package.json'), {
    name: `@masterclip/${app.name}`,
    version: '0.1.0',
    private: true,
    type: 'module',
    ...(app.bin ? { bin: app.bin } : {}),
    scripts: app.scripts ?? {},
    dependencies: depsBlock(app.deps),
  })
  const tsconfig = {
    extends: '../../tsconfig.base.json',
    compilerOptions: { noEmit: true },
    include: ['src/**/*.ts', 'test/**/*.ts'],
  }
  if (app.name === 'web') {
    tsconfig.compilerOptions = { noEmit: true, jsx: 'react-jsx', lib: ['ES2022', 'DOM', 'DOM.Iterable'] }
    tsconfig.include = ['src/**/*.ts', 'src/**/*.tsx']
  }
  writeJson(join(root, app.dir, 'tsconfig.json'), tsconfig)
  mkdirSync(join(root, app.dir, 'src'), { recursive: true })
}

const names = [...LIBS.map((l) => l.dir), ...APPS.map((a) => a.dir)]
console.log(`scaffolded ${names.length} workspace packages`)
if (!existsSync(join(root, 'pnpm-workspace.yaml'))) console.warn('warning: pnpm-workspace.yaml missing')
