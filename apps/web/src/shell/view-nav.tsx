"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const VIEWS = [
  { href: "/lanes", label: "Lanes" },
  { href: "/attempt", label: "Attempt" },
  { href: "/brief", label: "Brief" },
  { href: "/knowledge", label: "Knowledge" },
];

export function ViewNav() {
  const pathname = usePathname();
  return (
    <nav className="views" aria-label="Views">
      {VIEWS.map((view) => (
        <Link
          key={view.href}
          href={view.href}
          aria-current={
            pathname?.startsWith(view.href) ? ("page" as const) : undefined
          }
        >
          {view.label}
        </Link>
      ))}
    </nav>
  );
}
