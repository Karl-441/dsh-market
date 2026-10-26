import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * The catalog gate is a script, not a module, so these run it for real against
 * a draft file. #1012 adds `previousNpm`, and a rule that only ever runs on the
 * live catalog would stay unexercised until the first rename lands — exactly
 * when a mistake is most expensive.
 */
function runCatalog(plugins: unknown[]): { status: number; output: string } {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-validate-'))
  const file = join(dir, 'catalog.json')
  writeFileSync(file, JSON.stringify({
    updated: '2026-01-01',
    count: plugins.length,
    categories: { tool: { en: 'Tools' } },
    plugins,
  }))
  const env = { ...process.env, DSHM_REGISTRY_FILE: file }
  try {
    const output = execFileSync(process.execPath, ['scripts/validate-registry.mjs'], {
      encoding: 'utf8',
      env,
    })
    return { status: 0, output }
  } catch (error) {
    const failed = error as { status?: number; stdout?: string; stderr?: string }
    return { status: failed.status ?? 1, output: `${failed.stdout ?? ''}${failed.stderr ?? ''}` }
  }
}

const entry = (name: string, npmName: string, previousNpm?: unknown) => ({
  name,
  owner: 'o',
  url: `https://github.com/o/${name}`,
  category: 'tool',
  npm: npmName,
  ...(previousNpm === undefined ? {} : { previousNpm }),
  page: `https://awesome-dsh-plugin.com/p/${name}/`,
  description: { en: name, zh: name },
  stars: 0,
  install: `dsh plugin --profile web add ${npmName}`,
  added: '2026-01-01',
})

describe('validate-registry previousNpm (#1012 P1)', () => {
  it('accepts a renamed entry whose former name is gone from npm', () => {
    const run = runCatalog([entry('renamed', 'renamed-new', ['renamed-old'])])
    expect(run.status, run.output).toBe(0)
    expect(run.output).toContain('registry ok')
  })

  it('refuses a former name that is still a live package in the catalog', () => {
    const run = runCatalog([entry('old', 'renamed-old'), entry('renamed', 'renamed-new', ['renamed-old'])])
    expect(run.status).toBe(1)
    expect(run.output).toContain('[E13] renamed: previousNpm "renamed-old" is still a live package name')
  })

  it('refuses one former name claimed by two successors', () => {
    const run = runCatalog([
      entry('renamed-a', 'renamed-a-new', ['renamed-old']),
      entry('renamed-b', 'renamed-b-new', ['renamed-old']),
    ])
    expect(run.status).toBe(1)
    expect(run.output).toContain('[E13] renamed-b: previousNpm "renamed-old" is already declared by "renamed-a"')
  })

  it('refuses malformed and empty declarations instead of ignoring them', () => {
    const run = runCatalog([
      entry('empty', 'empty-new', []),
      entry('not-a-list', 'list-new', 'renamed-old'),
      entry('bad-name', 'bad-new', ['Not A Name']),
    ])
    expect(run.status).toBe(1)
    expect(run.output).toContain('[E13] empty: previousNpm must be a non-empty array')
    expect(run.output).toContain('[E13] not-a-list: previousNpm must be a non-empty array')
    expect(run.output).toContain('[E13] bad-name: previousNpm entry "Not A Name" is not a valid npm package name')
  })

  it('refuses a former name that differs only in case', () => {
    const run = runCatalog([entry('renamed', 'renamed-new', ['Renamed-Old'])])
    expect(run.status).toBe(1)
    expect(run.output).toContain('[E13] renamed: previousNpm entry "Renamed-Old" must be lowercase')
  })

  it('refuses a miscased field name instead of ignoring the declaration', () => {
    // The runtime reads the exact key, so `PreviousNpm` would validate as an
    // unknown-but-harmless property and the rename would silently never appear.
    const run = runCatalog([{ ...entry('renamed', 'renamed-new'), PreviousNpm: ['renamed-old'] }])
    expect(run.status).toBe(1)
    expect(run.output).toContain('[E13] renamed: key "PreviousNpm" is not the rename field')
  })
})


