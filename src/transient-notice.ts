/** Shared transient-notice timing (used by client toast hook + tests). */

export const TRANSIENT_NOTICE_MS = 5000;
export const TRANSIENT_ERROR_NOTICE_MS = 12_000;

export function looksLikeErrorNotice(message: string): boolean {
  const text = String(message ?? "").trim();
  if (!text) return false;
  return /^(could not|failed|error|unable|export failed)/i.test(text)
    || /\bfail(ed|ure)?\b/i.test(text);
}

export type TransientNoticeController = {
  get: () => string;
  set: (value: string) => void;
  clear: () => void;
  dispose: () => void;
};

/**
 * Timer-backed notice controller: success/info auto-dismiss, errors stay longer,
 * each set() resets the timer, dispose() clears on unmount.
 */
export function createTransientNoticeController(options?: {
  successMs?: number;
  errorMs?: number;
  now?: () => number;
  schedule?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  cancel?: (id: ReturnType<typeof setTimeout>) => void;
  onChange?: (value: string) => void;
}): TransientNoticeController {
  const successMs = options?.successMs ?? TRANSIENT_NOTICE_MS;
  const errorMs = options?.errorMs ?? TRANSIENT_ERROR_NOTICE_MS;
  const schedule = options?.schedule ?? setTimeout;
  const cancel = options?.cancel ?? clearTimeout;
  const onChange = options?.onChange;

  let value = "";
  let timer: ReturnType<typeof setTimeout> | null = null;

  const clearTimer = () => {
    if (timer != null) {
      cancel(timer as ReturnType<typeof setTimeout>);
      timer = null;
    }
  };

  const publish = (next: string) => {
    value = next;
    onChange?.(next);
  };

  return {
    get: () => value,
    set(nextRaw: string) {
      clearTimer();
      const next = String(nextRaw ?? "");
      publish(next);
      if (!next.trim()) return;
      const delay = looksLikeErrorNotice(next) ? errorMs : successMs;
      timer = schedule(() => {
        timer = null;
        publish("");
      }, delay) as ReturnType<typeof setTimeout>;
    },
    clear() {
      clearTimer();
      publish("");
    },
    dispose() {
      clearTimer();
    }
  };
}
