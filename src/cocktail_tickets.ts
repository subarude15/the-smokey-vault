import { db } from "./db.js";

export const MAX_TICKET_NAME = 40;
export const MAX_TICKET_NOTE = 240;

export type CocktailTicket = {
  id: number;
  cocktail_id: number | null;
  name: string;
  guest_name: string;
  notes: string;
  source_url: string;
  image_url: string;
  status: string;
  created_at: string;
};

db.exec(`
CREATE TABLE IF NOT EXISTS cocktail_tickets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  cocktail_id INTEGER,
  name TEXT NOT NULL,
  guest_name TEXT NOT NULL,
  notes TEXT DEFAULT '',
  source_url TEXT DEFAULT '',
  image_url TEXT DEFAULT '',
  status TEXT DEFAULT 'queued',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS cocktail_tickets_status ON cocktail_tickets(status, id DESC);
`);

export function listTickets(status = "queued"): CocktailTicket[] {
  return db.prepare(
    "SELECT id, cocktail_id, name, guest_name, notes, source_url, image_url, status, created_at FROM cocktail_tickets WHERE status=? ORDER BY id DESC"
  ).all(status) as CocktailTicket[];
}

export function createTicket(input: {
  cocktail_id?: number | null;
  name: string;
  guest_name: string;
  notes?: string;
  source_url?: string;
  image_url?: string;
}): CocktailTicket {
  const guest = input.guest_name.trim().replace(/\s+/g, " ");
  const drink = input.name.trim().replace(/\s+/g, " ");
  const notes = (input.notes ?? "").trim();
  if (!guest) throw new Error("Add who this is for");
  if (guest.length > MAX_TICKET_NAME) throw new Error(`Name must be ${MAX_TICKET_NAME} characters or fewer`);
  if (!drink) throw new Error("A drink name is required");
  if (notes.length > MAX_TICKET_NOTE) throw new Error(`Note must be ${MAX_TICKET_NOTE} characters or fewer`);
  const cocktailId = Number(input.cocktail_id);
  const linked = Number.isInteger(cocktailId) && cocktailId > 0 ? cocktailId : null;
  if (linked && !db.prepare("SELECT id FROM cocktails WHERE id=?").get(linked)) {
    throw new Error("Recipe not found");
  }
  const result = db.prepare(
    "INSERT INTO cocktail_tickets(cocktail_id,name,guest_name,notes,source_url,image_url,status) VALUES(?,?,?,?,?,?, 'queued')"
  ).run(linked, drink, guest, notes, input.source_url?.trim() ?? "", input.image_url?.trim() ?? "");
  return db.prepare(
    "SELECT id, cocktail_id, name, guest_name, notes, source_url, image_url, status, created_at FROM cocktail_tickets WHERE id=?"
  ).get(result.lastInsertRowid) as CocktailTicket;
}

export function setTicketStatus(id: number, status: "queued" | "poured"): CocktailTicket | null {
  const result = db.prepare("UPDATE cocktail_tickets SET status=? WHERE id=?").run(status, id);
  if (!result.changes) return null;
  return db.prepare(
    "SELECT id, cocktail_id, name, guest_name, notes, source_url, image_url, status, created_at FROM cocktail_tickets WHERE id=?"
  ).get(id) as CocktailTicket;
}

export function deleteTicket(id: number): boolean {
  return db.prepare("DELETE FROM cocktail_tickets WHERE id=?").run(id).changes > 0;
}
