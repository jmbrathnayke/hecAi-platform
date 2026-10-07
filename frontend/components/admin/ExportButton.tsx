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
import { DownloadSimple, FileCsv, FilePdf } from "@phosphor-icons/react";
import { buttonStyles } from "@/components/admin/ui";

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
  const [failed, setFailed] = useState<null | "error" | "timeout">(null);
  const [truncated, setTruncated] = useState<number | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const mountedRef = useRef(true);
  // The in-flight guard reads a REF, not the `busy` state (code review finding): state is
  // read through a closure, so two menu-item clicks dispatched in the same React batch both
  // observe busy === false and both fire — two full unpaginated queries and two audit rows.
  // A ref is updated synchronously and is therefore actually a mutex.
  const busyRef = useRef(false);

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
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setFailed(null);
    setTruncated(null);

    try {
      const token = await getAccessToken();
      if (!token) {
        // Must not `return` while still busy — Story 5.5 shipped exactly that defect and left
        // its button stuck on "Submitting…" forever.
        if (mountedRef.current) setFailed("error");
        return;
      }

      const result = await downloadExport(token, format, filters);
      if (!mountedRef.current) return;
      if (result.status === "unauthorized") {
        // Session genuinely expired — retrying replays the same failing request. Matches the
        // case list page's own handling.
        router.replace("/admin/login");
        return;
      }
      if (result.status === "error") setFailed("error");
      else if (result.status === "timeout") setFailed("timeout");
      else if (result.truncated) setTruncated(result.rowCount ?? null);
    } finally {
      busyRef.current = false;
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
        className={buttonStyles.secondary}
      >
        <DownloadSimple aria-hidden="true" size={16} />
        {busy ? t("export.exporting") : t("export.button", { count })}
      </button>

      {open && (
        <div
          role="menu"
          aria-label={t("export.menuAria")}
          className="absolute right-0 top-full z-50 mt-design-1 min-w-[12rem] overflow-hidden rounded-sm border border-border-subtle bg-surface-raised p-1 shadow-overlay"
        >
          <button
            type="button"
            role="menuitem"
            onClick={() => handleExport("csv")}
            className="flex min-h-[40px] w-full items-center gap-design-2 rounded-[6px] px-design-3 text-left text-label text-ink-primary transition-colors hover:bg-surface-tint"
          >
            <FileCsv aria-hidden="true" size={18} className="text-ink-secondary" />
            {t("export.csv")}
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => handleExport("pdf")}
            className="flex min-h-[40px] w-full items-center gap-design-2 rounded-[6px] px-design-3 text-left text-label text-ink-primary transition-colors hover:bg-surface-tint"
          >
            <FilePdf aria-hidden="true" size={18} className="text-ink-secondary" />
            {t("export.pdf")}
          </button>
        </div>
      )}

      {failed && (
        <p role="alert" className="mt-design-1 text-caption text-status-error">
          {failed === "timeout" ? t("export.timeout") : t("export.error")}
        </p>
      )}

      {/* Truncation must reach the person holding the file (code review finding, raised by all
          three review layers): it was previously signalled only in the audit log, which the
          admin cannot see. A capped PDF otherwise presents a partial total as authoritative. */}
      {truncated !== null && (
        <p role="status" className="mt-design-1 text-caption text-status-warning">
          {t("export.truncated", { count: truncated ?? 0 })}
        </p>
      )}
    </div>
  );
}
