import assert from "node:assert/strict";
import { test } from "node:test";
import { createTicket, deleteTicket, listTickets, setTicketStatus } from "./cocktail_tickets.js";
import { db } from "./db.js";

test("bartender tickets queue a drink for someone and can be poured", () => {
  const row = db.prepare("INSERT INTO cocktails(name,ingredients) VALUES(?,?)").run(
    `Ticket Test ${Date.now()}`,
    JSON.stringify(["45 ml gin"])
  );
  const ticket = createTicket({
    cocktail_id: Number(row.lastInsertRowid),
    name: "Gimlet",
    guest_name: "Sam",
    notes: "Up, extra lime"
  });
  assert.equal(ticket.guest_name, "Sam");
  assert.equal(ticket.status, "queued");
  assert.ok(listTickets("queued").some((entry) => entry.id === ticket.id));
  const poured = setTicketStatus(ticket.id, "poured");
  assert.equal(poured?.status, "poured");
  assert.equal(listTickets("queued").some((entry) => entry.id === ticket.id), false);
  assert.equal(deleteTicket(ticket.id), true);
  db.prepare("DELETE FROM cocktails WHERE id=?").run(row.lastInsertRowid);
});
