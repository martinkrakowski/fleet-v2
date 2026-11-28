import { loadBriefData } from "./live";
import { BriefView } from "./brief-view";

export const dynamic = "force-dynamic";

/** The `workOrderId` search parameter as one string, read without running any accessor. */
function readWorkOrderId(params: Record<string, string | string[] | undefined>): string | undefined {
  const descriptor = Object.getOwnPropertyDescriptor(params, "workOrderId");
  if (descriptor === undefined || descriptor.get !== undefined) {
    return undefined;
  }
  const value: unknown = descriptor.value;
  return typeof value === "string" && value.length > 0 && value.length <= 256 ? value : undefined;
}

export default async function BriefPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const data = await loadBriefData(readWorkOrderId(params));
  return <BriefView data={data} />;
}
