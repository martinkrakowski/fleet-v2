"use client";

import { Suspense } from "react";
import { ProjectNav } from "./project-nav";
import { ViewNav } from "./view-nav";

function closeDrawer() {
  document.body.classList.remove("sidebar-open");
}

/**
 * The fixed dark-slate application rail: brand, view links, the project
 * filter, and the station footer line. Collapses to a `64px` icon rail on
 * desktop via `body.sidebar-rail` and becomes an off-canvas drawer on
 * mobile via `body.sidebar-open`.
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