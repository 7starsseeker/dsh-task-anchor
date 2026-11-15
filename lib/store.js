/**
 * The only durable artifact this plugin keeps: one small JSON file per session
 * that was interrupted by a mid-turn user message while work was still open.
 *
 * Why a file at all: the session log survives compaction, but the *decision*
 * "this work is suspended, not cancelled" is a judgement the model recorded only
 * in prose. A file makes that decision survive a restart and a context rewrite.
 *
 * Why one file and not a checkpoint stream: the trigger is the interjection
 * itself, so the write frequency is "at most once per interrupted turn" — a
 * periodic checkpoint would be paid for on every turn and read almost never.
 *
 * @module dsh-task-anchor/store
 */

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Bumped when the on-disk shape changes; older files are ignored, not migrated. */
export const SNAPSHOT_VERSION = 2

/**
 * Where suspended-work snapshots live.
 * The harness does not expose a home-directory service to plugins (0.2.2-rc.3),
 * so the order is: explicit config, then the launcher's DSH_HOME, then the
 * conventional `~/.dsh`.
 * @param configured - `storeDir` from the profile patch; '' means "resolve".
 * @returns an absolute directory path.
 */
export function resolveStoreDir(configured) {
  if (typeof configured === 'string' && configured.trim() !== '') return configured.trim()
  const home = typeof process.env.DSH_HOME === 'string' ? process.env.DSH_HOME.trim() : ''
  if (home !== '') return join(home, 'task-anchor')
  return join(homedir(), '.dsh', 'task-anchor')
}

/**
 * A filesystem-safe file stem for a session id.
 * @param sessionId - the session's identifier.
 * @returns a name that cannot escape the store directory.
 */
export function snapshotFileName(sessionId) {
  const safe = String(sessionId ?? '')
    .replace(/[^A-Za-z0-9._-]/g, '_')
    .slice(0, 96)
  return `suspended-${safe === '' ? 'unknown' : safe}.json`
}

/**
 * Write (or overwrite) the snapshot for one session.
 * @param dir - the store directory.
 * @param sessionId - the session's identifier.
 * @param snapshot - `{version, session, turn, seq, at, interjection, items, stoppedAt}`.
 */
export function saveSnapshot(dir, sessionId, snapshot) {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, snapshotFileName(sessionId)), `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8')
}

/**
 * Read the snapshot for one session.
 * @param dir - the store directory.
 * @param sessionId - the session's identifier.
 * @returns the snapshot, or null when absent/unreadable/from another version.
 */
export function loadSnapshot(dir, sessionId) {
  try {
    const raw = JSON.parse(readFileSync(join(dir, snapshotFileName(sessionId)), 'utf8'))
    if (!raw || raw.version !== SNAPSHOT_VERSION) return null
    return raw
  } catch {
    return null
  }
}

/**
 * Delete the snapshot for one session. Missing files are not an error: the
 * anchor disappears by itself as soon as the plan is empty.
 * @param dir - the store directory.
 * @param sessionId - the session's identifier.
 */
export function removeSnapshot(dir, sessionId) {
  try {
    rmSync(join(dir, snapshotFileName(sessionId)), { force: true })
  } catch {
    // A read-only store must not break the turn boundary.
  }
}
