"use client";

import { Suspense } from "react";
import { ProjectNav } from "./project-nav";
import { ViewNav } from "./view-nav";

function closeDrawer() {
  document.body.classList.remove("sidebar-open");
}

/**
 * The application rail: brand, view links, the project filter, and the
 * station footer line. Styled by the `--sidebar-*` tokens in
 * apps/web/src/app/globals.css, which adapt between Light mode
 * (`#ffffff` surface, `#5a6577` / `#1e2633` text, `#e6e7eb` border) and
 * Dark mode (`#1a2332` surface, `#93a0bb` / `#e9eef7` text,
 * `rgba(255, 255, 255, 0.08)` border). Collapses to a `64px` icon rail
 * on desktop via `body.sidebar-rail` and becomes an off-canvas drawer
 * on mobile via `body.sidebar-open`.
 */
export function Sidebar() {
  return (
    <>
      <aside className="sidebar">
        <div className="sidebar-brand">
          <svg className="ic" viewBox="0 0 24 24" aria-hidden="true">
            <path d="M3 7h18" />
            <path d="M3 12h13" />
            <path d="M3 17h8" />
          </svg>
          <span className="sidebar-brand-label">fleet</span>
        </div>
        <ViewNav />
        <Suspense fallback={null}>
          <ProjectNav />
        </Suspense>
        <div className="sidebar-footer">fixture station · no live runner</div>
      </aside>
      <div className="sidebar-backdrop" onClick={closeDrawer} />
    </>
  );
}