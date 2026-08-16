// @vitest-environment jsdom
/**
 * Layer-2 component specs (harness convention: jsdom pragma +
 * testing-library against the REAL component with the REAL locale dicts and
 * the REAL ui-primitives package). The host boundary is the four fetch
 * endpoints, stubbed with fixture payloads.
 */

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MarketSection } from '../../src/client/MarketSection.tsx'
import { en } from '../../src/client/locales.ts'

const REGISTRY = {
  updated: '', count: 4,
  categories: { tools: { en: 'Tools', zh: '工具' }, theme: { en: 'Themes', zh: '主题' } },
  plugins: [
    { name: 'dsh-loop', owner: 'alice', url: 'https://github.com/alice/dsh-loop', category: 'tools', npm: 'dsh-loop', stars: 50, added: '2026-08-01', description: { en: 'Loop task runner', zh: '循环执行' }, install: '' },
    { name: 'dsh-notify', owner: 'bob', url: 'https://github.com/bob/dsh-notify', category: 'tools', npm: null, stars: 120, added: '2026-08-10', description: { en: 'Desktop notifications', zh: '桌面通知' }, install: '' },
    { name: 'whale-skin', owner: 'carol', url: 'https://github.com/carol/whale-skin', category: 'theme', npm: null, stars: 80, added: '2026-08-14', description: { en: 'Whale theme', zh: '鲸鱼主题' }, install: '' },
  ],
}

/** Every fetch the component made, for asserting request payloads. */
let fetchCalls: Array<{ path: string; method: string; body: unknown }> = []

function stubFetch(overrides: Record<string, unknown> = {}): void {
  fetchCalls = []
  vi.stubGlobal('fetch', (input: unknown, init?: RequestInit) => {
    const path = String(input).split('?')[0]
    const method = (init?.method ?? 'GET').toUpperCase()
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    fetchCalls.push({ path, method, body })
    const payload =
      path === '/dsh-market/registry' ? { source: 'snapshot', registry: REGISTRY }
      : path === '/dsh-market/installed' ? { profile: 'web', installed: {}, live: [], disabled: [], groups: {}, groupOrder: [] }
      : path === '/dsh-market/status' ? { active: false, pnpm: true, boot: 'boot-1', restart: true, installed: {} }
      : path === '/dsh-market/updates' ? { updates: {} }
      : path === '/dsh-market/toggle' ? { ok: true, disabled: [], live: [], activation: {} }
      : path === '/dsh-market/groups' ? { ok: true, groups: {}, groupOrder: [], disabled: [] }
      : null
    const merged = overrides[path] ?? payload
    if (merged === null) return Promise.reject(new Error(`unstubbed fetch: ${String(input)}`))
    const result = typeof merged === 'function' ? (merged as (requestBody?: unknown) => unknown)(body) : merged
    return Promise.resolve(new Response(JSON.stringify(result), { status: 200 }))
  })
}

// Snapshot objects must be referentially stable — useSyncExternalStore
// treats a fresh object per call as an endless change feed.
const LOCALE_SNAPSHOT = { active: 'en' }

function props() {
  return {
    t: (key: string) => (en as Record<string, string>)[key] ?? key,
    locale: { subscribe: () => () => {}, getSnapshot: () => LOCALE_SNAPSHOT },
    theme: { setTheme: () => {} },
    themeStore: { subscribe: () => () => {}, getSnapshot: () => null },
  }
}

beforeEach(() => stubFetch())
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  sessionStorage.clear()
})

describe('MarketSection (jsdom)', () => {
  it('renders the catalog with install buttons once the registry loads', async () => {
    render(<MarketSection {...props()} />)
    expect(await screen.findByText('dsh-loop')).toBeTruthy()
    expect(screen.getByText('dsh-notify')).toBeTruthy()
    // Theme entries carry an Install button too (discover tab shows all).
    expect(screen.getAllByRole('button', { name: en.install }).length).toBeGreaterThanOrEqual(3)
  })

  it('search narrows the grid to matching plugins', async () => {
    render(<MarketSection {...props()} />)
    await screen.findByText('dsh-loop')
    fireEvent.change(screen.getByPlaceholderText(en.searchPh), { target: { value: 'notify' } })
    await waitFor(() => {
      expect(screen.queryByText('dsh-loop')).toBeNull()
      expect(screen.getByText('dsh-notify')).toBeTruthy()
    })
  })

  it('category pills filter and the filter panel sorts by field + direction', async () => {
    render(<MarketSection {...props()} />)
    await screen.findByText('dsh-loop')
    fireEvent.click(screen.getByRole('button', { name: 'Themes' }))
    await waitFor(() => {
      expect(screen.queryByText('dsh-loop')).toBeNull()
      expect(screen.getByText('whale-skin')).toBeTruthy()
    })
    fireEvent.click(screen.getByRole('button', { name: 'All' }))

    // Default field is Stars → direction labels are Ascending/Descending.
    fireEvent.click(screen.getByRole('button', { name: en.filter }))
    expect(screen.getByRole('radio', { name: en.sortDesc })).toBeTruthy()
    expect(screen.getByRole('radio', { name: en.sortAsc })).toBeTruthy()

    // Field = Release date → direction labels switch to Newest/Oldest; the
    // already-selected desc means newest first.
    fireEvent.click(screen.getByRole('radio', { name: en.sortAdded }))
    await waitFor(() => {
      const names = screen.getAllByText(/^(dsh-loop|dsh-notify|whale-skin)$/).map(n => n.textContent)
      expect(names[0]).toBe('whale-skin') // newest first
    })
    fireEvent.click(screen.getByRole('radio', { name: en.sortOldest }))
    await waitFor(() => {
      const names = screen.getAllByText(/^(dsh-loop|dsh-notify|whale-skin)$/).map(n => n.textContent)
      expect(names[0]).toBe('dsh-loop') // oldest first
    })
  })

  it('the install dialog opens with Confirm/Cancel and closes on cancel', async () => {
    render(<MarketSection {...props()} />)
    await screen.findByText('dsh-loop')
    fireEvent.click(screen.getAllByRole('button', { name: en.install })[0])
    expect(await screen.findByRole('button', { name: en.confirm })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: en.cancel }))
    await waitFor(() => expect(screen.queryByRole('button', { name: en.confirm })).toBeNull())
  })

  it('a stale update response arms the Update-now button (#22 flow)', async () => {
    stubFetch({
      '/dsh-market/installed': { profile: 'web', installed: { 'dsh-loop': '^1.0.0' }, live: [] },
      '/dsh-market/updates': { updates: { 'dsh-loop': { kind: 'npm', version: '1.0.0', current: '1.0.0', latest: '1.2.0', updateAvailable: true } } },
      '/dsh-market/update': { ok: false, stale: true, error: 'too fresh — wait or update now' },
    })
    render(<MarketSection {...props()} />)
    await screen.findByText('dsh-loop')
    fireEvent.click(screen.getByRole('button', { name: /Installed/ }))
    const updateButton = await screen.findByRole('button', { name: en.update })
    fireEvent.click(updateButton)
    // The 502-stale path surfaces the plain-words error plus the one-time bypass.
    expect(await screen.findByRole('button', { name: en.updateNow })).toBeTruthy()
  })

  it('paginates the discover grid and navigates by page number', async () => {
    const plugins = Array.from({ length: 30 }, (_, i) => ({
      name: 'dsh-p' + (i + 1),
      owner: 'alice',
      url: 'https://github.com/alice/dsh-p' + (i + 1),
      category: 'tools',
      npm: null,
      stars: 30 - i,
      added: '2026-08-01',
      description: { en: 'Plugin ' + (i + 1) },
      install: '',
    }))
    stubFetch({
      '/dsh-market/registry': {
        source: 'snapshot',
        registry: { updated: '', count: 30, categories: { tools: { en: 'Tools', zh: '工具' } }, plugins },
      },
    })
    render(<MarketSection {...props()} />)
    await screen.findByText('dsh-p1')
    // Hot sort (stars desc) keeps dsh-p1..dsh-p24 on page 1; page 2 is hidden.
    expect(screen.getByText('dsh-p24')).toBeTruthy()
    expect(screen.queryByText('dsh-p25')).toBeNull()
    // The numbered pager jumps to page 2 and back.
    fireEvent.click(screen.getByRole('button', { name: '2' }))
    await waitFor(() => {
      expect(screen.getByText('dsh-p25')).toBeTruthy()
      expect(screen.queryByText('dsh-p1')).toBeNull()
    })
    fireEvent.click(screen.getByRole('button', { name: en.prevPage }))
    await waitFor(() => expect(screen.getByText('dsh-p1')).toBeTruthy())
  })

  it('switches page size and exposes first/last shortcuts', async () => {
    const plugins = Array.from({ length: 30 }, (_, i) => ({
      name: 'dsh-q' + (i + 1),
      owner: 'bob',
      url: 'https://github.com/bob/dsh-q' + (i + 1),
      category: 'tools',
      npm: null,
      stars: 30 - i,
      added: '2026-08-01',
      description: { en: 'Plugin ' + (i + 1) },
      install: '',
    }))
    stubFetch({
      '/dsh-market/registry': {
        source: 'snapshot',
        registry: { updated: '', count: 30, categories: { tools: { en: 'Tools', zh: '工具' } }, plugins },
      },
    })
    render(<MarketSection {...props()} />)
    await screen.findByText('dsh-q1')
    // First/last shortcuts jump straight to the edges.
    expect(screen.getByRole('button', { name: en.firstPage })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: en.lastPage }))
    await waitFor(() => expect(screen.getByText('dsh-q30')).toBeTruthy())
    // A larger page size collapses the 30 plugins to a single page and hides
    // the numbered pager while keeping the size switcher visible.
    fireEvent.click(screen.getByRole('button', { name: '48' }))
    await waitFor(() => {
      expect(screen.getByText('dsh-q1')).toBeTruthy()
      expect(screen.getByText('dsh-q30')).toBeTruthy()
      expect(screen.queryByRole('button', { name: '2' })).toBeNull()
      expect(screen.getByRole('button', { name: '96' })).toBeTruthy()
    })
  })

  it('the published-within filter keeps only recent plugins', async () => {
    const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10)
    const plugins = [
      { name: 'dsh-fresh', owner: 'a', url: 'https://github.com/a/dsh-fresh', category: 'tools', npm: null, stars: 10, added: daysAgo(2), description: { en: 'Fresh' }, install: '' },
      { name: 'dsh-stale', owner: 'b', url: 'https://github.com/b/dsh-stale', category: 'tools', npm: null, stars: 20, added: daysAgo(60), description: { en: 'Stale' }, install: '' },
    ]
    stubFetch({
      '/dsh-market/registry': {
        source: 'snapshot',
        registry: { updated: '', count: 2, categories: { tools: { en: 'Tools', zh: '工具' } }, plugins },
      },
    })
    render(<MarketSection {...props()} />)
    await screen.findByText('dsh-fresh')
    expect(screen.getByText('dsh-stale')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: en.filter }))
    fireEvent.click(screen.getByRole('radio', { name: en.timeWeek }))
    await waitFor(() => {
      expect(screen.getByText('dsh-fresh')).toBeTruthy()
      expect(screen.queryByText('dsh-stale')).toBeNull()
    })
  })
})

describe('stuck pending recovery (#32)', () => {
  it('a restored pending install that never landed resets to an error instead of "installing" forever', async () => {
    vi.useFakeTimers()
    try {
      // A previous page load started an install whose response was lost.
      sessionStorage.setItem('dshm-pending', JSON.stringify({ url: 'https://github.com/alice/dsh-loop' }))
      render(<MarketSection {...props()} />)
      await vi.waitFor(() => { screen.getByText('dsh-loop') })
      // Host stays idle and the plugin never appears in installed: two polls
      // (2s apart) must conclude the install died and release the button.
      await vi.advanceTimersByTimeAsync(2100)
      await vi.advanceTimersByTimeAsync(2100)
      expect(sessionStorage.getItem('dshm-pending')).toBeNull()
      expect(screen.getByText(new RegExp(en.installFail))).toBeTruthy()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('P1-6 structured progress', () => {
  it('shows the pnpm phase + package + count, and a disabled cancel button while cancelling', async () => {
    vi.useFakeTimers()
    try {
      // A previous page load started an install whose response was lost.
      sessionStorage.setItem('dshm-pending', JSON.stringify({ url: 'https://github.com/alice/dsh-loop' }))
      stubFetch({
        '/dsh-market/status': {
          active: true, phase: 'downloading', done: 3, currentPackage: 'is-odd@3.0.1',
          size: 1000, downloaded: 400, cancelling: true, installed: {},
          pnpm: true, boot: 'boot-1', restart: true,
        },
      })
      render(<MarketSection {...props()} />)
      await vi.waitFor(() => { screen.getByText('dsh-loop') })
      await vi.advanceTimersByTimeAsync(2100)
      await vi.waitFor(() => {
        expect(screen.getByText(/Downloading · is-odd@3\.0\.1 · 3 packages processed/)).toBeTruthy()
      })
      const cancel = screen.getByRole('button', { name: en.cancelling })
      expect((cancel as HTMLButtonElement).disabled).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('P0-2 activation states in the Installed tab', () => {
  it('renders the four-state chip with the server reasons', async () => {
    stubFetch({
      '/dsh-market/installed': {
        profile: 'web',
        installed: { 'dsh-loop': '^1.0.0', 'whale-skin': '^1.0.0' },
        live: ['whale-skin'],
        activation: {
          'dsh-loop': { state: 'restart', reasons: ['in the bundle layer but not hot-mounted — it activates on restart'], bundle: true, hot: false },
          'whale-skin': { state: 'live', reasons: ['live via its bundle patch'], bundle: true, hot: true },
        },
      },
      '/dsh-market/updates': { updates: {} },
    })
    render(<MarketSection {...props()} />)
    await screen.findByText('dsh-loop')
    fireEvent.click(screen.getByRole('button', { name: /Installed/ }))
    await screen.findByText(en.stateRestart)
    expect(screen.getByText(en.stateLive)).toBeTruthy()
    // The reason is behind a disclosure; the chip itself must not claim success.
    expect(screen.getByText(en.stateRestart).textContent).toContain(en.stateRestart)
  })
})

describe('#60 enable/disable switches in the Installed tab', () => {
  function installedStub(overrides: Record<string, unknown>): void {
    stubFetch({
      '/dsh-market/installed': {
        profile: 'web',
        installed: { 'dsh-loop': '^1.0.0' },
        live: [],
        disabled: [],
        groups: {},
        groupOrder: [],
        activation: {
          'dsh-loop': { state: 'live', reasons: [], bundle: true, hot: true },
        },
        ...overrides,
      },
    })
  }

  it('renders an on switch for a live plugin and posts the disable toggle', async () => {
    installedStub({})
    render(<MarketSection {...props()} />)
    await screen.findByText('dsh-loop')
    fireEvent.click(screen.getByRole('button', { name: /Installed/ }))
    const sw = await screen.findByRole('switch', { name: en.disable + ' dsh-loop' })
    expect(sw.getAttribute('aria-checked')).toBe('true')
    fireEvent.click(sw)
    await waitFor(() => {
      const toggle = fetchCalls.find(c => c.path === '/dsh-market/toggle')
      expect(toggle?.body).toEqual({ name: 'dsh-loop', enabled: false })
    })
  })

  it('shows the disabled state with an off switch and hides the restart label', async () => {
    installedStub({
      live: [],
      disabled: ['dsh-loop'],
      activation: {
        'dsh-loop': { state: 'restart', reasons: ['in the bundle layer but not hot-mounted'], bundle: true, hot: false },
      },
    })
    render(<MarketSection {...props()} />)
    await screen.findByText('dsh-loop')
    fireEvent.click(screen.getByRole('button', { name: /Installed/ }))
    expect(await screen.findByText(en.disabledState)).toBeTruthy()
    const sw = screen.getByRole('switch', { name: en.enable + ' dsh-loop' })
    expect(sw.getAttribute('aria-checked')).toBe('false')
    // The disabled chip replaces the misleading "restart to apply" label.
    expect(screen.queryByText(en.stateRestart)).toBeNull()
  })

  it('omits switches for inert and broken plugins', async () => {
    stubFetch({
      '/dsh-market/installed': {
        profile: 'web',
        installed: { 'dsh-loop': '^1.0.0', 'whale-skin': '^1.0.0' },
        live: [],
        disabled: [],
        groups: {},
        groupOrder: [],
        activation: {
          'dsh-loop': { state: 'inert', reasons: ['no dsh.bundle'], bundle: false, hot: false },
          'whale-skin': { state: 'broken', reasons: ['no dsh metadata'], bundle: false, hot: false },
        },
      },
    })
    render(<MarketSection {...props()} />)
    await screen.findByText('dsh-loop')
    fireEvent.click(screen.getByRole('button', { name: /Installed/ }))
    expect(await screen.findByText(en.stateInert)).toBeTruthy()
    expect(screen.getByText(en.stateBroken)).toBeTruthy()
    expect(screen.queryByRole('switch')).toBeNull()
  })
})

describe('#60 catalog deprecation', () => {
  const DEPRECATED_REGISTRY = {
    updated: '', count: 3,
    categories: { tools: { en: 'Tools', zh: '工具' } },
    plugins: [
      { name: 'dsh-old', owner: 'alice', url: 'https://github.com/alice/dsh-old', category: 'tools', npm: 'dsh-old', stars: 5, added: '2026-01-01', description: { en: 'Legacy runner', zh: '旧插件' }, install: '', deprecated: true, replacement: 'dsh-new' },
      { name: 'dsh-new', owner: 'bob', url: 'https://github.com/bob/dsh-new', category: 'tools', npm: 'dsh-new', stars: 20, added: '2026-08-01', description: { en: 'Modern runner', zh: '新插件' }, install: '' },
      { name: 'dsh-plain', owner: 'carol', url: 'https://github.com/carol/dsh-plain', category: 'tools', npm: null, stars: 3, added: '2026-07-01', description: { en: 'Plain plugin', zh: '普通插件' }, install: '' },
    ],
  }
  const contains = (text: string) => (content: string) => content.includes(text)

  it('shows the deprecated badge on the discover card and warns in the install dialog', async () => {
    stubFetch({ '/dsh-market/registry': { source: 'snapshot', registry: DEPRECATED_REGISTRY } })
    render(<MarketSection {...props()} />)
    await screen.findByText('dsh-old')
    expect(screen.getByText(en.deprecatedBadge)).toBeTruthy()
    expect(screen.getByText(contains(en.deprecatedWarn))).toBeTruthy()
    // Open dsh-old's own install dialog: it carries the deprecation warning
    // plus the replacement name/link.
    const oldCard = screen.getByText('dsh-old').closest('[class*="card"]') as HTMLElement
    fireEvent.click(within(oldCard).getByRole('button', { name: en.install }))
    expect(await screen.findByText('Install dsh-old?')).toBeTruthy()
    expect(screen.getAllByText(contains(en.deprecatedWarn)).length).toBeGreaterThan(0)
    // The card behind the modal and the modal itself both carry the link.
    expect(screen.getAllByText(en.replacementHint + ' dsh-new').length).toBeGreaterThan(0)
    fireEvent.click(screen.getByRole('button', { name: en.cancel }))
  })

  it('installed rows warn and offer view/install replacement entries', async () => {
    stubFetch({
      '/dsh-market/registry': { source: 'snapshot', registry: DEPRECATED_REGISTRY },
      '/dsh-market/installed': {
        profile: 'web',
        installed: { 'dsh-old': '^1.0.0' },
        live: ['dsh-old'],
        disabled: [],
        groups: {},
        groupOrder: [],
        activation: { 'dsh-old': { state: 'live', reasons: [], bundle: true, hot: true } },
      },
    })
    render(<MarketSection {...props()} />)
    await screen.findByText('dsh-old')
    fireEvent.click(screen.getByRole('button', { name: /Installed/ }))
    expect(await screen.findByText(contains(en.deprecatedWarn))).toBeTruthy()
    expect(screen.getByText(en.deprecatedBadge)).toBeTruthy()
    // View replacement jumps to the Discover tab with the new plugin focused.
    fireEvent.click(screen.getByRole('button', { name: en.viewReplacement }))
    await waitFor(() => expect(screen.getByText('dsh-new')).toBeTruthy())
    expect((screen.getByPlaceholderText(en.searchPh) as HTMLInputElement).value).toBe('dsh-new')
  })

  it('install replacement opens the confirm dialog for the new plugin', async () => {
    stubFetch({
      '/dsh-market/registry': { source: 'snapshot', registry: DEPRECATED_REGISTRY },
      '/dsh-market/installed': {
        profile: 'web',
        installed: { 'dsh-old': '^1.0.0' },
        live: ['dsh-old'],
        disabled: [],
        groups: {},
        groupOrder: [],
        activation: { 'dsh-old': { state: 'live', reasons: [], bundle: true, hot: true } },
      },
    })
    render(<MarketSection {...props()} />)
    await screen.findByText('dsh-old')
    fireEvent.click(screen.getByRole('button', { name: /Installed/ }))
    const installReplacement = await screen.findByRole('button', { name: en.installReplacement })
    fireEvent.click(installReplacement)
    expect(await screen.findByText('Install dsh-new?')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: en.cancel }))
  })
})

describe('#60 groups view', () => {
  /** Stateful fake: mirrors the server-side group/toggle semantics in memory. */
  function makeFake(installed: Record<string, string>) {
    const state = { disabled: [] as string[], groups: {} as Record<string, string[]>, groupOrder: [] as string[] }
    const activation: Record<string, unknown> = {}
    for (const name of Object.keys(installed)) {
      activation[name] = { state: 'live', reasons: [], bundle: true, hot: true }
    }
    stubFetch({
      '/dsh-market/installed': () => ({
        profile: 'web',
        installed,
        live: [],
        disabled: [...state.disabled],
        groups: JSON.parse(JSON.stringify(state.groups)),
        groupOrder: [...state.groupOrder],
        activation,
      }),
      '/dsh-market/toggle': (body: any) => {
        const index = state.disabled.indexOf(body.name)
        if (body.enabled === true && index !== -1) state.disabled.splice(index, 1)
        if (body.enabled === false && index === -1) state.disabled.push(body.name)
        return { ok: true, disabled: [...state.disabled], live: [], activation: {} }
      },
      '/dsh-market/groups': (body: any) => {
        if (body.action === 'create') { state.groups[body.name] = []; state.groupOrder.push(body.name) }
        if (body.action === 'rename') {
          state.groups[body.newName] = state.groups[body.name] ?? []
          delete state.groups[body.name]
          const index = state.groupOrder.indexOf(body.name)
          if (index !== -1) state.groupOrder[index] = body.newName
        }
        if (body.action === 'delete') {
          delete state.groups[body.name]
          state.groupOrder = state.groupOrder.filter(g => g !== body.name)
        }
        if (body.action === 'set-members') {
          state.groups[body.name] = body.members.filter((m: string) => installed[m] !== undefined && m !== 'dshmarket')
        }
        if (body.action === 'toggle') {
          for (const member of state.groups[body.name] ?? []) {
            const index = state.disabled.indexOf(member)
            if (body.enabled === true && index !== -1) state.disabled.splice(index, 1)
            if (body.enabled === false && index === -1) state.disabled.push(member)
          }
        }
        return {
          ok: true,
          groups: JSON.parse(JSON.stringify(state.groups)),
          groupOrder: [...state.groupOrder],
          disabled: [...state.disabled],
        }
      },
    })
    return state
  }

  async function openGroupsView(): Promise<void> {
    fireEvent.click(screen.getByRole('button', { name: /Installed/ }))
    fireEvent.click(await screen.findByRole('button', { name: en.tabGroups }))
  }

  it('creates, assigns, removes, renames and deletes groups through the route', async () => {
    makeFake({ 'dsh-loop': '^1.0.0', 'dsh-notify': '^1.0.0' })
    render(<MarketSection {...props()} />)
    await screen.findByText('dsh-loop')
    await openGroupsView()
    expect(await screen.findByText(en.noGroups)).toBeTruthy()

    // Create.
    fireEvent.click(screen.getByRole('button', { name: en.groupNew }))
    fireEvent.change(screen.getByPlaceholderText(en.groupNamePh), { target: { value: 'work' } })
    fireEvent.click(screen.getByRole('button', { name: en.groupCreate }))
    expect(await screen.findByText('work')).toBeTruthy()

    // Assign dsh-loop into the group from the ungrouped list.
    const loopRow = screen.getByText('dsh-loop').closest('[class*="irow"]') as HTMLElement
    fireEvent.click(within(loopRow).getByRole('button', { name: en.groupAssign }))
    fireEvent.change(within(loopRow).getByRole('combobox'), { target: { value: 'work' } })
    fireEvent.click(within(loopRow).getByRole('button', { name: en.groupAssign }))
    await waitFor(() => {
      const row = screen.getByText('dsh-loop').closest('[class*="groupMember"]') as HTMLElement | null
      expect(row).not.toBeNull()
    })

    // Remove it again.
    const memberRow = screen.getByText('dsh-loop').closest('[class*="groupMember"]') as HTMLElement
    fireEvent.click(within(memberRow).getByRole('button', { name: en.groupRemove }))
    await waitFor(() => expect(screen.getByText(en.groupEmpty)).toBeTruthy())

    // Rename.
    const groupRow = screen.getByText('work').closest('[class*="groupRow"]') as HTMLElement
    fireEvent.click(within(groupRow).getByRole('button', { name: en.groupRename }))
    fireEvent.change(within(groupRow).getByPlaceholderText(en.groupNamePh), { target: { value: 'daily' } })
    fireEvent.click(within(groupRow).getByRole('button', { name: en.groupRename }))
    expect(await screen.findByText('daily')).toBeTruthy()
    expect(screen.queryByText('work')).toBeNull()

    // Delete.
    const dailyRow = screen.getByText('daily').closest('[class*="groupRow"]') as HTMLElement
    fireEvent.click(within(dailyRow).getByRole('button', { name: en.groupDelete }))
    fireEvent.click(within(dailyRow).getByRole('button', { name: en.groupConfirmDelete }))
    expect(await screen.findByText(en.noGroups)).toBeTruthy()
  })

  it('group switch derives mixed from members and batch-toggles the group', async () => {
    const state = makeFake({ 'dsh-loop': '^1.0.0', 'dsh-notify': '^1.0.0' })
    state.groups['work'] = ['dsh-loop', 'dsh-notify']
    state.groupOrder.push('work')
    render(<MarketSection {...props()} />)
    await screen.findByText('dsh-loop')
    await openGroupsView()
    const groupSwitch = await screen.findByRole('switch', { name: en.disable + ' work' })
    expect(groupSwitch.getAttribute('aria-checked')).toBe('true')

    // Toggle one member off in the list view → the group reads mixed.
    fireEvent.click(screen.getByRole('button', { name: en.tabList }))
    fireEvent.click(await screen.findByRole('switch', { name: en.disable + ' dsh-loop' }))
    await waitFor(() => {
      const toggle = fetchCalls.find(c => c.path === '/dsh-market/toggle')
      expect(toggle?.body).toEqual({ name: 'dsh-loop', enabled: false })
    })
    fireEvent.click(screen.getByRole('button', { name: en.tabGroups }))
    const mixed = await screen.findByRole('switch', { name: en.enable + ' work' })
    expect(mixed.getAttribute('aria-checked')).toBe('mixed')
    expect(screen.getByText(en.groupMixed)).toBeTruthy()

    // Clicking the mixed switch enables the whole group.
    fireEvent.click(mixed)
    await waitFor(() => {
      expect(screen.getByRole('switch', { name: en.disable + ' work' }).getAttribute('aria-checked')).toBe('true')
    })
    // And switching it off disables every member at once.
    fireEvent.click(screen.getByRole('switch', { name: en.disable + ' work' }))
    await waitFor(() => {
      expect(screen.getByRole('switch', { name: en.enable + ' work' }).getAttribute('aria-checked')).toBe('false')
    })
  })

  it('group member rows carry a live switch that toggles the member', async () => {
    const state = makeFake({ 'dsh-loop': '^1.0.0', 'dsh-notify': '^1.0.0' })
    state.groups['work'] = ['dsh-loop', 'dsh-notify']
    state.groupOrder.push('work')
    render(<MarketSection {...props()} />)
    await screen.findByText('dsh-loop')
    await openGroupsView()

    const memberSwitch = await screen.findByRole('switch', { name: en.disable + ' dsh-loop' })
    expect(memberSwitch.getAttribute('aria-checked')).toBe('true')
    fireEvent.click(memberSwitch)
    await waitFor(() => {
      const toggle = fetchCalls.find(c => c.path === '/dsh-market/toggle' && c.body?.name === 'dsh-loop')
      expect(toggle?.body).toEqual({ name: 'dsh-loop', enabled: false })
    })
    // The stateful fake persists the choice; the member row flips to off.
    await waitFor(() => {
      expect(screen.getByRole('switch', { name: en.enable + ' dsh-loop' }).getAttribute('aria-checked')).toBe('false')
    })
    expect(screen.getByText(en.disabledState)).toBeTruthy()
  })

  it('the Add plugin button lists installed plugins and adds them via set-members', async () => {
    const state = makeFake({ 'dsh-loop': '^1.0.0', 'dsh-notify': '^1.0.0' })
    state.groups['work'] = ['dsh-loop']
    state.groupOrder.push('work')
    render(<MarketSection {...props()} />)
    await screen.findByText('dsh-loop')
    await openGroupsView()

    // Only dsh-notify is a candidate: dsh-loop is already a member.
    fireEvent.click(await screen.findByRole('button', { name: en.groupAdd }))
    const addButtons = screen.getAllByRole('button', { name: en.groupAdd })
    expect(addButtons.length).toBe(2) // header toggle + the candidate row
    fireEvent.click(addButtons[1])
    await waitFor(() => {
      const set = fetchCalls.find(c => c.path === '/dsh-market/groups' && c.body?.action === 'set-members')
      expect(set?.body).toEqual({ action: 'set-members', name: 'work', members: ['dsh-loop', 'dsh-notify'] })
    })
    // The added plugin now renders inside the group's member list.
    await waitFor(() => {
      const row = screen.getByText('dsh-notify').closest('[class*="groupMember"]') as HTMLElement | null
      expect(row).not.toBeNull()
    })
  })

  it('disables Add theme when the group already holds a theme', async () => {
    const state = makeFake({ 'dsh-loop': '^1.0.0', 'whale-skin': '^1.0.0' })
    state.groups['looks'] = ['whale-skin']
    state.groupOrder.push('looks')
    render(<MarketSection {...props()} />)
    await screen.findByText('whale-skin')
    await openGroupsView()
    const addTheme = await screen.findByRole('button', { name: en.groupAddTheme })
    expect((addTheme as HTMLButtonElement).disabled).toBe(true)
    // Ordinary plugin adds stay available.
    expect((screen.getByRole('button', { name: en.groupAdd }) as HTMLButtonElement).disabled).toBe(false)
  })

  it('Add theme lists installed theme plugins and adds one via set-members', async () => {
    const state = makeFake({ 'dsh-loop': '^1.0.0', 'whale-skin': '^1.0.0' })
    state.groups['looks'] = ['dsh-loop']
    state.groupOrder.push('looks')
    render(<MarketSection {...props()} />)
    await screen.findByText('whale-skin')
    await openGroupsView()

    fireEvent.click(await screen.findByRole('button', { name: en.groupAddTheme }))
    const themeAddButtons = screen.getAllByRole('button', { name: en.groupAddTheme })
    expect(themeAddButtons.length).toBe(2) // header toggle + the theme candidate
    fireEvent.click(themeAddButtons[1])
    await waitFor(() => {
      const set = fetchCalls.find(c => c.path === '/dsh-market/groups' && c.body?.action === 'set-members')
      expect(set?.body).toEqual({ action: 'set-members', name: 'looks', members: ['dsh-loop', 'whale-skin'] })
    })
    // Once the group holds a theme, the Add theme button disables.
    await waitFor(() => {
      expect((screen.getByRole('button', { name: en.groupAddTheme }) as HTMLButtonElement).disabled).toBe(true)
    })
  })
})
