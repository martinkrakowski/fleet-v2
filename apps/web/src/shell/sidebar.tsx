"use client";

import { Suspense } from "react";
import { ProjectNav } from "./project-nav";
import type { ProjectNavData } from "./project-nav-data";
import { ViewNav } from "./view-nav";

function closeDrawer() {
  document.body.classList.remove("sidebar-open");
}

/**
 * The application rail: brand, view links, the project filter, and the
 * station footer line. Styled by the `--sidebar-*` tokens in
 * apps/web/src/app/globals.css, which adapt between Light mode (a light
 * surface with muted and strong text tones and a subtle border) and
 * Dark mode (a deep surface with softened text tones and a faint
 * translucent border). Collapses to a `64px` icon rail
 * on desktop via `body.sidebar-rail` and becomes an off-canvas drawer
 * on mobile via `body.sidebar-open`.
 */
export function Sidebar({ nav }: { nav: ProjectNavData }) {
  return (
    <>
      <aside className="sidebar">
        <div className="sidebar-brand" data-tooltip="fleet">
          <svg className="ic" viewBox="0 0 24 24" aria-hidden="true">
            <path d="M3 7h18" />
            <path d="M3 12h13" />
            <path d="M3 17h8" />
          </svg>
          <span className="sidebar-brand-label">fleet</span>
        </div>
        <ViewNav />
        <Suspense fallback={null}>
          <ProjectNav data={nav} />
        </Suspense>
        <div className="sidebar-footer">
          fixture views are labelled · Lanes reads the API when configured
        </div>
      </aside>
      <div className="sidebar-backdrop" onClick={closeDrawer} />
    </>
  );
}