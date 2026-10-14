"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  getProjectAttemptCounts,
  totalAttemptsCount,
} from "../fixtures/station-fixture";

export function ProjectNav() {
  const router = useRouter();
  const pathname = usePathname() ?? "/lanes";
  const searchParams = useSearchParams();
  const project = searchParams.get("project") ?? "";
  const projects = getProjectAttemptCounts();

  function choose(name: string) {
    const params = new URLSearchParams(searchParams.toString());
    if (name) {
      params.set("project", name);
    } else {
      params.delete("project");
    }
    const query = params.toString();
    router.push(query ? `${pathname}?${query}` : pathname);
  }

  return (
    <div className="sidebar-section sidebar-projects">
      <div className="sidebar-label">Projects · {projects.length}</div>
      <nav className="sidebar-nav" aria-label="Projects">
        <button
          type="button"
          className="sidebar-link"
          aria-current={project === "" ? "true" : undefined}
          onClick={() => choose("")}
        >
          <span className="sidebar-link-label">All</span>
          <span className="sidebar-badge">{totalAttemptsCount}</span>
        </button>
        {projects.map(([name, count]) => (
          <button
            key={name}
            type="button"
            className="sidebar-link"
            aria-current={project === name ? "true" : undefined}
            onClick={() => choose(name)}
          >
            <span className="sidebar-link-label">{name}</span>
            <span className="sidebar-badge">{count}</span>
          </button>
        ))}
      </nav>
    </div>
  );
}