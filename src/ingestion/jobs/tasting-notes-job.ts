/**
 * Run one tasting-notes enrichment job against a saved inventory entity.
 * Does not mutate identity fields or personal notes / tasting_notes columns.
 */
import { planEnrichment } from "../enrichment/index.js";
import {
  executeTastingNotesEnrichment,
  type TastingNotesEnrichmentDeps,
  type TastingNotesExecutionResult
} from "../enrichment/execute-tasting-notes.js";
import { candidateFromInventoryRow, loadInventoryRow } from "./inventory.js";
import {
  getProductContent,
  readPersonalNotes,
  upsertProductContent
} from "./product-content.js";
import type { EnrichmentJob } from "./types.js";

export type TastingNotesJobResult = {
  skipped: boolean;
  reason?: string;
  execution?: TastingNotesExecutionResult;
  officialSaved: boolean;
  houseSaved: boolean;
  /** Snapshot of personal notes — must remain unchanged by this job. */
  personalNotes: string | null;
};

export async function runTastingNotesJob(
  job: EnrichmentJob,
  deps: TastingNotesEnrichmentDeps = {}
): Promise<TastingNotesJobResult> {
  const row = loadInventoryRow(job.entity_type, job.entity_id);
  if (!row) {
    throw new Error(`Inventory ${job.entity_type}#${job.entity_id} not found`);
  }

  const personalNotes = readPersonalNotes(row);
  const before = candidateFromInventoryRow(job.entity_type, row);
  const plan = planEnrichment(before);

  if (!plan.identified) {
    return { skipped: true, reason: "not_identified", officialSaved: false, houseSaved: false, personalNotes };
  }
  if (plan.needsReview) {
    return { skipped: true, reason: "needs_review", officialSaved: false, houseSaved: false, personalNotes };
  }

  const existing = getProductContent(job.entity_type, job.entity_id);
  const wantOfficial = !existing?.official_tasting_notes;
  const wantHouseProfile = !existing?.house_tasting_profile;

  if (!wantOfficial && !wantHouseProfile) {
    return { skipped: true, reason: "already_complete", officialSaved: false, houseSaved: false, personalNotes };
  }

  const execution = await executeTastingNotesEnrichment(before, deps, {
    wantOfficial,
    wantHouseProfile
  });

  // Transient failures with zero saved progress should retry.
  // "No authoritative source" (no errors, null official) is a successful completion.
  if (execution.errors.length > 0 && !execution.officialNotes && !execution.houseProfile) {
    throw new Error(execution.errors.join("; ") || "tasting-notes enrichment failed");
  }

  const beforeOfficial = existing?.official_tasting_notes ?? null;
  const beforeHouse = existing?.house_tasting_profile ?? null;

  upsertProductContent({
    entityType: job.entity_type,
    entityId: job.entity_id,
    officialNotes: execution.officialNotes,
    officialSourceUrl: execution.officialSourceUrl,
    officialSourceType: execution.officialSourceType,
    houseProfile: execution.houseProfile
  });

  const after = getProductContent(job.entity_type, job.entity_id);
  const officialSaved = Boolean(after?.official_tasting_notes && after.official_tasting_notes !== beforeOfficial);
  const houseSaved = Boolean(after?.house_tasting_profile && after.house_tasting_profile !== beforeHouse);

  // Verify personal inventory notes untouched.
  const rowAfter = loadInventoryRow(job.entity_type, job.entity_id)!;
  const personalAfter = readPersonalNotes(rowAfter);
  if (personalAfter !== personalNotes) {
    throw new Error("Tasting-note job mutated personal notes — aborting");
  }

  return {
    skipped: false,
    execution,
    officialSaved,
    houseSaved,
    personalNotes
  };
}
