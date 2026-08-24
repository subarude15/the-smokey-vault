import { db } from "./db.js";
import { itemExists, REVIEW_TABLES } from "./reviews.js";

export const VOTE_TABLES = REVIEW_TABLES;

export type VoteTally = {
  up: number;
  down: number;
  net: number;
  total: number;
  score: number | null;
  mine: 1 | -1 | null;
};

db.exec(`
CREATE TABLE IF NOT EXISTS votes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  table_name TEXT NOT NULL,
  item_id INTEGER NOT NULL,
  voter_key TEXT NOT NULL,
  value INTEGER NOT NULL CHECK(value IN (-1, 1)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(table_name, item_id, voter_key)
);
CREATE INDEX IF NOT EXISTS votes_item ON votes(table_name, item_id);
`);

function normalizeVoter(raw: string) {
  const voter = raw.trim();
  if (!/^[A-Za-z0-9_-]{8,80}$/.test(voter)) throw new Error("Missing voter");
  return voter;
}

export function summarizeVotes(up: number, down: number, mine: 1 | -1 | null = null): VoteTally {
  const total = up + down;
  return {
    up,
    down,
    net: up - down,
    total,
    score: total ? Math.round((10 * up) / total) : null,
    mine
  };
}

export function getVoteTally(table: string, itemId: number, voterKey?: string): VoteTally {
  const row = db.prepare(`
    SELECT
      SUM(CASE WHEN value = 1 THEN 1 ELSE 0 END) AS up_count,
      SUM(CASE WHEN value = -1 THEN 1 ELSE 0 END) AS down_count
    FROM votes WHERE table_name=? AND item_id=?
  `).get(table, itemId) as { up_count: number | null; down_count: number | null };
  let mine: 1 | -1 | null = null;
  if (voterKey) {
    const vote = db.prepare("SELECT value FROM votes WHERE table_name=? AND item_id=? AND voter_key=?").get(table, itemId, voterKey) as { value: number } | undefined;
    if (vote?.value === 1 || vote?.value === -1) mine = vote.value;
  }
  return summarizeVotes(Number(row?.up_count ?? 0), Number(row?.down_count ?? 0), mine);
}

export function voteTallies(table: string): Record<number, VoteTally> {
  const rows = db.prepare(`
    SELECT item_id,
      SUM(CASE WHEN value = 1 THEN 1 ELSE 0 END) AS up_count,
      SUM(CASE WHEN value = -1 THEN 1 ELSE 0 END) AS down_count
    FROM votes WHERE table_name=? GROUP BY item_id
  `).all(table) as Array<{ item_id: number; up_count: number; down_count: number }>;
  return Object.fromEntries(rows.map((row) => [row.item_id, summarizeVotes(Number(row.up_count), Number(row.down_count))]));
}

export function castVote(table: string, itemId: number, voterRaw: string, value: number): VoteTally {
  if (value !== 1 && value !== -1) throw new Error("Vote must be up or down");
  const voter = normalizeVoter(voterRaw);
  if (!itemExists(table, itemId)) throw new Error("Bottle not found");
  const existing = db.prepare(
    "SELECT value FROM votes WHERE table_name=? AND item_id=? AND voter_key=?"
  ).get(table, itemId, voter) as { value: number } | undefined;
  if (existing?.value === value) {
    db.prepare("DELETE FROM votes WHERE table_name=? AND item_id=? AND voter_key=?").run(table, itemId, voter);
  } else if (existing) {
    db.prepare("UPDATE votes SET value=? WHERE table_name=? AND item_id=? AND voter_key=?").run(value, table, itemId, voter);
  } else {
    db.prepare("INSERT INTO votes(table_name, item_id, voter_key, value) VALUES(?, ?, ?, ?)").run(table, itemId, voter, value);
  }
  return getVoteTally(table, itemId, voter);
}

export function deleteVotesForItem(table: string, itemId: number) {
  db.prepare("DELETE FROM votes WHERE table_name=? AND item_id=?").run(table, itemId);
}
