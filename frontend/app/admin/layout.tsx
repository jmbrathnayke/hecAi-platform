import type { Metadata } from "next";
import "../globals.css";

// Admin routes are a separate top-level tree from app/[locale] (English-only, FR-9.3, no i18n
// provider), mirroring the officer tree. Next.js requires each top-level branch under app/ to
// reach its own <html>/<body> via a layout in its chain, so this is an independent root layout
// (not nested under app/[locale]). No SyncStatusBar here — offline sync is an officer field-app
// concern, not an admin desk concern.
export const metadata: Metadata = {
  title: "HEC Platform — Admin Portal",
};

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="font-sans">{children}</body>
    </html>
  );
}
