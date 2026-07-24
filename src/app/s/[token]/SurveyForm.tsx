"use client";

import { useState, useTransition } from "react";
import type { Question } from "@/survey";
import { submitSelfReport } from "./actions";

export function SurveyForm({
  token,
  questions,
  initial,
}: {
  token: string;
  questions: Question[];
  initial: Record<string, unknown>;
}) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  function handleSubmit(e: React.MouseEvent<HTMLButtonElement>) {
    const form = e.currentTarget.closest("[data-form]") as HTMLElement;
    const data = new FormData();
    form.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>("[name]").forEach((el) => {
      if (el.type === "radio" && !(el as HTMLInputElement).checked) return;
      data.append(el.name, el.value);
    });

    setError(null);
    start(async () => {
      const res = await submitSelfReport(token, data);
      if (res?.error) setError(res.error);
      else setSaved(true);
    });
  }

  return (
    <div data-form>
      {questions.map((q) => (
        <div className="field" key={q.key}>
          {q.input === "choice" ? (
            <fieldset style={{ border: 0, margin: 0, padding: 0 }}>
              <legend>
                {q.label}
                {!q.required && <span style={{ color: "var(--mute)", fontWeight: 400 }}> · optioneel</span>}
              </legend>
              {q.hint && <p className="hint">{q.hint}</p>}
              <div className="choices">
                {q.options!.map((o) => (
                  <label key={o.value}>
                    <input
                      type="radio"
                      name={q.key}
                      value={o.value}
                      defaultChecked={initial[q.key] === o.value}
                    />
                    <span>{o.label}</span>
                  </label>
                ))}
              </div>
            </fieldset>
          ) : (
            <>
              <label htmlFor={q.key}>
                {q.label}
                {!q.required && <span style={{ color: "var(--mute)", fontWeight: 400 }}> · optioneel</span>}
              </label>
              {q.hint && <p className="hint">{q.hint}</p>}
              {q.key === "remarks" ? (
                <textarea id={q.key} name={q.key} defaultValue={(initial[q.key] as string) ?? ""} />
              ) : (
                <input
                  id={q.key}
                  name={q.key}
                  type={q.input === "number" ? "number" : "text"}
                  inputMode={q.input === "number" ? "numeric" : undefined}
                  min={q.input === "number" ? 0 : undefined}
                  defaultValue={(initial[q.key] as string) ?? ""}
                />
              )}
            </>
          )}

          {/* Dezelfde vraag, zoals de assistent hem uitspreekt. */}
          <p className="spoken">{q.spoken.replace("{{partner}}", "uw organisatie")}</p>
        </div>
      ))}

      {error && (
        <p style={{ color: "var(--halt)", fontSize: 15 }} role="alert">
          {error}
        </p>
      )}

      <div style={{ display: "flex", alignItems: "center", gap: 16, marginTop: 24 }}>
        <button className="btn" onClick={handleSubmit} disabled={pending}>
          {pending ? "Bezig…" : saved ? "Opgeslagen" : "Doorgeven"}
        </button>
        {saved && (
          <span style={{ fontSize: 15, color: "var(--signal)" }}>
            Dank u — we bellen u hier niet meer over.
          </span>
        )}
      </div>
    </div>
  );
}
