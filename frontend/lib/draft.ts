// Draft-id management for the multi-step incident form. The id is carried between
// steps via sessionStorage, with safe fallbacks for environments where storage
// throws (private mode, blocked site data, some webviews).
import { uuidv4 } from "@/lib/uuid";

const DRAFT_ID_KEY = "hec-draft-id";

// Used only when sessionStorage is unavailable; keeps the flow working within a page.
let memoryDraftId: string | null = null;

function safeGet(): string | null {
  try {
    return sessionStorage.getItem(DRAFT_ID_KEY) ?? memoryDraftId;
  } catch {
    return memoryDraftId;
  }
}

function safeSet(id: string): void {
  memoryDraftId = id;
  try {
    sessionStorage.setItem(DRAFT_ID_KEY, id);
  } catch {
    // storage unavailable — memoryDraftId still carries the id within this page
  }
}

/** Returns the current draft id, or null if none has been created yet. */
export function getDraftId(): string | null {
  return safeGet();
}

/** Returns the current draft id, creating and persisting one if absent. */
export function getOrCreateDraftId(): string {
  const existing = safeGet();
  if (existing) return existing;
  const id = uuidv4();
  safeSet(id);
  return id;
}
