/**
 * Audit trail.
 *
 * Records significant, security-relevant actions: who did what, to which
 * entity, and when. The brief requires an auditable record of administrative
 * changes, and this is also the honest answer to "how would you investigate a
 * disputed booking?"
 *
 * WHAT IS DELIBERATELY NOT RECORDED: passwords, password hashes, session
 * tokens, and any personal detail beyond a user id. `metadata` is for
 * non-sensitive change detail such as a facility name, a changed field, or a
 * cancellation reason - never credentials.
 *
 * A failed audit write must never break the operation it describes, so writes
 * are best-effort. The tradeoff is stated rather than hidden: an audit row
 * could in principle be missing while the action succeeded. For a prototype
 * this is acceptable; a real deployment would write the audit row inside the
 * same transaction as the change.
 */
import { randomUUID } from 'node:crypto'

import { getDb, nowIso } from '../db/connection.ts'

export interface AuditEntry {
  actorId: string | null
  action: string
  entityType: string
  entityId: string | null
  metadata?: Record<string, unknown>
}

/**
 * Appends an entry to the audit log.
 *
 * Never throws. A logging failure is reported to the server console and
 * otherwise ignored, so that an audit problem cannot turn a successful booking
 * into a failed one.
 */
export function recordAudit(entry: AuditEntry): void {
  try {
    getDb()
      .prepare(
        `insert into audit_logs (id, actor_id, action, entity_type, entity_id, metadata, created_at)
         values (@id, @actorId, @action, @entityType, @entityId, @metadata, @createdAt)`,
      )
      .run({
        id: randomUUID(),
        actorId: entry.actorId,
        action: entry.action,
        entityType: entry.entityType,
        entityId: entry.entityId,
        metadata: JSON.stringify(entry.metadata ?? {}),
        createdAt: nowIso(),
      })
  } catch (error) {
    console.error(
      `[audit] failed to record "${entry.action}" on ${entry.entityType}/${entry.entityId ?? '-'}`,
      error instanceof Error ? error.message : error,
    )
  }
}

export interface AuditLogRow {
  id: string
  actorId: string | null
  actorName: string | null
  action: string
  entityType: string
  entityId: string | null
  metadata: Record<string, unknown>
  createdAt: string
}

interface RawAuditRow {
  id: string
  actor_id: string | null
  actor_name: string | null
  action: string
  entity_type: string
  entity_id: string | null
  metadata: string
  created_at: string
}

/** Most recent audit entries, newest first, for the administrator view. */
export function listAuditEntries(limit = 50, entityId?: string): AuditLogRow[] {
  const capped = Math.min(Math.max(limit, 1), 200)

  const rows = getDb()
    .prepare(
      `select a.id,
              a.actor_id,
              p.display_name as actor_name,
              a.action,
              a.entity_type,
              a.entity_id,
              a.metadata,
              a.created_at
         from audit_logs a
         left join profiles p on p.id = a.actor_id
        where (@entityId is null or a.entity_id = @entityId)
        order by a.created_at desc
        limit @limit`,
    )
    .all({ entityId: entityId ?? null, limit: capped }) as RawAuditRow[]

  return rows.map((row) => {
    let metadata: Record<string, unknown> = {}
    try {
      const parsed: unknown = JSON.parse(row.metadata)
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        metadata = parsed as Record<string, unknown>
      }
    } catch {
      // A corrupt metadata blob must not break the whole audit view. The row
      // is still returned, just without detail.
      metadata = { note: 'metadata could not be read' }
    }

    return {
      id: row.id,
      actorId: row.actor_id,
      actorName: row.actor_name,
      action: row.action,
      entityType: row.entity_type,
      entityId: row.entity_id,
      metadata,
      createdAt: row.created_at,
    }
  })
}
