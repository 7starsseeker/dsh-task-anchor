import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { pruneSnapshots, snapshotFileName } from '../lib/store.js'

test('pruneSnapshots removes only stale snapshots of other sessions', () => {
  const dir = mkdtempSync(join(tmpdir(), 'task-anchor-prune-'))
  try {
    const thirtyDaysAgo = new Date(Date.now() - 30 * 86_400_000)
    const keep = snapshotFileName('session-current')
    const staleOrphan = snapshotFileName('session-abandoned')
    const freshOrphan = snapshotFileName('session-other')
    writeFileSync(join(dir, keep), '{}')
    writeFileSync(join(dir, staleOrphan), '{}')
    writeFileSync(join(dir, freshOrphan), '{}')
    writeFileSync(join(dir, 'notes.txt'), 'not ours')
    // Old, but the current session: every write refreshes it anyway, so a stale
    // mtime here must still spare it.
    utimesSync(join(dir, keep), thirtyDaysAgo, thirtyDaysAgo)
    utimesSync(join(dir, staleOrphan), thirtyDaysAgo, thirtyDaysAgo)

    assert.equal(pruneSnapshots(dir, { keepSessionId: 'session-current', ttlDays: 7 }), 1)
    assert.deepEqual(readdirSync(dir).sort(), [keep, freshOrphan, 'notes.txt'].sort())

    // 0 disables the sweep: the fresh orphan stays even when it would qualify.
    utimesSync(join(dir, freshOrphan), thirtyDaysAgo, thirtyDaysAgo)
    assert.equal(pruneSnapshots(dir, { keepSessionId: 'session-current', ttlDays: 0 }), 0)
    assert.ok(readdirSync(dir).includes(freshOrphan))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
