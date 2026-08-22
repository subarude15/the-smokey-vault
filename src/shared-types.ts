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

export const DEFAULT_KEEPER_NAME = "Nick";
export const MAX_KEEPER_NAME = 24;

export function clipKeeperName(value: unknown): string {
  const name = String(value ?? "").trim().replace(/\s+/g, " ").slice(0, MAX_KEEPER_NAME);
  return name || DEFAULT_KEEPER_NAME;
}

export {
  type RestockKind,
  type WantedLabel,
  type WantedRow,
  type RestockThresholds,
  type RestockItem,
  MAX_WANTED_NAME,
  MAX_WANTED_NOTE,
  DEFAULT_RESTOCK_THRESHOLDS,
  RESTOCK_PACKAGED_STOPS,
  RESTOCK_WINE_STOPS,
  RESTOCK_SPIRIT_STOPS,
  parseRestockThresholds,
  formatRestockShare
} from "./restock-shared.js";
