import { useTranslations } from "next-intl";
import { Link } from "@/navigation";
import { LanguageSelector } from "@/components/LanguageSelector";

// Citizen home. Composed to match citizen-home.html: forest brand band (two-line brand text) →
// language row → hero → two icon-tile action buttons → civic info strip. The tab bar the mockup
// shows at the bottom lives in app/[locale]/layout.tsx (CitizenBottomNav) so every citizen
// screen carries it, not just this one.
export default function HomePage() {
  const t = useTranslations("home");

  return (
    <main className="flex flex-1 flex-col bg-surface-base">
      {/* Forest header band with brand mark + department sub-line */}
      <header className="flex items-center gap-design-3 bg-forest px-design-5 py-design-4 text-ink-on-dark">
        <BrandMark />
        <div className="min-w-0">
          <h1 className="text-headline font-bold leading-tight">{t("title")}</h1>
          {/* truncate: the department name is long in all three locales and must not push the
              brand mark off a 360px screen. */}
          <p className="truncate text-caption opacity-80">{t("brandSub")}</p>
        </div>
      </header>

      {/* Language row — a full-width bar directly under the header (mockup), not a control
          buried mid-page. */}
      <section
        className="flex flex-wrap items-center justify-between gap-design-2 border-b border-border-default bg-surface-raised px-design-4 py-design-2"
        aria-label={t("languageSelector")}
      >
        {/* Short visible label ("භාෂාව / Language") so the row fits on ONE line at 360px, as in
            the mockup. The full "Choose your language" phrasing stays as this section's
            aria-label, so assistive tech is not left with the terser string. */}
        <span className="text-caption text-ink-secondary">{t("languageShort")}</span>
        <LanguageSelector compact />
      </section>

      <div className="mx-auto flex w-full max-w-md flex-1 flex-col justify-center gap-design-5 px-design-5 py-design-6">
        {/* Hero */}
        <div className="text-center">
          <p className="text-[56px] leading-none" aria-hidden="true">
            🌿
          </p>
          <h2 className="mt-design-3 text-title text-ink-primary">{t("heroTitle")}</h2>
          <p className="mt-design-2 text-body text-ink-secondary">{t("heroBody")}</p>
        </div>

        {/* Primary actions. prefetch stays disabled (unchanged from the previous revision). */}
        <nav className="flex w-full flex-col gap-design-3" aria-label="Primary actions">
          <ActionLink
            href="/report"
            icon="🐘"
            label={t("reportIncident")}
            sub={t("reportIncidentSub")}
            variant="primary"
          />
          <ActionLink
            href="/status"
            icon="🔍"
            label={t("checkStatus")}
            sub={t("checkStatusSub")}
            variant="secondary"
          />
        </nav>

        {/* Civic info strip */}
        <aside className="flex items-start gap-design-3 rounded-md bg-civic-pale p-design-3">
          <span className="shrink-0 text-[20px] leading-tight" aria-hidden="true">
            ℹ️
          </span>
          <p className="text-caption leading-relaxed text-civic">{t("infoStrip")}</p>
        </aside>
      </div>
    </main>
  );
}

/**
 * Mockup action button: 40px icon tile + two-line label, min 64px tall. `min-h-[64px]` rather
 * than a fixed height so a wrapped Sinhala/Tamil label grows the button instead of overflowing it.
 */
function ActionLink({
  href,
  icon,
  label,
  sub,
  variant,
}: {
  href: "/report" | "/status";
  icon: string;
  label: string;
  sub: string;
  variant: "primary" | "secondary";
}) {
  const shell =
    variant === "primary"
      ? "bg-amber text-ink-on-amber"
      : "border-2 border-forest bg-surface-raised text-forest";
  const tile = variant === "primary" ? "bg-white/20" : "bg-forest-pale";

  return (
    <Link
      href={href}
      prefetch={false}
      className={`flex min-h-[64px] items-center gap-design-3 rounded-lg px-design-4 py-design-3 transition-opacity hover:opacity-90 ${shell}`}
    >
      <span
        className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-md text-[22px] ${tile}`}
        aria-hidden="true"
      >
        {icon}
      </span>
      <span className="min-w-0 text-left">
        <span className="block text-body font-semibold leading-tight">{label}</span>
        <span className="mt-0.5 block text-caption opacity-80">{sub}</span>
      </span>
    </Link>
  );
}

/** Placeholder brand mark (simple elephant-tusk leaf badge) — replaced with final art later. */
function BrandMark() {
  return (
    <svg
      width="36"
      height="36"
      viewBox="0 0 32 32"
      role="img"
      aria-label="HEC"
      className="shrink-0"
    >
      <circle cx="16" cy="16" r="16" fill="#D8F3DC" />
      <path
        d="M16 7c-3.5 0-6 2.6-6 6 0 2.3 1.2 3.9 2.6 5.2.9.8 1.4 1.3 1.4 2.3V23h4v-2.5c0-1 .5-1.5 1.4-2.3C20.8 16.9 22 15.3 22 13c0-3.4-2.5-6-6-6Z"
        fill="#2D6A4F"
      />
    </svg>
  );
}
