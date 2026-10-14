"use client";

import { IconButton } from "@fleet/ui";
import { useEffect, useState } from "react";

type Theme = "dark" | "light";

function ThemeIcon({ theme }: { theme: Theme }) {
  return theme === "dark" ? (
    <svg className="ic" viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M19.1 4.9l-1.4 1.4M6.3 17.7l-1.4 1.4" />
    </svg>
  ) : (
    <svg className="ic" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M20 14.5A8.5 8.5 0 1 1 9.5 4 7 7 0 0 0 20 14.5z" />
    </svg>
  );
}

/**
 * The theme toggle. The chosen theme is persisted under `localStorage`
 * key `theme` and applied to `document.documentElement.dataset.theme`.
 * The default state is `"light"`; the pre-paint script in the root layout
 * resolves the actual attribute before hydration and the mount effect
 * syncs to it.
 */
export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>("light");

  useEffect(() => {
    const current = document.documentElement.dataset.theme;
    if (current === "light" || current === "dark") {
      setTheme(current);
    }
  }, []);

  const next: Theme = theme === "dark" ? "light" : "dark";

  return (
    <IconButton
      label="Switch theme"
      title={theme === "dark" ? "Switch to the light twin" : "Switch to dark"}
      onClick={() => {
        document.documentElement.dataset.theme = next;
        localStorage.setItem("theme", next);
        setTheme(next);
      }}
    >
      <ThemeIcon theme={theme} />
    </IconButton>
  );
}