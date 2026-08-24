import { useEffect, useState, type FormEvent } from "react";
import { MessageSquare, Trash2 } from "lucide-react";
import { api } from "./api";

export type GuestReview = {
  id: number;
  author: string;
  body: string;
  created_at: string;
};

const NAME_KEY = "smokey-reviewer";

function formatWhen(value: string) {
  const date = new Date(value.includes("T") ? value : `${value.replace(" ", "T")}Z`);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

export function GuestReviews({ table, itemId, admin }: { table: string; itemId: number; admin: boolean }) {
  const [reviews, setReviews] = useState<GuestReview[]>([]);
  const [author, setAuthor] = useState(() => localStorage.getItem(NAME_KEY) ?? "");
  const [body, setBody] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  function load() {
    return api<GuestReview[]>(`/inventory/${table}/${itemId}/reviews`)
      .then(setReviews)
      .catch((err) => setError(err instanceof Error ? err.message : "Could not load reviews"));
  }

  useEffect(() => { setError(""); void load(); }, [table, itemId]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const review = await api<GuestReview>(`/inventory/${table}/${itemId}/reviews`, {
        method: "POST",
        body: JSON.stringify({ author, body })
      });
      localStorage.setItem(NAME_KEY, author.trim());
      setBody("");
      setReviews((current) => [review, ...current]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not post review");
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: number) {
    if (!confirm("Remove this guest review?")) return;
    try {
      await api(`/reviews/${id}`, { method: "DELETE" });
      setReviews((current) => current.filter((review) => review.id !== id));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not delete review");
    }
  }

  return (
    <section className="guest-reviews">
      <div className="section-heading">
        <div>
          <span className="eyebrow">GUEST NOTES</span>
          <h2>What did you think?</h2>
        </div>
        <span className="guest-badge"><MessageSquare size={14}/> {reviews.length}</span>
      </div>
      <form className="review-form" onSubmit={submit}>
        <label>
          <span>Your name</span>
          <input value={author} onChange={(event) => setAuthor(event.target.value)} maxLength={40} placeholder="Sam" autoComplete="nickname"/>
        </label>
        <label className="full">
          <span>Review</span>
          <textarea value={body} onChange={(event) => setBody(event.target.value)} maxLength={2000} placeholder="Bright orange peel, sticky malt, cellar favorite…"/>
        </label>
        <button className="primary" disabled={busy || !author.trim() || !body.trim()}>Post review</button>
      </form>
      {error ? <p className="error">{error}</p> : null}
      {!reviews.length ? <p className="review-empty">No guest notes yet. Be the first pour on the record.</p> : (
        <ul className="review-list">
          {reviews.map((review) => (
            <li key={review.id} className="review-card">
              <div>
                <strong>{review.author}</strong>
                <small>{formatWhen(review.created_at)}</small>
                <p>{review.body}</p>
              </div>
              {admin ? <button type="button" className="icon-button danger" aria-label={`Delete review from ${review.author}`} onClick={() => void remove(review.id)}><Trash2 size={16}/></button> : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
