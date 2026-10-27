"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

// "sample" marks views that show sample data only; Lanes, Projects, Attempt and Questions read the API when configured.
const VIEWS = [
  {
    href: "/lanes",
    label: "Lanes",
    sample: false,
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
    sample: false,
    icon: (
      <svg className="ic" viewBox="0 0 24 24" aria-hidden="true">
        <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
      </svg>
    ),
  },
  {
    href: "/attempt",
    label: "Attempt",
    sample: false,
    icon: (
      <svg className="ic" viewBox="0 0 24 24" aria-hidden="true">
        <path d="M8 5v14l11-7z" />
      </svg>
    ),
  },
  {
    href: "/questions",
    label: "Questions",
    sample: false,
    icon: (
      <svg className="ic" viewBox="0 0 24 24" aria-hidden="true">
        <path d="M9 9a3 3 0 1 1 4 2.8c-.6.3-1 .8-1 1.5V14" />
        <path d="M12 17.5v.01" />
      </svg>
    ),
  },
  {
    href: "/brief",
    label: "Brief",
    sample: true,
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
    sample: true,
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
        {VIEWS.map((view) => {
          const name = view.sample
            ? view.label + " (sample data)"
            : view.label;
          return (
            <Link
              key={view.href}
              href={view.href}
              className="sidebar-link"
              data-tooltip={name}
              aria-label={name}
              aria-current={
                pathname?.startsWith(view.href) ? ("page" as const) : undefined
              }
            >
              {view.icon}
              <span className="sidebar-link-label">
                {view.label}
                {view.sample ? (
                  <span className="sidebar-link-sample">sample</span>
                ) : null}
              </span>
            </Link>
          );
        })}
      </nav>
    </div>
  );
}