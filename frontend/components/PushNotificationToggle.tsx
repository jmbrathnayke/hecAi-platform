"use client";
// Opt-in control for Web Push status notifications.
//
// BEHIND AN EXPLICIT CONTROL, NEVER ON LOAD. Browsers increasingly ignore — and Chrome can
// permanently block — a permission prompt that appears without a user gesture, and a blocked
// prompt cannot be re-asked. So the citizen presses a button, having read what it is for.
//
// RENDERS NOTHING WHEN IT CANNOT WORK. On a browser without the Push API, or against a deployment
// with no VAPID keypair, an offer that could never be honoured is worse than no offer. The public
// status page (FR-6.1) needs no login, no permission and no subscription, so a citizen who never
// sees this control loses nothing they depend on.
import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import {
  getExistingSubscription,
  getVapidKey,
  isPushSupported,
  subscribeToPush,
  unsubscribeFromPush,
  type PushState,
} from "@/lib/push";

export default function PushNotificationToggle() {
  const t = useTranslations("notifications");
  const [state, setState] = useState<PushState | "checking">("checking");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      if (!isPushSupported()) {
        if (!cancelled) setState("unsupported");
        return;
      }
      // Ask the server before touching the browser: a deployment with no keypair should show
      // nothing at all rather than an enabled-looking control that fails on press.
      const key = await getVapidKey();
      if (cancelled) return;
      if (!key) {
        setState("unavailable");
        return;
      }
      const existing = await getExistingSubscription();
      if (cancelled) return;
      setState(existing ? "subscribed" : "unsubscribed");
    })();

    // The effect outlives the awaits above if the citizen navigates away mid-check; without this
    // the state setters run against an unmounted component. Same lifecycle bug the Epic 2 retro
    // recorded finding in all five of its stories.
    return () => {
      cancelled = true;
    };
  }, []);

  if (state === "checking" || state === "unsupported" || state === "unavailable") return null;

  const subscribed = state === "subscribed";

  async function toggle() {
    setBusy(true);
    try {
      setState(subscribed ? await unsubscribeFromPush() : await subscribeToPush());
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="rounded-md border border-border-default p-design-4">
      <h2 className="text-label font-semibold text-ink-primary">{t("title")}</h2>
      <p className="mt-design-1 text-caption text-ink-secondary">
        {subscribed ? t("enabledHint") : t("hint")}
      </p>

      {state === "denied" && (
        // Nothing this button can do will help: only the browser's own site settings can undo a
        // denial, so say that instead of offering a press that silently does nothing.
        <p role="alert" className="mt-design-2 text-caption text-ink-secondary">
          {t("blocked")}
        </p>
      )}

      <button
        type="button"
        onClick={toggle}
        disabled={busy || state === "denied"}
        className={`mt-design-3 min-h-touch-target w-full rounded-md border text-label font-semibold disabled:opacity-50 ${
          subscribed
            ? "border-border-default text-ink-primary"
            : "border-forest bg-forest text-ink-on-dark"
        }`}
      >
        {busy ? t("working") : subscribed ? t("disable") : t("enable")}
      </button>
    </section>
  );
}
