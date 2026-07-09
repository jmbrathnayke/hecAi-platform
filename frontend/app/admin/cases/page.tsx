"use client";

// Admin case list — PLACEHOLDER (Story 5.1). The real district-scoped case list dashboard is
// Story 5.3's deliverable. This minimal shell exists only so the login → redirect → middleware-
// gate flow (Task 1 / Task 2) has a real protected page to land on and can be verified end-to-end,
// mirroring the Story 3.2 officer-dashboard placeholder precedent (see deferred-work.md). Do NOT
// build real case-list UI here — that pre-empts Story 5.3's design.
//
// Client-side role gate (code review 2026-07-09, patch): the middleware only checks session
// PRESENCE, and the Google OAuth login path can't check role synchronously (no user object is
// returned on redirect-initiate) — so this page independently re-verifies role === "admin" via
// getUser() (server-revalidated, per CRITICAL #2) and signs out + redirects non-admins, mirroring
// the password login path's CRITICAL #4 behavior. This is an auth guard, not case-list UI.
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase";

export default function AdminCasesPlaceholderPage() {
  const router = useRouter();
  const [checked, setChecked] = useState(false);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    const supabase = createClient();

    (async () => {
      let isAdmin = false;
      try {
        const { data, error } = await supabase.auth.getUser();
        isAdmin = !error && data.user?.user_metadata?.role === "admin";
      } catch {
        isAdmin = false;
      }
      if (!mountedRef.current) return;

      if (!isAdmin) {
        try {
          await supabase.auth.signOut();
        } catch {
          // Even if sign-out fails, we still refuse entry below.
        }
        if (mountedRef.current) router.replace("/admin/login");
        return;
      }
      setChecked(true);
    })();

    return () => {
      mountedRef.current = false;
    };
  }, [router]);

  if (!checked) return null;

  return (
    <main className="min-h-screen bg-surface-base px-design-4 py-design-6">
      <h1 className="text-title text-ink-primary">Admin — Case List</h1>
      <p className="text-body text-ink-secondary mt-design-3">Case list coming in Story 5.3.</p>
    </main>
  );
}
