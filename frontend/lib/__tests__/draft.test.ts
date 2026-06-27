import { getDraftId, getOrCreateDraftId } from "@/lib/draft";

describe("draft id", () => {
  beforeEach(() => {
    try { sessionStorage.clear(); } catch {}
  });

  it("creates, persists, and returns a stable draft id", () => {
    const id = getOrCreateDraftId();
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    expect(getDraftId()).toBe(id); // persisted
    expect(getOrCreateDraftId()).toBe(id); // idempotent
  });
});
