import { useEffect, useState } from "react";
import { ChevronDown, ChevronUp } from "lucide-react";
import { api } from "./api";

export type VoteTally = {
  up: number;
  down: number;
  net: number;
  total: number;
  score: number | null;
  mine: 1 | -1 | null;
};

const VOTER_KEY = "smokey-voter";

export function voterId() {
  let id = localStorage.getItem(VOTER_KEY);
  if (!id) {
    id = (crypto.randomUUID?.() ?? `voter-${Math.random().toString(36).slice(2, 12)}`).replaceAll("-", "");
    localStorage.setItem(VOTER_KEY, id);
  }
  return id;
}

export function scoreLabel(score: number | null | undefined, total?: number) {
  if (score == null || !total) return null;
  return `${score}/10`;
}

export function BottleVotes({ table, itemId }: { table: string; itemId: number }) {
  const [tally, setTally] = useState<VoteTally>();
  const [error, setError] = useState("");
  const voter = voterId();

  function load() {
    return api<VoteTally>(`/inventory/${table}/${itemId}/votes?voter=${encodeURIComponent(voter)}`)
      .then(setTally)
      .catch((err) => setError(err instanceof Error ? err.message : "Could not load votes"));
  }

  useEffect(() => { setError(""); void load(); }, [table, itemId]);

  async function vote(value: 1 | -1) {
    setError("");
    try {
      const next = await api<VoteTally>(`/inventory/${table}/${itemId}/votes`, {
        method: "POST",
        body: JSON.stringify({ voter, value })
      });
      setTally(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save vote");
    }
  }

  const label = scoreLabel(tally?.score, tally?.total) ?? "–/10";

  return (
    <div className="vote-box">
      <button type="button" className={`vote-button${tally?.mine === 1 ? " active" : ""}`} aria-label="Upvote" aria-pressed={tally?.mine === 1} onClick={() => void vote(1)}>
        <ChevronUp size={28}/>
      </button>
      <div className="vote-score">
        <strong>{label}</strong>
        <small>{tally?.total ? `${tally.total} vote${tally.total === 1 ? "" : "s"}` : "No votes yet"}</small>
      </div>
      <button type="button" className={`vote-button down${tally?.mine === -1 ? " active" : ""}`} aria-label="Downvote" aria-pressed={tally?.mine === -1} onClick={() => void vote(-1)}>
        <ChevronDown size={28}/>
      </button>
      {error ? <p className="error">{error}</p> : null}
    </div>
  );
}
