import type { Metadata } from "next";
import "../globals.css";
import { SyncStatusBar } from "@/components/SyncStatusBar";

// Officer routes are a separate top-level tree from app/[locale] (English-only, FR-9.3,
// no i18n provider) — Next.js requires each top-level branch under app/ to reach its own
// <html>/<body> via a layout in its chain, so this is a second, independent root layout
// (not nested under app/[locale]).
export const metadata: Metadata = {
  title: "HEC Platform — Officer Portal",
};

export default function OfficerLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="font-sans">
        <SyncStatusBar />
        {children}
      </body>
    </html>
  );
}
