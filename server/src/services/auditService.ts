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

import { asInstantIso, db, execute, type Queryable } from '../db/connection.ts'

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
 *
 * It is ASYNC, and callers SHOULD await it. Not for correctness - the failure
 * handling above is the same either way - but because on a serverless platform
 * the process may be frozen as soon as the response is written, and a write
 * left in flight at that moment can simply never land. An audit trail with
 * holes in it is worse than a slower one.
 */
export async function recordAudit(entry: AuditEntry): Promise<void> {
  try {
    await execute(
      `insert into audit_logs (id, actor_id, action, entity_type, entity_id, metadata)
       values (@id, @actorId, @action, @entityType, @entityId, @metadata::jsonb)`,
      {
        id: randomUUID(),
        actorId: entry.actorId,
        action: entry.action,
        entityType: entry.entityType,
        entityId: entry.entityId,
        // jsonb is not a string type, and `pg` would otherwise send this object
        // as a Postgres composite. Serialising explicitly is what makes the
        // column hold JSON.
        metadata: JSON.stringify(entry.metadata ?? {}),
      },
    )
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
  metadata: unknown
  created_at: Date
}

/** Most recent audit entries, newest first, for the administrator view. */
export async function listAuditEntries(
  limit = 50,
  entityId?: string,
  q: Queryable = db,
): Promise<AuditLogRow[]> {
  const capped = Math.min(Math.max(limit, 1), 200)

  const rows = await q.query<RawAuditRow>(
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
    { entityId: entityId ?? null, limit: capped },
  )

  return rows.map((row) => {
    // jsonb arrives already decoded, so this is a narrowing rather than a
    // parse. A value that is valid JSON but not an object (an array, a string)
    // is still possible and still must not break the whole audit view.
    const metadata =
      row.metadata !== null && typeof row.metadata === 'object' && !Array.isArray(row.metadata)
        ? (row.metadata as Record<string, unknown>)
        : { note: 'metadata was not a JSON object' }

    return {
      id: row.id,
      actorId: row.actor_id,
      actorName: row.actor_name,
      action: row.action,
      entityType: row.entity_type,
      entityId: row.entity_id,
      metadata,
      createdAt: asInstantIso(row.created_at),
    }
  })
}
