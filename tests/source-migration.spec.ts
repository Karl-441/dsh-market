import { describe, expect, it } from 'vitest'
          import { findGitToNpmMigration, findNpmTargetEntry } from '../src/source-migration.ts'

          const plugins = [
            { name: 'dsh-genui', url: 'https://github.com/omdsh-dev/dsh-genui', npm: '@changfenhuang/dsh-genui' },
            { name: 'mono#a', url: 'https://github.com/o/mono/tree/main/packages/a', npm: '@o/a' },
            { name: 'mono#b', url: 'https://github.com/o/mono/tree/main/packages/b', npm: '@o/b' },
          ]

          describe('findGitToNpmMigration', () => {
            it('matches only the exact verified repository identity', () => {
              expect(findGitToNpmMigration(plugins, 'github:omdsh-dev/dsh-genui')).toEqual({
                kind: 'git-to-npm',
                repo: 'omdsh-dev/dsh-genui',
                target: '@changfenhuang/dsh-genui',
              })
              expect(findGitToNpmMigration(plugins, 'github:someone-else/dsh-genui')).toBeNull()
            })

            it('keeps explicit branch, tag, commit and semver selections on Git', () => {
              expect(findGitToNpmMigration(plugins, 'github:omdsh-dev/dsh-genui#publish')).toBeNull()
              expect(findGitToNpmMigration(plugins, 'github:omdsh-dev/dsh-genui#v1.0.0')).toBeNull()
              expect(findGitToNpmMigration(plugins, `github:omdsh-dev/dsh-genui#${'a'.repeat(40)}`)).toBeNull()
              expect(findGitToNpmMigration(plugins, 'github:omdsh-dev/dsh-genui#semver:^1.0.0')).toBeNull()
            })

            it('requires exact monorepo path identity', () => {
              expect(findGitToNpmMigration(plugins, 'github:o/mono')).toBeNull()
              expect(findGitToNpmMigration(plugins, 'github:o/mono#path:/packages/a')).toEqual({
                kind: 'git-to-npm',
                repo: 'o/mono#path:/packages/a',
                target: '@o/a',
              })
              expect(findGitToNpmMigration(plugins, 'github:o/mono#path:/packages/missing')).toBeNull()
            })

            it('fails closed when one identity maps to multiple verified npm entries', () => {
              const ambiguous = [
                ...plugins,
                { name: 'duplicate', url: 'https://github.com/omdsh-dev/dsh-genui', npm: '@other/dsh-genui' },
              ]
              expect(findGitToNpmMigration(ambiguous, 'github:omdsh-dev/dsh-genui')).toBeNull()
            })
          })

          /**
           * #1012. The rename target is reported by an update failure, but the
           * route body is user-reachable, so the entry that publishes it must
           * exist in the catalog before a profile is pointed at it.
           */
          describe('findNpmTargetEntry', () => {
            it('returns the single catalog entry that publishes the name on npm', () => {
              expect(findNpmTargetEntry(plugins, '@o/a')?.name).toBe('mono#a')
              expect(findNpmTargetEntry(plugins, '@changfenhuang/dsh-genui')?.name).toBe('dsh-genui')
            })

            it('does not pick a target the catalog never published on npm', () => {
              expect(findNpmTargetEntry(plugins, 'dsh-evo-subagent')).toBeNull()
              expect(findNpmTargetEntry(plugins, '@nobody/missing')).toBeNull()
              expect(findNpmTargetEntry([{ name: 'git-only', url: 'https://github.com/o/x' }], '@o/x')).toBeNull()
            })

            it('fails closed when two entries claim one npm name', () => {
              const duplicates = [
                ...plugins,
                { name: 'other', url: 'https://github.com/o/other', npm: '@o/a' },
              ]
              expect(findNpmTargetEntry(duplicates, '@o/a')).toBeNull()
            })

            it('ignores entries whose npm field is not a package name', () => {
              expect(findNpmTargetEntry([{ name: 'x', npm: 'not a name' }], 'not a name')).toBeNull()
            })
          })
