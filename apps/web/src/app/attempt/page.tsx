import { Suspense } from "react";
import AttemptPage from "./attempt-client";

export default function Page() {
  return (
    <Suspense fallback={null}>
      <AttemptPage />
    </Suspense>
  );
}
