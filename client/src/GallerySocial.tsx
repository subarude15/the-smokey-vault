import { useEffect, useState, type FormEvent } from "react";
import { ChevronDown, ChevronUp, MessageSquare, Send, Trash2 } from "lucide-react";
import { api } from "./api";
import { voterId } from "./BottleVotes";

const MAX_COMMENT = 500;
const MAX_AUTHOR = 40;
const NAME_KEY = "smokey-reviewer";

export type GalleryVoteTally = {
  up: number;
  down: number;
  net: number;
  total: number;
  mine: 1 | -1 | null;
};

export type GalleryComment = {
  id: number;
  media_id: number;
  author: string;
  body: string;
  created_at: string;
};

type GallerySocialState = {
  votes: GalleryVoteTally;
  comments: GalleryComment[];
};

function formatWhen(value: string) {
  const date = new Date(value.includes("T") ? value : `${value.replace(" ", "T")}Z`);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

/**
 * Compact social section for the Gallery lightbox: up/down voting with counts,
 * a comments list, and a lightweight comment form. Keeper mode adds a per-comment
 * remove control. The server is authoritative for counts, validation, and
 * duplicate-vote prevention; this only reflects returned state.
 */
export function GallerySocial({ mediaId, admin }: { mediaId: number; admin: boolean }) {
  const [state, setState] = useState<GallerySocialState>();
  const [author, setAuthor] = useState(() => localStorage.getItem(NAME_KEY) ?? "");
  const [body, setBody] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [voting, setVoting] = useState(false);
  const [posting, setPosting] = useState(false);
  const voter = voterId();

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError("");
    api<GallerySocialState>(`/gallery/${mediaId}/social?voter=${encodeURIComponent(voter)}`)
      .then((data) => { if (!cancelled) setState(data); })
      .catch((err) => { if (!cancelled) setError(err instanceof Error ? err.message : "Could not load reactions"); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [mediaId, voter]);

  async function vote(value: 1 | -1) {
    if (voting) return;
    setVoting(true);
    setError("");
    try {
      const votes = await api<GalleryVoteTally>(`/gallery/${mediaId}/vote`, {
        method: "POST",
        body: JSON.stringify({ voter, value })
      });
      setState((current) => ({ votes, comments: current?.comments ?? [] }));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save that vote");
    } finally {
      setVoting(false);
    }
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (posting || !body.trim()) return;
    setPosting(true);
    setError("");
    try {
      const comment = await api<GalleryComment>(`/gallery/${mediaId}/comments`, {
        method: "POST",
        body: JSON.stringify({ voter, author, body })
      });
      if (author.trim()) localStorage.setItem(NAME_KEY, author.trim());
      setBody("");
      setState((current) => ({
        votes: current?.votes ?? { up: 0, down: 0, net: 0, total: 0, mine: null },
        comments: [...(current?.comments ?? []), comment]
      }));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not post that comment");
    } finally {
      setPosting(false);
    }
  }

  async function remove(id: number) {
    if (!confirm("Remove this comment?")) return;
    setError("");
    try {
      await api(`/gallery/${mediaId}/comments/${id}`, { method: "DELETE" });
      setState((current) => current
        ? { ...current, comments: current.comments.filter((comment) => comment.id !== id) }
        : current);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not remove that comment");
    }
  }

  const votes = state?.votes;
  const comments = state?.comments ?? [];

  return (
    <section className="gallery-social" aria-label="Reactions and comments">
      <div className="gallery-social-votes">
        <button
          type="button"
          className={`vote-button${votes?.mine === 1 ? " active" : ""}`}
          aria-label="Up-vote this photo"
          aria-pressed={votes?.mine === 1}
          disabled={voting || loading}
          onClick={() => void vote(1)}
        >
          <ChevronUp size={22}/>
          <span className="gallery-social-count">{votes?.up ?? 0}</span>
        </button>
        <button
          type="button"
          className={`vote-button down${votes?.mine === -1 ? " active" : ""}`}
          aria-label="Down-vote this photo"
          aria-pressed={votes?.mine === -1}
          disabled={voting || loading}
          onClick={() => void vote(-1)}
        >
          <ChevronDown size={22}/>
          <span className="gallery-social-count">{votes?.down ?? 0}</span>
        </button>
        <span className="gallery-social-comment-count">
          <MessageSquare size={15}/> {comments.length}
        </span>
      </div>

      <div className="gallery-social-comments">
        {loading ? (
          <p className="gallery-social-muted">Loading…</p>
        ) : comments.length === 0 ? (
          <p className="gallery-social-muted">No comments yet. Say something nice.</p>
        ) : (
          <ul className="gallery-social-list">
            {comments.map((comment) => (
              <li key={comment.id} className="gallery-social-item">
                <div className="gallery-social-item-text">
                  <strong>{comment.author}</strong>
                  <small>{formatWhen(comment.created_at)}</small>
                  <p>{comment.body}</p>
                </div>
                {admin ? (
                  <button
                    type="button"
                    className="icon-button danger"
                    aria-label={`Delete comment from ${comment.author}`}
                    onClick={() => void remove(comment.id)}
                  >
                    <Trash2 size={15}/>
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </div>

      <form className="gallery-social-form" onSubmit={(event) => void submit(event)}>
        <input
          className="gallery-social-author"
          value={author}
          maxLength={MAX_AUTHOR}
          disabled={posting}
          autoComplete="nickname"
          onChange={(event) => setAuthor(event.target.value)}
          placeholder="Your name (optional)"
          aria-label="Your name"
        />
        <div className="gallery-social-send">
          <textarea
            value={body}
            maxLength={MAX_COMMENT}
            disabled={posting}
            rows={1}
            onChange={(event) => setBody(event.target.value)}
            placeholder="Add a comment…"
            aria-label="Add a comment"
          />
          <button
            type="submit"
            className="primary gallery-social-submit"
            disabled={posting || !body.trim()}
            aria-label="Send comment"
          >
            <Send size={16}/>
          </button>
        </div>
      </form>

      {error ? <p className="error" role="alert">{error}</p> : null}
    </section>
  );
}
