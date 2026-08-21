import { db } from "./db.js";

export const NEXT_BOARDS = ["shelf", "keg", "brew"] as const;
export type NextBoard = (typeof NEXT_BOARDS)[number];
export type NextKind = "spirits" | "wines" | "keg" | "brew";

export const MAX_NEXT_NAME = 80;
export const MAX_NEXT_MAKER = 80;
export const MAX_NEXT_NOTE = 120;
export const MAX_NEXT_PER_BOARD = 80;

export type NextItem = {
  id: number;
  board: NextBoard;
  kind: NextKind;
  name: string;
  maker: string;
  note: string;
  image_url: string;
  up: number;
  down: number;
  net: number;
  votes: number;
  mine: 1 | -1 | null;
};

export type NextBoards = {
  shelf: NextItem[];
  keg: NextItem[];
  brew: NextItem[];
};

db.exec(`
CREATE TABLE IF NOT EXISTS stock_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  board TEXT NOT NULL,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  maker TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  image_url TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS stock_requests_board ON stock_requests(board, name);
CREATE TABLE IF NOT EXISTS stock_request_votes (
  request_id INTEGER NOT NULL,
  voter_key TEXT NOT NULL,
  value INTEGER NOT NULL DEFAULT 1 CHECK(value IN (-1, 1)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (request_id, voter_key),
  FOREIGN KEY (request_id) REFERENCES stock_requests(id) ON DELETE CASCADE
);
`);

const voteColumns = db.prepare("PRAGMA table_info(stock_request_votes)").all() as Array<{ name: string }>;
if (!voteColumns.some((column) => column.name === "value")) {
  db.exec("ALTER TABLE stock_request_votes ADD COLUMN value INTEGER NOT NULL DEFAULT 1");
}

function normalizeVoter(raw: string) {
  const voter = raw.trim();
  if (!/^[A-Za-z0-9_-]{8,80}$/.test(voter)) throw new Error("Missing voter");
  return voter;
}

function asBoard(value: unknown): NextBoard {
  if (value === "shelf" || value === "keg" || value === "brew") return value;
  throw new Error("Pick a board");
}

function asKind(board: NextBoard, value: unknown): NextKind {
  if (board === "keg") return "keg";
  if (board === "brew") return "brew";
  if (value === "wines") return "wines";
  if (value === "packaged_beer") throw new Error("Beer kegs and batches are Nick's boards — guests can request liquor and wine");
  return "spirits";
}

function clip(value: unknown, max: number) {
  return String(value ?? "").trim().replace(/\s+/g, " ").slice(0, max);
}

function asMine(value: unknown): 1 | -1 | null {
  if (Number(value) === 1) return 1;
  if (Number(value) === -1) return -1;
  return null;
}

function rowToItem(row: {
  id: number;
  board: string;
  kind: string;
  name: string;
  maker: string;
  note: string;
  image_url: string;
  up_count: number | null;
  down_count: number | null;
  mine: number | null;
}): NextItem {
  const up = Number(row.up_count) || 0;
  const down = Number(row.down_count) || 0;
  return {
    id: row.id,
    board: asBoard(row.board),
    kind: row.kind as NextKind,
    name: row.name,
    maker: row.maker,
    note: row.note,
    image_url: row.image_url,
    up,
    down,
    net: up - down,
    votes: up,
    mine: asMine(row.mine)
  };
}

function listBoard(board: NextBoard, voter?: string): NextItem[] {
  let voterKey = "";
  try {
    if (voter?.trim()) voterKey = normalizeVoter(voter);
  } catch {
    voterKey = "";
  }
  const rows = db.prepare(`
    SELECT r.id, r.board, r.kind, r.name, r.maker, r.note, r.image_url,
      SUM(CASE WHEN v.value = 1 THEN 1 ELSE 0 END) AS up_count,
      SUM(CASE WHEN v.value = -1 THEN 1 ELSE 0 END) AS down_count,
      MAX(CASE WHEN v.voter_key=? THEN v.value ELSE NULL END) AS mine
    FROM stock_requests r
    LEFT JOIN stock_request_votes v ON v.request_id = r.id
    WHERE r.board=?
    GROUP BY r.id
    ORDER BY (COALESCE(SUM(CASE WHEN v.value = 1 THEN 1 ELSE 0 END),0) - COALESCE(SUM(CASE WHEN v.value = -1 THEN 1 ELSE 0 END),0)) DESC,
      COALESCE(SUM(CASE WHEN v.value = 1 THEN 1 ELSE 0 END),0) DESC,
      r.id DESC
  `).all(voterKey, board) as Array<{
    id: number; board: string; kind: string; name: string; maker: string; note: string; image_url: string;
    up_count: number | null; down_count: number | null; mine: number | null;
  }>;
  return rows.map(rowToItem);
}

export function listNextBoards(voter?: string): NextBoards {
  return {
    shelf: listBoard("shelf", voter),
    keg: listBoard("keg", voter),
    brew: listBoard("brew", voter)
  };
}

function findExisting(board: NextBoard, name: string, maker: string) {
  return db.prepare(`
    SELECT id FROM stock_requests
    WHERE board=? AND lower(name)=lower(?) AND lower(maker)=lower(?)
  `).get(board, name, maker) as { id: number } | undefined;
}

function castValue(id: number, voter: string, value: 1 | -1) {
  const existing = db.prepare(
    "SELECT value FROM stock_request_votes WHERE request_id=? AND voter_key=?"
  ).get(id, voter) as { value: number } | undefined;
  if (existing?.value === value) {
    db.prepare("DELETE FROM stock_request_votes WHERE request_id=? AND voter_key=?").run(id, voter);
  } else if (existing) {
    db.prepare("UPDATE stock_request_votes SET value=? WHERE request_id=? AND voter_key=?").run(value, id, voter);
  } else {
    db.prepare("INSERT INTO stock_request_votes(request_id, voter_key, value) VALUES(?, ?, ?)").run(id, voter, value);
  }
}

export function addNextRequest(input: {
  voter?: string;
  board?: string;
  kind?: string;
  name?: string;
  maker?: string;
  note?: string;
  image_url?: string;
}): NextBoards {
  const board = asBoard(input.board);
  const name = clip(input.name, MAX_NEXT_NAME);
  const maker = clip(input.maker, MAX_NEXT_MAKER);
  const note = clip(input.note, MAX_NEXT_NOTE);
  const image = clip(input.image_url, 500);
  if (!name) throw new Error("Add a name");
  const kind = asKind(board, input.kind);
  const existing = findExisting(board, name, maker);
  const voter = board === "shelf" ? normalizeVoter(input.voter ?? "") : (input.voter?.trim() ? normalizeVoter(input.voter) : "");
  if (existing) {
    if (board === "shelf") castValue(existing.id, voter, 1);
    return listNextBoards(voter || input.voter);
  }
  const count = Number((db.prepare("SELECT COUNT(*) AS n FROM stock_requests WHERE board=?").get(board) as { n: number }).n);
  if (count >= MAX_NEXT_PER_BOARD) throw new Error("This board is full — vote on what's already here");
  const result = db.prepare(
    "INSERT INTO stock_requests(board,kind,name,maker,note,image_url) VALUES(?,?,?,?,?,?)"
  ).run(board, kind, name, maker, note, image);
  if (board === "shelf") castValue(Number(result.lastInsertRowid), voter, 1);
  return listNextBoards(voter || input.voter);
}

export function voteNextRequest(id: number, voterRaw: string, value?: number): NextBoards {
  const voter = normalizeVoter(voterRaw);
  const n = Math.floor(Number(id));
  if (!Number.isInteger(n) || n < 1) throw new Error("Request not found");
  const row = db.prepare("SELECT id, board FROM stock_requests WHERE id=?").get(n) as { id: number; board: string } | undefined;
  if (!row) throw new Error("Request not found");
  if (row.board === "shelf") {
    castValue(n, voter, 1);
    return listNextBoards(voter);
  }
  if (value !== 1 && value !== -1) throw new Error("Vote must be up or down");
  castValue(n, voter, value);
  return listNextBoards(voter);
}

export function deleteNextRequest(id: number): boolean {
  const n = Math.floor(Number(id));
  if (!Number.isInteger(n) || n < 1) return false;
  db.prepare("DELETE FROM stock_request_votes WHERE request_id=?").run(n);
  return db.prepare("DELETE FROM stock_requests WHERE id=?").run(n).changes > 0;
}
