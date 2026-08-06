"use client";

// Admin case-export control (Story 7.2, FR-7.2, AC1/AC2/AC6). Sits beside the FilterBar on the
// case list and exports the CURRENT filter selection in full — deliberately NOT the current
// page, so `page`/`limit`/`sort`/`dir` are never forwarded.
//
// Localized from day one (Epic 6 obligation): every string resolves from admin.export.*.
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { getAccessToken } from "@/lib/auth";
import { downloadExport, type ExportFormat } from "@/lib/adminExport";
import type { AdminCaseFilters } from "@/components/admin/FilterBar";

interface ExportButtonProps {
  filters: AdminCaseFilters;
  count: number;
  disabled?: boolean;
}

export function ExportButton({ filters, count, disabled = false }: ExportButtonProps) {
  const t = useTranslations("admin");
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Close the menu on an outside click / Escape — a bare dropdown that can only be dismissed
  // by picking an option is a keyboard and pointer trap.
  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: MouseEvent) {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  async function handleExport(format: ExportFormat) {
    setOpen(false);
    // In-flight guard: a double-click must not fire two exports (each one writes its own
    // admin_exported_cases audit row and re-runs the whole unpaginated query).
    if (busy) return;
    setBusy(true);
    setFailed(false);

    try {
      const token = await getAccessToken();
      if (!token) {
        // Must not `return` while still busy — Story 5.5 shipped exactly that defect and left
        // its button stuck on "Submitting…" forever.
        if (mountedRef.current) setFailed(true);
        return;
      }

      const result = await downloadExport(token, format, filters);
      if (!mountedRef.current) return;
      if (result === "unauthorized") {
        // Session genuinely expired — retrying replays the same failing request. Matches the
        // case list page's own handling.
        router.replace("/admin/login");
        return;
      }
      if (result === "error") setFailed(true);
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  }

  return (
    <div className="relative" ref={containerRef}>
      <button
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        disabled={disabled || busy}
        aria-haspopup="menu"
        aria-expanded={open}
        className="min-h-touch-target rounded-md border border-forest px-design-4 text-label font-semibold text-forest disabled:opacity-40"
      >
        {busy ? t("export.exporting") : t("export.button", { count })}
      </button>

      {open && (
        <div
          role="menu"
          aria-label={t("export.menuAria")}
          className="absolute right-0 top-full z-50 mt-design-1 rounded-md border border-border-default bg-surface-raised shadow-lg"
        >
          <button
            type="button"
            role="menuitem"
            onClick={() => handleExport("csv")}
            className="block w-full min-h-touch-target px-design-4 text-left text-label text-ink-primary hover:bg-surface-tint"
          >
            {t("export.csv")}
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => handleExport("pdf")}
            className="block w-full min-h-touch-target px-design-4 text-left text-label text-ink-primary hover:bg-surface-tint"
          >
            {t("export.pdf")}
          </button>
        </div>
      )}

      {failed && (
        <p role="alert" className="mt-design-1 text-caption text-status-error">
          {t("export.error")}
        </p>
      )}
    </div>
  );
}
