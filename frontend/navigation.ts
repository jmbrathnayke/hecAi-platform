import { createNavigation } from "next-intl/navigation";
import { routing } from "./routing";

// Locale-aware navigation helpers (next-intl v3.22+ API). Use these — NOT next/navigation —
// for any locale-prefixed routing so the active locale is preserved/switched correctly.
export const { Link, redirect, usePathname, useRouter, getPathname } = createNavigation(routing);
