"use client";

import { usePathname } from "next/navigation";
import { IconButton } from "@fleet/ui";
import { Countdown } from "./countdown";
import { ThemeToggle } from "./theme-toggle";

const ROUTES = [
  { href: "/lanes", label: "Lanes" },
  { href: "/attempt", label: "Attempt" },
  { href: "/brief", label: "Brief" },
  { href: "/knowledge", label: "Knowledge" },
];

function toggleSidebar() {
  if (window.matchMedia("(max-width: 991.98px)").matches) {
    document.body.classList.remove("sidebar-rail");
    document.body.classList.toggle("sidebar-open");
  } else {
    document.body.classList.remove("sidebar-open");
    document.body.classList.toggle("sidebar-rail");
  }
}

/**
 * The sticky application topbar: the sidebar toggle, the route breadcrumb
 * across `/lanes`, `/attempt`, `/brief` and `/knowledge`, the 15 s read
 * cadence pill, and the theme toggle.
 */
export function Topbar() {
  const pathname = usePathname();
  const route = ROUTES.find((candidate) => pathname?.startsWith(candidate.href));
  return (
    <header className="topbar">
      <div className="topbar-left">
        <IconButton label="Toggle sidebar" onClick={toggleSidebar}>
          <svg className="ic" viewBox="0 0 24 24" aria-hidden="true">
            <path d="M4 6h16" />
            <path d="M4 12h16" />
            <path d="M4 18h16" />
          </svg>
        </IconButton>
        <div className="topbar-breadcrumb">
          <span>station</span>
          <span aria-hidden="true">/</span>
          <b>{route?.label ?? ROUTES[0].label}</b>
        </div>
      </div>
      <div className="topbar-right">
        <Countdown />
        <ThemeToggle />
      </div>
    </header>
  );
}