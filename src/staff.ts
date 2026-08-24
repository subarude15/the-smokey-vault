import { db } from "./db.js";
import {
  clipBody, clipText, MAX_STAFF_BIO, MAX_STAFF_NAME, MAX_STAFF_ROLE, type StaffMember
} from "./speakeasy-shared.js";

export class StaffError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

const SELECT = "SELECT id, name, role, bio, image_url, display_order, created_at FROM staff_members";

export function listStaff(): StaffMember[] {
  return db.prepare(`${SELECT} ORDER BY display_order ASC, id ASC`).all() as StaffMember[];
}

function getStaff(id: number): StaffMember | undefined {
  return db.prepare(`${SELECT} WHERE id=?`).get(id) as StaffMember | undefined;
}

function nextOrder() {
  const row = db.prepare("SELECT COALESCE(MAX(display_order), 0) AS top FROM staff_members").get() as { top: number };
  return row.top + 1;
}

export function createStaff(input: Record<string, unknown>): StaffMember {
  const name = clipText(input.name, MAX_STAFF_NAME);
  if (!name) throw new StaffError("Give this crew member a name");
  const order = input.display_order === undefined ? nextOrder() : Number(input.display_order) || 0;
  const result = db.prepare(`INSERT INTO staff_members(name, role, bio, image_url, display_order)
    VALUES(?,?,?,?,?)`).run(
    name,
    clipText(input.role, MAX_STAFF_ROLE),
    clipBody(input.bio, MAX_STAFF_BIO),
    clipText(input.image_url, 500),
    order
  );
  return getStaff(Number(result.lastInsertRowid))!;
}

export function updateStaff(id: number, input: Record<string, unknown>): StaffMember {
  const current = getStaff(id);
  if (!current) throw new StaffError("That crew member is gone", 404);

  const name = input.name === undefined ? current.name : clipText(input.name, MAX_STAFF_NAME);
  if (!name) throw new StaffError("Give this crew member a name");

  db.prepare(`UPDATE staff_members SET name=?, role=?, bio=?, image_url=?, display_order=? WHERE id=?`).run(
    name,
    input.role === undefined ? current.role : clipText(input.role, MAX_STAFF_ROLE),
    input.bio === undefined ? current.bio : clipBody(input.bio, MAX_STAFF_BIO),
    input.image_url === undefined ? current.image_url : clipText(input.image_url, 500),
    input.display_order === undefined ? current.display_order : Number(input.display_order) || 0,
    id
  );
  return getStaff(id)!;
}

/**
 * Swaps a member with its neighbour in display order. Ordering is normalized first so
 * rows created before this feature (all sharing display_order 0) still move predictably.
 */
export function moveStaff(id: number, direction: "up" | "down"): StaffMember[] {
  const ordered = listStaff();
  const index = ordered.findIndex((member) => member.id === id);
  if (index < 0) throw new StaffError("That crew member is gone", 404);

  const target = direction === "up" ? index - 1 : index + 1;
  if (target < 0 || target >= ordered.length) return ordered;

  [ordered[index], ordered[target]] = [ordered[target], ordered[index]];
  const renumber = db.prepare("UPDATE staff_members SET display_order=? WHERE id=?");
  db.transaction(() => {
    ordered.forEach((member, position) => renumber.run(position + 1, member.id));
  })();
  return listStaff();
}

export function deleteStaff(id: number) {
  const result = db.prepare("DELETE FROM staff_members WHERE id=?").run(id);
  if (!result.changes) throw new StaffError("That crew member is already gone", 404);
  return { ok: true };
}
