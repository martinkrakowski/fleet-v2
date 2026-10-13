"use client";

import { useEffect, useState } from "react";

const CADENCE_SECONDS = 15;

export function Countdown() {
  const [seconds, setSeconds] = useState(CADENCE_SECONDS);
  useEffect(() => {
    const timer = setInterval(() => {
      setSeconds((current) =>
        current <= 1 ? CADENCE_SECONDS : current - 1,
      );
    }, 1000);
    return () => clearInterval(timer);
  }, []);
  return (
    <span className="cadence mono">next read {seconds} s</span>
  );
}
