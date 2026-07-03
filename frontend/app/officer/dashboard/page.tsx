// Story 3.1 (login redirect target) and Story 3.2 (AI model precache mount point) both assume
// this route exists, but no story in Epic 3's roadmap creates it as its own deliverable — this
// is a minimal shell, not the officer case-list/dashboard UI (that's a future, unscoped story;
// see implementation-artifacts/deferred-work.md).
import { ModelLoadStatus } from "@/components/ModelLoadStatus";

export default function OfficerDashboardPage() {
  return (
    <main className="min-h-screen bg-surface-base px-design-4 py-design-6">
      <div className="max-w-2xl mx-auto space-y-design-4">
        <h1 className="text-title text-ink-primary">Officer Portal</h1>
        <ModelLoadStatus />
      </div>
    </main>
  );
}
