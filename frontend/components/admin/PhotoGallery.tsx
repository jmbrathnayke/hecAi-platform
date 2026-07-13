// Damage-photo section (Story 5.4, AC1). Placeholder-only by PO decision (2026-07-13): no
// photo-upload pipeline exists anywhere in the backend today — photos are captured into the
// submitting device's own IndexedDB `photo_blobs` store (lib/indexeddb.ts) and never reach
// the server on any path (verified against buildCasePayload in lib/poc.ts and the as-built
// endpoint list in architecture.md). Kept as its own component, not inlined, so a future
// photo-upload story has a single obvious seam to replace — see
// _bmad-output/implementation-artifacts/deferred-work.md for that story's scope.
export function PhotoGallery() {
  return (
    <div className="rounded-md border border-dashed border-border-default p-design-4 text-body text-ink-disabled">
      Photos captured on the submitting device are not yet centrally stored — see
      deferred-work.md for the photo-upload pipeline this needs.
    </div>
  );
}
