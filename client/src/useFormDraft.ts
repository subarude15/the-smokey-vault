import { useCallback, useEffect, useRef, useState } from "react";

const PREFIX = "smokey-draft:";

export type FormDraft = Record<string, unknown>;

function draftKey(scope: string) {
  return `${PREFIX}${scope}`;
}

export function readDraft(scope: string): FormDraft | undefined {
  try {
    const raw = localStorage.getItem(draftKey(scope));
    if (!raw) return undefined;
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    return parsed as FormDraft;
  } catch {
    return undefined;
  }
}

export function clearDraft(scope: string) {
  try {
    localStorage.removeItem(draftKey(scope));
  } catch {
    // Private browsing or a full quota; drafts are a convenience, not a requirement.
  }
}

/**
 * Mirrors an in-progress form into localStorage so a kiosk lock, refresh, or
 * accidental close does not lose typing. Returns any draft found on mount so the
 * caller can offer to restore it instead of silently overwriting the form.
 */
export function useFormDraft(scope: string, values: FormDraft, enabled = true) {
  const [recovered, setRecovered] = useState<FormDraft | undefined>(() => (enabled ? readDraft(scope) : undefined));
  // Snapshot of the untouched form, so opening and closing a form leaves no draft behind.
  const pristine = useRef(JSON.stringify(values));

  useEffect(() => {
    if (!enabled) return;
    const serialized = JSON.stringify(values);
    if (serialized === pristine.current) return;
    const timer = window.setTimeout(() => {
      try {
        localStorage.setItem(draftKey(scope), serialized);
      } catch {
        // Private browsing or a full quota; drafts are a convenience, not a requirement.
      }
    }, 400);
    return () => clearTimeout(timer);
  }, [scope, values, enabled]);

  const discard = useCallback(() => {
    setRecovered(undefined);
    clearDraft(scope);
  }, [scope]);

  const dismiss = useCallback(() => setRecovered(undefined), []);

  const commit = useCallback(() => clearDraft(scope), [scope]);

  return { recovered, discard, dismiss, commit };
}
