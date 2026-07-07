import { getDraftId, getOrCreateDraftId, clearDraftId } from "@/lib/draft";

describe("draft id", () => {
  beforeEach(() => {
    try { sessionStorage.clear(); } catch {}
    clearDraftId(); // also reset the in-memory fallback between tests
  });

  it("creates, persists, and returns a stable draft id", () => {
    const id = getOrCreateDraftId();
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    expect(getDraftId()).toBe(id); // persisted
    expect(getOrCreateDraftId()).toBe(id); // idempotent
  });

  it("clearDraftId() clears sessionStorage and the memory fallback (Story 3.5)", () => {
    const id = getOrCreateDraftId();
    expect(getDraftId()).toBe(id);

    clearDraftId();

    expect(sessionStorage.getItem("hec-draft-id")).toBeNull();
    expect(getDraftId()).toBeNull(); // memory fallback reset too
    // a subsequent create mints a fresh, different id
    expect(getOrCreateDraftId()).not.toBe(id);
  });

  it("clearDraftId() clears the memory fallback even when sessionStorage throws", () => {
    const original = Object.getOwnPropertyDescriptor(window, "sessionStorage");
    // Force every sessionStorage access to throw so only the memory fallback carries the id.
    Object.defineProperty(window, "sessionStorage", {
      configurable: true,
      get() {
        throw new Error("storage blocked");
      },
    });
    try {
      const id = getOrCreateDraftId(); // stored in memoryDraftId only
      expect(getDraftId()).toBe(id);
      clearDraftId();
      expect(getDraftId()).toBeNull();
    } finally {
      if (original) Object.defineProperty(window, "sessionStorage", original);
    }
  });
});
