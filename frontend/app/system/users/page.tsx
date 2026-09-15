"use client";

// Staff account management (FR-11) — the System Administrator's surface.
//
// This screen assigns authority, so its failure states are as much of the design as its happy
// path. Every refusal the API can return is rendered as a distinct message: "you may not do this",
// "the server has no service key", "that address already exists", "that district does not exist"
// and "you cannot demote yourself" send the administrator to five different places, and collapsing
// them into one banner would leave the real cause visible only in DevTools.
//
// The temporary password appears once, after creation, and is never persisted anywhere — not in
// state that outlives the banner, not in storage, not in a log.

import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import {
  createStaff,
  deleteStaff,
  describeScope,
  listStaff,
  updateStaff,
  type DivisionRef,
  type StaffRole,
  type StaffUser,
} from "@/lib/systemUsers";

const ROLES: StaffRole[] = ["officer", "admin", "ds_officer", "system_admin"];

type Banner = { kind: "error" | "success"; text: string } | null;

export default function SystemUsersPage() {
  const t = useTranslations("system");
  const [users, setUsers] = useState<StaffUser[]>([]);
  const [districts, setDistricts] = useState<string[]>([]);
  const [divisions, setDivisions] = useState<DivisionRef[]>([]);
  const [state, setState] = useState<"loading" | "ready" | "forbidden" | "unavailable" | "error">(
    "loading",
  );
  const [banner, setBanner] = useState<Banner>(null);
  const [tempPassword, setTempPassword] = useState<{ email: string; password: string } | null>(null);
  const [busy, setBusy] = useState(false);

  // Form
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<StaffRole>("officer");
  const [scopeText, setScopeText] = useState("");
  // Officer only: divisions accumulated one at a time, so the administrator never has to type a
  // comma-separated list of Sinhala names.
  const [chosen, setChosen] = useState<string[]>([]);
  const [editing, setEditing] = useState<StaffUser | null>(null);

  // Guards state updates after an async call resolves post-unmount (Epic 2 retro lesson).
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const load = useCallback(async () => {
    const result = await listStaff();
    if (!mountedRef.current) return;
    if (result.status === "ok") {
      setUsers(result.users);
      setDistricts(result.districts);
      setDivisions(result.divisions);
      setState("ready");
    } else if (result.status === "forbidden" || result.status === "unavailable") {
      setState(result.status);
    } else {
      setState("error");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  /** Add the typed division to the officer's list, if it is one the server would accept. */
  function addDivision() {
    const name = scopeText.trim();
    if (!name) return;
    if (!divisions.some((d) => d.name === name)) {
      // Caught here rather than on submit: the administrator is still looking at the field they
      // typed it into, and the picker beside it holds the answer.
      setBanner({ kind: "error", text: t("error.unknownDivision", { name }) });
      return;
    }
    if (!chosen.includes(name)) setChosen([...chosen, name]);
    setScopeText("");
    setBanner(null);
  }

  function scopePayload() {
    const value = scopeText.trim();
    if (role === "admin") return { district_id: value };
    if (role === "ds_officer") return { ds_division: value };
    if (role === "officer") {
      // Anything still sitting in the input counts too, so a division typed but not yet added is
      // not silently dropped on submit.
      const pending = value && !chosen.includes(value) ? [value] : [];
      return { assigned_divisions: [...chosen, ...pending] };
    }
    return {};
  }

  function report(result: { status: string; detail?: string }) {
    const key =
      result.status === "duplicate" ? "error.duplicate"
      : result.status === "self" ? "error.self"
      : result.status === "forbidden" ? "error.forbidden"
      : result.status === "unavailable" ? "error.unavailable"
      : result.status === "invalid" ? "error.invalid"
      : "error.generic";
    setBanner({
      kind: "error",
      text: result.status === "invalid" && result.detail ? result.detail : t(key),
    });
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBanner(null);
    setTempPassword(null);
    setBusy(true);
    try {
      const result = editing
        ? await updateStaff(editing.id, { role, ...scopePayload() })
        : await createStaff({ email: email.trim(), role, ...scopePayload() });
      if (!mountedRef.current) return;
      if (result.status !== "ok") {
        report(result);
        return;
      }
      if (!editing && result.temporaryPassword) {
        setTempPassword({ email: email.trim(), password: result.temporaryPassword });
      } else {
        setBanner({ kind: "success", text: t("saved") });
      }
      setEmail("");
      setScopeText("");
      setChosen([]);
      setEditing(null);
      await load();
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  }

  async function handleDelete(user: StaffUser) {
    if (!window.confirm(t("confirmDelete", { email: user.email ?? user.id }))) return;
    setBanner(null);
    setBusy(true);
    try {
      const result = await deleteStaff(user.id);
      if (!mountedRef.current) return;
      if (result.status !== "ok") {
        report(result);
        return;
      }
      setBanner({ kind: "success", text: t("deleted") });
      await load();
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  }

  function beginEdit(user: StaffUser) {
    setEditing(user);
    setRole((user.role ?? "officer") as StaffRole);
    // An officer's existing divisions become chips; the other roles hold a single value, so it
    // goes into the input where it can be re-picked.
    if (user.scope.kind === "assigned_divisions" && Array.isArray(user.scope.value)) {
      setChosen(user.scope.value);
      setScopeText("");
    } else {
      setChosen([]);
      setScopeText(describeScope(user.scope) === "—" ? "" : describeScope(user.scope));
    }
    setBanner(null);
    setTempPassword(null);
  }

  if (state === "loading") {
    return (
      <main className="mx-auto max-w-5xl p-design-6">
        <p role="status" aria-live="polite" className="text-body text-ink-secondary">
          {t("loading")}
        </p>
      </main>
    );
  }

  // These two are not errors the administrator can retry past, so they replace the screen rather
  // than sitting above a form that cannot work.
  if (state === "forbidden" || state === "unavailable" || state === "error") {
    return (
      <main className="mx-auto max-w-2xl p-design-6">
        <h1 className="text-title font-bold text-ink-primary">{t("title")}</h1>
        <p role="alert" className="mt-design-4 text-body text-status-error">
          {t(state === "forbidden" ? "error.forbidden"
            : state === "unavailable" ? "error.unavailable" : "error.generic")}
        </p>
      </main>
    );
  }

  return (
    <main className="mx-auto flex max-w-5xl flex-col gap-design-5 p-design-6">
      <header>
        <h1 className="text-title font-bold text-ink-primary">{t("title")}</h1>
        <p className="mt-design-1 text-body text-ink-secondary">{t("subtitle")}</p>
      </header>

      {tempPassword && (
        // Shown once. Not stored, not logged, not audited — the administrator reads it off the
        // screen and hands it over, and it is gone on the next action.
        <section role="status" className="rounded-md border border-forest bg-surface-tint p-design-4">
          <h2 className="text-label font-semibold text-ink-primary">{t("password.title")}</h2>
          <p className="mt-design-1 text-caption text-ink-secondary">{t("password.hint")}</p>
          <p className="mt-design-2 font-mono text-headline text-ink-primary">
            {tempPassword.email} · {tempPassword.password}
          </p>
        </section>
      )}

      {banner && (
        <p
          role={banner.kind === "error" ? "alert" : "status"}
          className={`rounded-md p-design-3 text-body ${
            banner.kind === "error"
              ? "bg-status-error-pale text-status-error"
              : "bg-surface-tint text-ink-primary"
          }`}
        >
          {banner.text}
        </p>
      )}

      <form onSubmit={handleSubmit} className="flex flex-col gap-design-3 rounded-md border border-border-subtle bg-surface-raised p-design-4 shadow-card">
        <h2 className="text-label font-semibold text-ink-primary">
          {editing ? t("form.editTitle", { email: editing.email ?? editing.id }) : t("form.createTitle")}
        </h2>

        {!editing && (
          <div className="flex flex-col gap-design-1">
            <label htmlFor="staff-email" className="text-label text-ink-primary">{t("form.email")}</label>
            <input
              id="staff-email"
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="min-h-touch-target rounded-md border border-border-default px-design-3 text-body"
            />
          </div>
        )}

        <div className="flex flex-col gap-design-1">
          <label htmlFor="staff-role" className="text-label text-ink-primary">{t("form.role")}</label>
          <select
            id="staff-role"
            value={role}
            onChange={(e) => {
              setRole(e.target.value as StaffRole);
              setScopeText("");
              setChosen([]);
            }}
            className="min-h-touch-target rounded-md border border-border-default px-design-3 text-body"
          >
            {ROLES.map((r) => (
              <option key={r} value={r}>{t(`role.${r}`)}</option>
            ))}
          </select>
        </div>

        {/* SCOPE IS NEVER FREE TEXT.
            The reference names are Sinhala and there are 167 divisions, so a plain input gives the
            administrator no way to discover a valid value — the only feedback is a rejection after
            submitting, and a district name typed into a division field ("Polonnaruwa") looks like a
            reasonable answer right up until it is refused. Both fields are backed by the server's
            own vocabulary, so what can be typed is what will validate.

            A field officer covers several divisions, so that role adds one at a time and keeps the
            chosen ones visible as removable chips rather than asking for a comma-separated string
            in a script the keyboard may not be set to. */}
        {role !== "system_admin" && (
          <div className="flex flex-col gap-design-1">
            <label htmlFor="staff-scope" className="text-label text-ink-primary">
              {t(`form.scope.${role}`)}
            </label>

            <div className="flex gap-design-2">
              <input
                id="staff-scope"
                required={role !== "officer" || chosen.length === 0}
                value={scopeText}
                onChange={(e) => setScopeText(e.target.value)}
                onKeyDown={(e) => {
                  if (role === "officer" && e.key === "Enter") {
                    e.preventDefault();
                    addDivision();
                  }
                }}
                list={role === "admin" ? "district-options" : "division-options"}
                autoComplete="off"
                className="min-h-touch-target flex-1 rounded-md border border-border-default px-design-3 text-body"
              />
              {role === "officer" && (
                <button
                  type="button"
                  onClick={addDivision}
                  className="min-h-touch-target rounded-md border border-forest px-design-4 text-label font-semibold text-forest"
                >
                  {t("form.add")}
                </button>
              )}
            </div>

            {role === "officer" && chosen.length > 0 && (
              <ul className="flex flex-wrap gap-design-2">
                {chosen.map((name) => (
                  <li
                    key={name}
                    className="flex items-center gap-design-1 rounded-full bg-surface-tint px-design-3 py-0.5 text-caption"
                  >
                    {name}
                    <button
                      type="button"
                      onClick={() => setChosen(chosen.filter((c) => c !== name))}
                      aria-label={`${t("action.delete")} ${name}`}
                      className="text-status-error"
                    >
                      ×
                    </button>
                  </li>
                ))}
              </ul>
            )}

            <p className="text-caption text-ink-secondary">{t(`form.scopeHint.${role}`)}</p>

            <datalist id="district-options">
              {districts.map((d) => <option key={d} value={d} />)}
            </datalist>
            {/* The label carries the district, so the several divisions that share a name with
                theirs can be told apart while typing. */}
            <datalist id="division-options">
              {divisions.map((d) => (
                <option key={`${d.district}/${d.name}`} value={d.name} label={d.district} />
              ))}
            </datalist>
          </div>
        )}

        <div className="flex gap-design-2">
          <button
            type="submit"
            disabled={busy}
            className="min-h-touch-target flex-1 rounded-md bg-forest px-design-4 text-label font-semibold text-ink-on-dark disabled:opacity-60"
          >
            {busy ? t("working") : editing ? t("action.save") : t("action.create")}
          </button>
          {editing && (
            <button
              type="button"
              onClick={() => { setEditing(null); setScopeText(""); setChosen([]); setBanner(null); }}
              className="min-h-touch-target rounded-md border border-border-default px-design-4 text-label"
            >
              {t("action.cancel")}
            </button>
          )}
        </div>
      </form>

      {users.length === 0 ? (
        <p className="text-body text-ink-secondary">{t("empty")}</p>
      ) : (
        <div className="overflow-x-auto rounded-md border border-border-default">
          <table className="w-full text-left text-body">
            <thead className="bg-surface-tint text-label">
              <tr>
                <th scope="col" className="px-design-3 py-design-2">{t("table.email")}</th>
                <th scope="col" className="px-design-3 py-design-2">{t("table.role")}</th>
                <th scope="col" className="px-design-3 py-design-2">{t("table.scope")}</th>
                <th scope="col" className="px-design-3 py-design-2">{t("table.lastSignIn")}</th>
                <th scope="col" className="px-design-3 py-design-2">{t("table.actions")}</th>
              </tr>
            </thead>
            <tbody>
              {users.map((u) => (
                <tr key={u.id} className="border-t border-border-default">
                  <td className="px-design-3 py-design-2 text-ink-primary">{u.email ?? "—"}</td>
                  <td className="px-design-3 py-design-2">{u.role ? t(`role.${u.role}`) : "—"}</td>
                  <td className="px-design-3 py-design-2 text-ink-secondary">{describeScope(u.scope)}</td>
                  <td className="px-design-3 py-design-2 text-ink-secondary">
                    {u.last_sign_in_at ? new Date(u.last_sign_in_at).toLocaleDateString() : t("table.never")}
                  </td>
                  <td className="whitespace-nowrap px-design-3 py-design-2">
                    <button
                      type="button"
                      onClick={() => beginEdit(u)}
                      className="mr-design-2 text-label text-forest underline"
                    >
                      {t("action.edit")}
                    </button>
                    <button
                      type="button"
                      onClick={() => handleDelete(u)}
                      disabled={busy}
                      className="text-label text-status-error underline disabled:opacity-50"
                    >
                      {t("action.delete")}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </main>
  );
}
