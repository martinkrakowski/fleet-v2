"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const VIEWS = [
  {
    href: "/lanes",
    label: "Lanes",
    icon: (
      <svg className="ic" viewBox="0 0 24 24" aria-hidden="true">
        <path d="M4 6h16" />
        <path d="M4 12h10" />
        <path d="M4 18h7" />
      </svg>
    ),
  },
  {
    href: "/projects",
    label: "Projects",
    icon: (
      <svg className="ic" viewBox="0 0 24 24" aria-hidden="true">
        <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
      </svg>
    ),
  },
  {
    href: "/attempt",
    label: "Attempt",
    icon: (
      <svg className="ic" viewBox="0 0 24 24" aria-hidden="true">
        <path d="M8 5v14l11-7z" />
      </svg>
    ),
  },
  {
    href: "/brief",
    label: "Brief",
    icon: (
      <svg className="ic" viewBox="0 0 24 24" aria-hidden="true">
        <path d="M7 3h7l4 4v14H7z" />
        <path d="M14 3v4h4" />
      </svg>
    ),
  },
  {
    href: "/knowledge",
    label: "Knowledge",
    icon: (
      <svg className="ic" viewBox="0 0 24 24" aria-hidden="true">
        <path d="M12 3a6 6 0 0 1 3.5 10.8V16h-7v-2.2A6 6 0 0 1 12 3z" />
        <path d="M9.5 19h5" />
      </svg>
    ),
  },
];

export function ViewNav() {
  const pathname = usePathname();
  return (
    <div className="sidebar-section">
      <div className="sidebar-label">Views</div>
      <nav className="sidebar-nav" aria-label="Views">
        {VIEWS.map((view) => (
          <Link
            key={view.href}
            href={view.href}
            className="sidebar-link"
            data-tooltip={view.label}
            aria-label={view.label}
            aria-current={
              pathname?.startsWith(view.href) ? ("page" as const) : undefined
            }
          >
            {view.icon}
            <span className="sidebar-link-label">{view.label}</span>
          </Link>
        ))}
      </nav>
    </div>
  );
}