import { db } from "../../db.js";

export type AdminAuditEvent = {
  id: number;
  action_type: string;
  detail: Record<string, unknown>;
  created_at: string;
};

export function ensureAdminAuditTable() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS admin_audit_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      action_type TEXT NOT NULL,
      detail_json TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_admin_audit_events_created
      ON admin_audit_events(created_at DESC);
  `);
}

ensureAdminAuditTable();

export function recordAdminAuditEvent(actionType: string, detail: Record<string, unknown>) {
  const detailJson = JSON.stringify(detail);
  const result = db.prepare(`
    INSERT INTO admin_audit_events (action_type, detail_json)
    VALUES (?, ?)
  `).run(actionType, detailJson);
  const row = db.prepare("SELECT * FROM admin_audit_events WHERE id=?").get(result.lastInsertRowid) as {
    id: number;
    action_type: string;
    detail_json: string;
    created_at: string;
  };
  return {
    id: row.id,
    action_type: row.action_type,
    detail: JSON.parse(row.detail_json) as Record<string, unknown>,
    created_at: row.created_at
  } satisfies AdminAuditEvent;
}

export function getLatestAdminAuditEvent(actionType?: string): AdminAuditEvent | null {
  const row = actionType
    ? db.prepare(`
        SELECT * FROM admin_audit_events
        WHERE action_type = ?
        ORDER BY id DESC
        LIMIT 1
      `).get(actionType) as { id: number; action_type: string; detail_json: string; created_at: string } | undefined
    : db.prepare(`
        SELECT * FROM admin_audit_events
        ORDER BY id DESC
        LIMIT 1
      `).get() as { id: number; action_type: string; detail_json: string; created_at: string } | undefined;
  if (!row) return null;
  return {
    id: row.id,
    action_type: row.action_type,
    detail: JSON.parse(row.detail_json) as Record<string, unknown>,
    created_at: row.created_at
  };
}

export function clearAdminAuditForTests() {
  db.exec("DELETE FROM admin_audit_events");
}
