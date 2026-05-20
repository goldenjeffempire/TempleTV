import { useEffect, useState } from "react";

export function Clock() {
  const [time, setTime] = useState(() => new Date());

  useEffect(() => {
    const id = setInterval(() => setTime(new Date()), 1000);
    return () => clearInterval(id);
  }, []);

  const hours = time.getHours();
  const minutes = time.getMinutes();
  const ampm = hours >= 12 ? "PM" : "AM";
  const h = hours % 12 || 12;
  const m = String(minutes).padStart(2, "0");

  return (
    <span className="text-white/70" style={{ fontSize: 22, fontWeight: 500, letterSpacing: "0.02em" }}>
      {h}:{m} {ampm}
    </span>
  );
}
