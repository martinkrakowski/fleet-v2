import { loadProjects } from "./live";
import { ProjectsClient } from "./projects-client";

export const dynamic = "force-dynamic";

export default async function ProjectsPage() {
  return <ProjectsClient data={await loadProjects()} />;
}
