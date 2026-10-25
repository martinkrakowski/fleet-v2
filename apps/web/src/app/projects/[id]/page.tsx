import { loadProject } from "../live";
import { ProjectDetailClient } from "./project-detail-client";

export const dynamic = "force-dynamic";

export default async function ProjectPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <ProjectDetailClient projectId={id} data={await loadProject(id)} />;
}
