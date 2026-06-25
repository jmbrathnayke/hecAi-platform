import { useTranslations } from "next-intl";
import { Link } from "@/navigation";
import { LanguageSelector } from "@/components/LanguageSelector";

export default function HomePage() {
  const t = useTranslations("home");

  return (
    <main className="flex min-h-screen flex-col bg-surface-base">
      {/* Forest header band with brand mark */}
      <header className="flex items-center gap-design-3 bg-forest px-design-5 py-design-4 text-ink-on-dark">
        <BrandMark />
        <h1 className="text-headline font-bold">{t("title")}</h1>
      </header>

      <div className="mx-auto flex w-full max-w-md flex-1 flex-col items-center justify-center gap-design-6 px-design-5 py-design-7">
        <p className="text-center text-body text-ink-secondary">{t("tagline")}</p>

        <section className="flex flex-col items-center gap-design-3" aria-label={t("languageSelector")}>
          <span className="text-label text-ink-secondary">{t("languageSelector")}</span>
          <LanguageSelector />
        </section>

        <nav className="flex w-full flex-col gap-design-3" aria-label="Primary actions">
          {/* prefetch disabled until these routes exist (Report = Sprint 2.x, Status = Sprint 2.5). */}
          <Link
            href="/report"
            prefetch={false}
            className="flex min-h-primary-btn items-center justify-center rounded-md bg-amber px-design-5 text-headline font-semibold text-ink-on-amber transition-opacity hover:opacity-90"
          >
            {t("reportIncident")}
          </Link>
          <Link
            href="/status"
            prefetch={false}
            className="flex min-h-primary-btn items-center justify-center rounded-md border-2 border-forest bg-surface-raised px-design-5 text-headline font-semibold text-forest transition-colors hover:bg-forest-pale"
          >
            {t("checkStatus")}
          </Link>
        </nav>
      </div>
    </main>
  );
}

/** Placeholder brand mark (simple elephant-tusk leaf badge) — replaced with final art later. */
function BrandMark() {
  return (
    <svg
      width="32"
      height="32"
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
