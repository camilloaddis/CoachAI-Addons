import React, { useEffect, useState } from "react";
import { apiFetch } from "./api.js";
import {
  FactorGroups,
  recommendationLabel,
  scoreLabel,
} from "./DecisionExplanation.js";
import type { Factor, Result } from "../server/readiness/types.js";
import type { MetricDiagnostic } from "../server/readiness/diagnostics.js";
type Diagnostics = {
  metrics: MetricDiagnostic[];
  cache: {
    lastSyncAt: string | null;
    fresh: boolean;
    coveredDays: number;
    expectedDays: number;
    latestWellnessDate: string | null;
  };
  integrations: Record<string, boolean>;
  normalized: {
    score?: number | null;
    confidence?: number;
    completeness?: Result["completeness"];
    physiology?: Result["physiology"];
    planner?: {
      mode: string;
      recommendation: string;
      week: number | null;
      phase: string | null;
    };
  };
  classification: object[];
  missing: string[];
  factors: Factor[];
  limits: object[];
  events: object[];
};
export function DebugPanel({ active }: { active: boolean }) {
  const [data, setData] = useState<Diagnostics | null>(null),
    [error, setError] = useState("");
  async function load() {
    try {
      const r = await apiFetch("/api/diagnostics");
      if (!r.ok) throw Error();
      setData(await r.json());
      setError("");
    } catch {
      setError(
        "Diagnostica non disponibile. Nessuna credenziale viene mostrata.",
      );
    }
  }
  useEffect(() => {
    if (active) void load();
  }, [active]);
  return (
    <section className="panel">
      <h2>Diagnostica</h2>
      <button onClick={() => void load()}>Aggiorna diagnostica</button>
      {error && <p role="alert">{error}</p>}
      {data && (
        <>
          <p>
            Ultima acquisizione: {data.cache.lastSyncAt ?? "non registrata"} ·
            Cache {data.cache.fresh ? "fresca" : "scaduta o non disponibile"} ·
            Copertura {data.cache.coveredDays}/{data.cache.expectedDays} giorni
            · Ultimo wellness {data.cache.latestWellnessDate ?? "assente"}
          </p>
          <div
            className="decision-overview diagnostic-decisions"
            aria-label="Responsabilità del motore"
          >
            <section>
              <h3>Readiness · fisiologia</h3>
              <p>{scoreLabel(data.normalized.score)}</p>
              <p className="muted">
                Solo valutazione del recupero. Le correzioni del punteggio sono
                consultabili nei dati normalizzati.
              </p>
            </section>
            <section>
              <h3>Confidence · qualità dati</h3>
              <p>{scoreLabel(data.normalized.confidence)}</p>
              <p className="muted">
                Non applica ceiling e non abbassa Readiness.
              </p>
              <FactorGroups
                factors={data.factors.filter((f) =>
                  f.code.startsWith("confidence_"),
                )}
                technical
              />
            </section>
            <section>
              <h3>Planner · consiglio automatico</h3>
              <p>
                {data.normalized.planner
                  ? recommendationLabel(data.normalized.planner.recommendation)
                  : "Non disponibile"}
              </p>
              <p className="muted">
                Calendario, storico misurato e precauzioni sui dati. Non
                descrive una richiesta manuale.
              </p>
              {data.normalized.planner && (
                <p>
                  Fase: {data.normalized.planner.phase ?? "non disponibile"} ·
                  Settimana: {data.normalized.planner.week ?? "—"}
                </p>
              )}
            </section>
          </div>
          <div className="metric-diagnostics">
            {data.metrics.map((m) => (
              <article className="stat" key={m.key}>
                <h3>{m.label}</h3>
                <b>{m.normalized ?? "—"}</b>
                <p>{m.source}</p>
                <p>
                  Giorno fonte: {m.sourceDate ?? "non disponibile"}
                  <br />
                  Misurazione: {m.sourceTimestamp ?? "istante non disponibile"}
                  <br />
                  Acquisizione: {m.acquiredAt ?? "non registrata"}
                </p>
                <p>
                  Grezzo: {m.raw ?? "non disponibile"} · Stato: {m.state}
                </p>
                {m.fallback && (
                  <p>
                    Riferimento obsoleto: {m.fallback.value} ({m.fallback.date}
                    ), solo visualizzazione.
                  </p>
                )}
                {m.baseline && (
                  <p>
                    Baseline: {m.baseline.value ?? "non disponibile"} ·{" "}
                    {m.baseline.samples} osservazioni
                  </p>
                )}
                {m.scoreEligible !== undefined && (
                  <p>
                    {m.scoreEligible
                      ? "Utilizzata nel punteggio"
                      : "Esclusa dal punteggio"}
                  </p>
                )}
                <p>{m.reason}</p>
              </article>
            ))}
          </div>
          <h3>Dati mancanti e incertezze</h3>
          <ul>
            {data.missing.map((m, i) => (
              <li key={i}>{m}</li>
            ))}
          </ul>
          {(
            [
              ["Stato integrazioni", data.integrations],
              ["Metriche normalizzate", data.normalized],
              ["Classificazione attività anonimizzata", data.classification],
              ["Motivazioni strutturate", data.factors],
              [
                "Catena dei limiti automatici (anche non applicati)",
                data.limits,
              ],
              ["Log diagnostici", data.events],
            ] as const
          ).map(([label, value]) => (
            <details key={label}>
              <summary>{label}</summary>
              <pre>{JSON.stringify(value, null, 2)}</pre>
            </details>
          ))}
        </>
      )}
    </section>
  );
}
