import { useEffect, useState } from "react";
import { useRevalidator } from "react-router";
export function useCheckRefresh(running: boolean) {
  const revalidator = useRevalidator();
  const [zone, setZone] = useState("UTC");
  useEffect(() => { setZone(Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"); }, []);
  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => { if (revalidator.state === "idle") void revalidator.revalidate(); }, 3000);
    return () => window.clearInterval(timer);
  }, [running, revalidator]);
  return zone;
}
