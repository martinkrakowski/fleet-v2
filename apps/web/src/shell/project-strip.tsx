const PROJECTS = ["fleet-v2", "waves", "hexagen"];

export function ProjectStrip() {
  return (
    <nav className="projects" aria-label="Projects">
      <span className="lbl">Projects</span>
      {PROJECTS.map((name) => (
        <span key={name} className="proj">
          {name}
        </span>
      ))}
    </nav>
  );
}
