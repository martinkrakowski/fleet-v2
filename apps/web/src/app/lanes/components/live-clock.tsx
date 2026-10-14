"use client";

import { useEffect, useState } from "react";
import styles from "../lanes.module.css";

export function LiveClock({ startMinutes }: { startMinutes: number }) {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setElapsed((n) => n + 1), 1000);
    return () => clearInterval(timer);
  }, []);
  const total = startMinutes * 60 + elapsed;
  const mm = String(Math.floor(total / 60)).padStart(2, "0");
  const ss = String(total % 60).padStart(2, "0");
  return (
    <span className={`${styles.mono} ${styles.clock}`}>
      {mm}:{ss}
    </span>
  );
}