import { Suspense, type ReactNode } from "react";
import { Footer } from "../shell/footer";
import { Sidebar } from "../shell/sidebar";
import { Topbar } from "../shell/topbar";
import "../shell/shell.css";
import "./globals.css";

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" data-theme="dark">
      <body>
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