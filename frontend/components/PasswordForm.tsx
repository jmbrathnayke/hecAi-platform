"use client";
// Set or change the signed-in account's own password — the same form for a citizen and for staff.
// Hidden for an account that has no password to change (Google-only staff).
import { useState } from "react";
import { useTranslations } from "next-intl";
import { changeOwnPassword, MIN_PASSWORD_LENGTH } from "@/lib/password";

const FIELD =
  "min-h-touch-target w-full rounded-md border border-border-default bg-surface-raised px-design-3 text-body text-ink-primary focus:border-border-focus focus:outline-none";

export function PasswordForm({ onDone }: { onDone: () => void }) {
  const t = useTranslations("password");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [changed, setChanged] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (saving) return;
    setError(null);
    if (password.length < MIN_PASSWORD_LENGTH) {
      setError(t("passwordTooShort"));
      return;
    }
    if (password !== confirm) {
      setError(t("passwordMismatch"));
      return;
    }
    setSaving(true);
    const result = await changeOwnPassword(password);
    setSaving(false);
    if (result === "ok") {
      setPassword("");
      setConfirm("");
      setChanged(true);
    } else {
      setError(t("passwordError"));
    }
  }

  if (changed) {
    return (
      <div className="flex flex-col gap-design-2">
        <p role="status" className="rounded-md bg-forest-pale px-design-3 py-design-2 text-caption text-forest">
          {t("passwordChanged")}
        </p>
        <button
          type="button"
          onClick={onDone}
          className="min-h-touch-target rounded-md border border-border-default px-design-3 text-label font-medium text-ink-secondary"
        >
          {t("close")}
        </button>
      </div>
    );
  }

  return (
    <form data-testid="password-form" onSubmit={(e) => void handleSubmit(e)} className="flex flex-col gap-design-3" noValidate>
      <div className="flex flex-col gap-design-1">
        <label htmlFor="staff-new-password" className="text-caption font-medium text-ink-primary">
          {t("newPassword")}
        </label>
        <input
          id="staff-new-password"
          type="password"
          autoComplete="new-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className={FIELD}
        />
      </div>
      <div className="flex flex-col gap-design-1">
        <label htmlFor="staff-confirm-password" className="text-caption font-medium text-ink-primary">
          {t("confirmPassword")}
        </label>
        <input
          id="staff-confirm-password"
          type="password"
          autoComplete="new-password"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          className={FIELD}
        />
      </div>
      {error && (
        <p role="alert" className="text-caption text-status-error">
          {error}
        </p>
      )}
      <div className="flex gap-design-2">
        <button
          type="submit"
          disabled={saving}
          className="min-h-touch-target flex-1 rounded-md bg-forest px-design-3 text-label font-semibold text-ink-on-dark disabled:opacity-60"
        >
          {saving ? t("saving") : t("save")}
        </button>
        <button
          type="button"
          onClick={onDone}
          disabled={saving}
          className="min-h-touch-target flex-1 rounded-md border border-border-default px-design-3 text-label font-medium text-ink-secondary"
        >
          {t("cancel")}
        </button>
      </div>
    </form>
  );
}
