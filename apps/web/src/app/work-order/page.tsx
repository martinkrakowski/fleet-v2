import { loadWorkOrderTimeline } from "./live";
import { WorkOrderTimeline } from "./components/work-order-timeline";

export const dynamic = "force-dynamic";

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const id = typeof params.id === "string" ? params.id : "";
  return <WorkOrderTimeline data={await loadWorkOrderTimeline(id)} />;
}
