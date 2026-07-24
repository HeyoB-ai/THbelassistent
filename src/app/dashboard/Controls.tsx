"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

export function Controls({ status }: { status: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [confirming, setConfirming] = useState(false);

  function send(action: string) {
    start(async () => {
      await fetch("/api/campaign", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      setConfirming(false);
      router.refresh();
    });
  }

  return (
    <div className="controls">
      {status !== "running" ? (
        <button className="btn" onClick={() => send("start")} disabled={pending}>
          {status === "paused" ? "Hervatten" : "Bellen starten"}
        </button>
      ) : (
        <button className="btn btn--quiet" onClick={() => send("pause")} disabled={pending}>
          Pauzeren
        </button>
      )}

      {confirming ? (
        <>
          <span style={{ fontSize: 14 }}>
            Stoppen breekt ook lopende gesprekken af. Zeker weten?
          </span>
          <button className="btn btn--halt" onClick={() => send("stop")} disabled={pending}>
            Ja, alles stoppen
          </button>
          <button className="btn btn--quiet" onClick={() => setConfirming(false)}>
            Annuleren
          </button>
        </>
      ) : (
        <button className="btn btn--quiet" onClick={() => setConfirming(true)} disabled={status === "stopped"}>
          Alles stoppen
        </button>
      )}

      <span style={{ marginLeft: "auto", font: "500 12px/1 var(--mono)", color: "var(--mute)" }}>
        {{ draft: "NOG NIET GESTART", running: "BELT", paused: "GEPAUZEERD", stopped: "GESTOPT" }[status]}
      </span>
    </div>
  );
}
