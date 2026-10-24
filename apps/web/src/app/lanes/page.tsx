import { loadLanesData } from "./live";
import { LanesClient } from "./lanes-client";

export const dynamic = "force-dynamic";

export default async function LanesPage() {
  return <LanesClient data={await loadLanesData()} />;
}
