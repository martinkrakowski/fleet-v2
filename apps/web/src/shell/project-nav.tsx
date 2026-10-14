"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { attempts, workOrders } from "../app/lanes/fixture";

export function ProjectNav() {
  const router = useRouter();
  const project = useSearchParams().get("project") ?? "";
  const projects = Array.from(
    attempts.reduce((map, attempt) => {
      const name = workOrders[attempt.wo].project;
      map.set(name, (map.get(name) ?? 0) + 1);
      return map;
    }, new Map<string, number>())
  ).sort(([a], [b]) => a.localeCompare(b));

  function choose(name: string) {
    const query = name ? `?project=${encodeURIComponent(name)}` : "";
    router.push(`/lanes${query}`);
  }

  return (
    <nav className="sidenav" aria-label="Projects">
      <h2 className="sideh">
        Projects <span>{projects.length}</span>
      </h2>
      <div className="sidelist">
        <button
          type="button"
          className={project === "" ? "sidebtn on" : "sidebtn"}
          aria-current={project === "" ? "true" : undefined}
          onClick={() => choose("")}
        >
          <span>All</span>
          <span className="sidecount">{attempts.length}</span>
        </button>
        {projects.map(([name, count]) => (
          <button
            key={name}
            type="button"
            className={project === name ? "sidebtn on" : "sidebtn"}
            aria-current={project === name ? "true" : undefined}
            onClick={() => choose(name)}
          >
            <span>{name}</span>
            <span className="sidecount">{count}</span>
          </button>
        ))}
      </div>
    </nav>
  );
}
