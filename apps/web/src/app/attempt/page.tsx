import { loadAttemptPage } from "./live";
import AttemptPage from "./attempt-client";

export const dynamic = "force-dynamic";

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const id = typeof params.id === "string" ? params.id : "";
  return <AttemptPage data={await loadAttemptPage(id)} />;
}
