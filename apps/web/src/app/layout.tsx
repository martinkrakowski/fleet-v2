import type { ReactNode } from "react";
import { Countdown } from "../shell/countdown";
import { ProjectStrip } from "../shell/project-strip";
import { ThemeToggle } from "../shell/theme-toggle";
import { ViewNav } from "../shell/view-nav";
import "./globals.css";

// The shared badge lives in @fleet/ui, which does not resolve in this
// worktree: import { Badge } from "@fleet/ui". Until the package resolves,
// the shell renders no badge and does not invent a second one.

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" data-theme="dark">
      <body>
        <div className="app">
          <header className="topbar">
            <span className="mark" aria-label="Fleet">
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M3 7h18" />
                <path d="M3 12h13" />
                <path d="M3 17h8" />
              </svg>
              <b>fleet</b>
            </span>
            <span className="tag">line controller</span>
            <ViewNav />
            <div className="topctl">
              <Countdown />
              <ThemeToggle />
            </div>
          </header>
          <ProjectStrip />
          <main className="page">{children}</main>
        </div>
      </body>
    </html>
  );
}
