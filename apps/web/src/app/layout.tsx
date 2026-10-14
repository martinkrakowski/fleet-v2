import { Suspense, type ReactNode } from "react";
import { Footer } from "../shell/footer";
import { Sidebar } from "../shell/sidebar";
import { Topbar } from "../shell/topbar";
import "./globals.css";

/**
 * Synchronous pre-paint theme resolution. Runs before first paint so the
 * active palette (`:root[data-theme]` token blocks in globals.css) matches
 * the operator's persisted choice (`localStorage` key `theme`) or, absent
 * one, their OS preference, defaulting to light.
 */
const THEME_INIT_SCRIPT = `(function(){try{var stored=localStorage.getItem("theme");var sysDark=window.matchMedia&&window.matchMedia("(prefers-color-scheme: dark)").matches;var theme=stored==="dark"||stored==="light"?stored:(sysDark?"dark":"light");document.documentElement.dataset.theme=theme;}catch(e){document.documentElement.dataset.theme="light";}})();`;

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body>
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
        <div className="app-shell">
          <Sidebar />
          <div className="main">
            <Topbar />
            <div className="page-wrapper">
              <Suspense fallback={null}>{children}</Suspense>
            </div>
            <Footer />
          </div>
        </div>
      </body>
    </html>
  );
}