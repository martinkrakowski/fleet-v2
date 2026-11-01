import { loadConductor } from "./live";
import { ConductorClient } from "./conductor-client";

export const dynamic = "force-dynamic";

export default async function ConductorPage() {
  return <ConductorClient data={await loadConductor()} />;
}
