import { useTranslations } from "next-intl";

export default function HomePage() {
  const t = useTranslations("home");
  return (
    <main className="flex min-h-screen flex-col items-center justify-center bg-surface-base">
      <h1 className="text-title font-bold text-ink-primary">{t("title")}</h1>
      <p className="text-body text-ink-secondary mt-design-2">{t("subtitle")}</p>
    </main>
  );
}
