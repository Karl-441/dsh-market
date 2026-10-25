/**
 * Safe discovery for legacy Git -> verified npm source migrations (#461).
 *
 * This intentionally does less than the normal catalog matcher. A migration
 * changes package name/publisher and build provenance, so only repository
 * evidence carried by the installed Git spec may authorize it:
 *
 * - bare github:owner/repo matches only the catalog root for that repo;
 * - #path:/subdir matches only that exact catalog subpath;
 * - branch/tag/commit/semver selectors are not migrated in v1;
 * - more than one matching verified npm entry is ambiguous and fails closed.
 */
import { NPM_NAME_RE, parseSourceUrl, repoOfTarget } from './sources.ts'

export interface GitToNpmMigration {
  kind: 'git-to-npm'
  /** Normalized owner/repo or owner/repo#path:/subdir identity. */
  repo: string
  /** Verified npm package declared by the same catalog entry. */
  target: string
}

/**
 * The other direction: an npm install whose package was renamed (#1012).
 *
 * Unlike the Git case there is no local evidence to discover the target from —
 * the old spec names only the old package, and the registry answers 404 for
 * it. The fact has to come from the update failure that noticed it, and the
 * transaction below is shared instead of duplicated.
 */
export interface NpmRenameMigration {
  kind: 'npm-rename'
  /** npm package name the profile currently depends on. */
  from: string
  /** Catalog npm package name the install is offered as a target. */
  target: string
}

function migratableGitIdentity(spec: string): string | null {
  if (!spec.startsWith('github:')) return null
  const hash = spec.indexOf('#')
  if (hash !== -1) {
    const selector = spec.slice(hash + 1)
    // A path selector identifies which package inside a monorepo. Any
    // other selector expresses an explicit version/ref choice and is
    // deliberately preserved rather than silently discarded.
    if (!selector.startsWith('path:/') || selector.includes('&')) return null
  }
  return repoOfTarget(spec)
}

export function findGitToNpmMigration<T extends { url: string; npm?: unknown }>(
  plugins: readonly T[],
  spec: string,
): GitToNpmMigration | null {
  const identity = migratableGitIdentity(spec)
  if (identity === null) return null
  const pathAt = identity.indexOf('#path:/')
  const wantedRepo = pathAt === -1 ? identity : identity.slice(0, pathAt)
  const wantedPath = pathAt === -1 ? null : identity.slice(pathAt + '#path:/'.length)

  const candidates = plugins.flatMap((plugin) => {
    if (typeof plugin.npm !== 'string' || !NPM_NAME_RE.test(plugin.npm)) return []
    const source = parseSourceUrl(plugin.url)
    if (source === null || source.repo.toLowerCase() !== wantedRepo) return []
    if (wantedPath === null) {
      // A collection root must not guess which /tree/ child was meant.
      if (source.subpath !== null) return []
    } else if (source.subpath?.toLowerCase() !== wantedPath) {
      return []
    }
    return [plugin.npm]
  })

  if (candidates.length !== 1) return null
  return { kind: 'git-to-npm', repo: identity, target: candidates[0]! }
}

/**
 * The catalog entry that publishes `to` on npm, or null when no single entry
 * does.
 *
 * The rename target arrives from an update failure's own artifact, but the
 * `migrate-source` body is user-reachable all the same: this keeps the route
 * from pointing a profile at a package name the catalog does not publish on
 * npm. Two entries claiming one npm name is ambiguous and fails closed, the
 * same rule {@link findGitToNpmMigration} follows.
 */
export function findNpmTargetEntry<T extends { name: string; npm?: unknown }>(
  plugins: readonly T[],
  to: string,
): T | null {
  // Compare against the install target, not the display name: that is what the
  // route is about to `add`, and it is what the catalog rules (E10/E11) keep
  // unique. A listing whose npm target is another package cannot satisfy a
  // rename to its display name.
  const matches = plugins.filter(plugin => {
    const target = typeof plugin.npm === 'string' ? plugin.npm : plugin.name
    return NPM_NAME_RE.test(target) && target === to
  })
  return matches.length === 1 ? matches[0]! : null
}
