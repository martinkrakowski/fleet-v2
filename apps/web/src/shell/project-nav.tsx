"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import type { ProjectNavData } from "./project-nav-data";

export function ProjectNav({ data }: { data: ProjectNavData }) {
  const router = useRouter();
  const pathname = usePathname() ?? "/lanes";
  const searchParams = useSearchParams();
  const project = searchParams.get("project") ?? "";
  const fallback = data.source === "fixture-fallback";

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
      <div
        className="sidebar-label"
        title={fallback ? (data.fallbackReason ?? undefined) : undefined}
      >
        {fallback ? "Projects · sample" : `Projects · ${data.projects.length}`}
      </div>
      <nav className="sidebar-nav" aria-label="Projects">
        <button
          type="button"
          className="sidebar-link"
          aria-current={project === "" ? "true" : undefined}
          onClick={() => choose("")}
        >
          <span className="sidebar-link-label">All</span>
          {data.totalAttempts !== null && (
            <span className="sidebar-badge">{data.totalAttempts}</span>
          )}
        </button>
        {data.projects.map((entry) => (
          <button
            key={entry.projectId}
            type="button"
            className="sidebar-link"
            title={entry.projectId}
            aria-current={project === entry.projectId ? "true" : undefined}
            onClick={() => choose(entry.projectId)}
          >
            <span className="sidebar-link-label">{entry.label}</span>
            {entry.attempts !== null && (
              <span className="sidebar-badge">{entry.attempts}</span>
            )}
          </button>
        ))}
      </nav>
    </div>
  );
}
