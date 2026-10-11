import { apiFetch, type Tab } from "./api.js";
import { DebugPanel } from "./DebugPanel.js";
import type { Factor, Constraint, Result } from "../server/readiness/types.js";
import { CoachWorkspace } from "./CoachWorkspace.js";
import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import "./style.css";

type Activity = {
  activity_id: string;
  startLocal?: string | null;
  activity_date: string;
  name: string;
  category: string;
  duration_min: number | null;
  training_load: number | null;
  avg_power: number | null;
};
type Meal = {
  id?: number;
  date: string;
  meal_type: string;
  description: string;
  calories: number | null;
  protein_g: number | null;
  carbs_g: number | null;
  fat_g: number | null;
};
type Daily = {
  date: string;
  weight: number | null;
  calories_in: number | null;
  protein_g: number | null;
  carbs_g: number | null;
  fat_g: number | null;
  exercise_kcal: number | null;
  training_load: number | null;
};
type Overview = {
  dataSource?: string;
  status: string;
  snapshotUpdatedAt: string | null;
  snapshotVerified: boolean;
  history: {
    available: boolean;
    limitation: string;
    entries: {
      date: string;
      observed_at: string;
      score: number | null;
      confidence: number;
      recommendation: string;
    }[];
  };
  activities: Activity[];
  meals: Meal[];
  daily: Daily[];
  prescription?: {
    recommendation: string;
    constraints: Constraint[];
    limitingFactors: Constraint[];
  };
  readiness: Result;
};
const nf = (value: number | null | undefined, suffix = "") =>
  value === null || value === undefined
    ? "—"
    : Math.round(value).toLocaleString("it-IT") + suffix;
const metric = (value: number | null | undefined) =>
  value == null
    ? "—"
    : value.toLocaleString("it-IT", {
        minimumFractionDigits: 1,
        maximumFractionDigits: 1,
      });
const categories: { key: Factor["category"]; label: string }[] = [
  { key: "physiology", label: "Recupero misurato" },
  { key: "load", label: "Carico" },
  { key: "activity", label: "Attività eseguite" },
  { key: "feedback", label: "Sensazioni e tempi" },
  { key: "data", label: "Dati e affidabilità" },
  { key: "schedule", label: "Calendario" },
  { key: "plan", label: "Piano" },
  { key: "request", label: "Richiesta" },
];
const markers: Record<Factor["polarity"], string> = {
  positive: "✓ Positivo",
  negative: "! Negativo",
  neutral: "• Neutro",
  uncertain: "? Incerto",
};
const date = (s: string) => {
  const d = new Date(s + "T12:00:00");
  return Number.isNaN(d.valueOf())
    ? s
    : d.toLocaleDateString("it-IT", { day: "2-digit", month: "short" });
};
function App() {
  const [tab, setTab] = useState<Tab>("summary");
  const [authorized, setAuthorized] = useState<boolean | null>(null);
  const [data, setData] = useState<Overview | null>(null);
  const [dayMeals, setDayMeals] = useState<Meal[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const refresh = async () => {
    setLoading(true);
    try {
      const day = new Intl.DateTimeFormat("en-CA", {
        timeZone: "Europe/Rome",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).format(new Date());
      setData((previous) =>
        previous?.readiness.date === day ? previous : null,
      );
      setDayMeals((previous) => previous.filter((m) => m.date === day));
      const mealsResponse = await apiFetch(`/api/day/${day}`);
      if (mealsResponse.ok) setDayMeals((await mealsResponse.json()).meals);
      const r = await apiFetch("/api/overview");
      if (r.status === 401) {
        setAuthorized(false);
        return;
      }
      if (!r.ok)
        throw new Error(
          "Dati non disponibili. Le altre funzioni restano accessibili.",
        );
      setData(await r.json());
      setError("");
    } catch (e) {
      setData(null);
      setError(String(e));
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    const romeDay = () =>
      new Intl.DateTimeFormat("en-CA", {
        timeZone: "Europe/Rome",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).format(new Date());
    let observedDay = romeDay();
    const checkDay = () => {
      const next = romeDay();
      if (next !== observedDay) {
        observedDay = next;
        void refresh();
      }
    };
    const timer = window.setInterval(checkDay, 30000);
    document.addEventListener("visibilitychange", checkDay);
    void apiFetch("/api/access")
      .then((r) => {
        setAuthorized(r.ok);
        if (r.ok) void refresh();
      })
      .catch(() => {
        setAuthorized(false);
      });
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", checkDay);
    };
  }, []);
  const tabs: [Tab, string][] = [
    ["summary", "Riepilogo"],
    ["training", "Allenamento"],
    ["nutrition", "Alimentazione"],
    ["debug", "Debug"],
  ];
  const nutritionDay = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Rome",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
  const todayMeals = dayMeals;
  const last = data?.daily.find((d) => d.date === nutritionDay);

  return (
    <div className="shell">
      <header>
        <div className="brand">
          <span className="brandmark">C</span>
          <div>
            <strong>Coach AI</strong>
            <small>Performance & Nutrition</small>
          </div>
        </div>
        <span className="tag">Il tuo coach quotidiano</span>
      </header>
      <main>
        {authorized !== true ? (
          <section className="panel">
            <h1>
              {authorized === null
                ? "Connessione…"
                : "Apri Coach AI da Home Assistant"}
            </h1>
            <p>
              L’accesso web usa la sessione Home Assistant Ingress. Un
              collegamento diretto alla porta 8099 non apre i dati e richiede
              autenticazione API Bearer.
            </p>
            <p>Nessun token deve essere inserito in questa interfaccia.</p>
          </section>
        ) : (
          <>
            <nav className="tabs" role="tablist" aria-label="Sezioni Coach AI">
              {tabs.map(([key, label], i) => (
                <button
                  key={key}
                  id={`tab-${key}`}
                  role="tab"
                  aria-selected={tab === key}
                  aria-controls={`panel-${key} workspace-${key}`}
                  tabIndex={tab === key ? 0 : -1}
                  onClick={() => setTab(key)}
                  onKeyDown={(e) => {
                    const next =
                      e.key === "ArrowRight"
                        ? (i + 1) % 4
                        : e.key === "ArrowLeft"
                          ? (i + 3) % 4
                          : e.key === "Home"
                            ? 0
                            : e.key === "End"
                              ? 3
                              : -1;
                    if (next >= 0) {
                      e.preventDefault();
                      setTab(tabs[next][0]);
                      document.getElementById(`tab-${tabs[next][0]}`)?.focus();
                    }
                  }}
                >
                  {label}
                </button>
              ))}
            </nav>
            <div className="heading">
              <div>
                <p className="eyebrow">DASHBOARD</p>
                <h1>{tabs.find(([key]) => key === tab)![1]}</h1>
                <p className="muted">
                  Recupero e carico guidano la proposta. I dati mancanti
                  riducono l’affidabilità.
                </p>
              </div>
              <button onClick={() => void refresh()} disabled={loading}>
                {loading ? "Caricamento…" : "Aggiorna"}
              </button>
            </div>
            {error && (
              <div className="error" role="alert">
                {error}
              </div>
            )}
            {data?.status === "waiting_for_snapshot" && (
              <div className="notice">
                Snapshot non ancora disponibile. La valutazione resta prudente
                finché la sincronizzazione non è configurata.
              </div>
            )}
            {data?.snapshotUpdatedAt && (
              <div className="notice">
                Ultimo snapshot:{" "}
                {new Date(data.snapshotUpdatedAt).toLocaleString("it-IT", {
                  timeZone: "Europe/Rome",
                })}{" "}
                (Europe/Rome).{" "}
                {data.snapshotVerified
                  ? "Sincronizzazione verificata."
                  : "Data del file; sincronizzazione non verificata."}
              </div>
            )}
            <div
              id="panel-summary"
              role="tabpanel"
              aria-labelledby="tab-summary"
              hidden={tab !== "summary"}
            >
              <section
                className="panel readiness"
                aria-label="Readiness e raccomandazione"
              >
                <div className="readiness-top">
                  <div>
                    <p className="eyebrow">
                      READINESS · {data?.readiness.date ?? "oggi"}
                    </p>
                    <div className="score">
                      {nf(data?.readiness.score)}
                      <span>/100</span>
                    </div>
                    <p className="muted">
                      {!data ||
                      data.readiness.assessmentState === "missing_data"
                        ? data?.readiness.score == null
                          ? "Dati insufficienti per valutare la disponibilità"
                          : "Valutazione parziale · rispettare i limiti prudenti"
                        : data.readiness.assessmentState ===
                            "insufficient_recovery"
                          ? "Recupero da privilegiare · valutazione prudenziale"
                          : "Allenamento possibile entro i limiti indicati"}
                    </p>
                  </div>
                  <div className="recommendation">
                    <p className="eyebrow">PROPOSTA DI OGGI</p>
                    <h2>
                      {data?.prescription?.recommendation ??
                        data?.readiness.recommendation ??
                        "Valutazione in corso"}
                    </h2>
                    <p>
                      Affidabilità (confidence){" "}
                      <strong>{nf(data?.readiness.confidence, "/100")}</strong>
                    </p>
                    <p className="muted">
                      {
                        {
                          complete: "Valutazione completa",
                          provisional: "Valutazione provvisoria",
                          unavailable: "Non valutabile",
                        }[data?.readiness.completeness ?? "unavailable"]
                      }{" "}
                      · FTP operativa {data?.readiness.profile.ftp ?? "—"} W
                    </p>
                  </div>
                </div>
                <div className="metrics">
                  <div className="stat">
                    <span>CTL · forma</span>
                    <b>{metric(data?.readiness.metrics.ctl)}</b>
                  </div>
                  <div className="stat">
                    <span>ATL · fatica</span>
                    <b>{metric(data?.readiness.metrics.atl)}</b>
                  </div>
                  <div className="stat">
                    <span>TSB · equilibrio</span>
                    <b>{metric(data?.readiness.metrics.tsb)}</b>
                  </div>
                </div>
                <p className="muted">
                  La raccomandazione tiene conto di carico, recupero e copertura
                  dei dati. Un punteggio alto con confidence bassa non autorizza
                  allenamenti intensi.
                </p>
                <div className="prescription-limits">
                  <h3>Cosa limita la proposta</h3>
                  {data?.prescription?.constraints.some((c) => c.applied) ? (
                    <ul>
                      {data.prescription.constraints
                        .filter((c) => c.applied)
                        .map((c, i) => (
                          <li key={c.code + String(i)}>
                            <span className={`factor-marker ${c.polarity}`}>
                              {markers[c.polarity]}
                            </span>
                            {c.text}
                          </li>
                        ))}
                    </ul>
                  ) : (
                    <p className="muted">
                      Nessun limite aggiuntivo rilevato rispetto al punteggio.
                    </p>
                  )}
                </div>
                <div className="factor-groups">
                  {categories
                    .filter(
                      (group) =>
                        group.key !== "activity" && group.key !== "data",
                    )
                    .map((group) => {
                      const factors = (data?.readiness.factors ?? []).filter(
                        (f) =>
                          f.category === group.key &&
                          !(data?.prescription?.constraints ?? []).some(
                            (c) => c.applied && c.code === f.code,
                          ),
                      );
                      return factors.length ? (
                        <section key={group.key}>
                          <h3>{group.label}</h3>
                          <ul>
                            {factors.slice(0, 3).map((f, i) => (
                              <li key={f.code + i}>
                                <span className={`factor-marker ${f.polarity}`}>
                                  {markers[f.polarity]}
                                </span>
                                {f.text}
                              </li>
                            ))}
                          </ul>
                        </section>
                      ) : null;
                    })}
                </div>
                <details>
                  <summary>
                    Spiegazione tecnica completa e dati mancanti
                  </summary>
                  {categories.map((group) => {
                    const factors = (data?.readiness.factors ?? []).filter(
                      (f) => f.category === group.key,
                    );
                    return factors.length ? (
                      <section key={group.key}>
                        <h3>{group.label}</h3>
                        <ul>
                          {factors.map((f, i) => (
                            <li key={f.code + i}>
                              <span className={`factor-marker ${f.polarity}`}>
                                {markers[f.polarity]}
                              </span>
                              {f.text}
                              <small className="technical-code">
                                {f.code} · {f.evidence}
                              </small>
                            </li>
                          ))}
                        </ul>
                      </section>
                    ) : null;
                  })}
                  <h3>Regole di prescrizione, in ordine</h3>
                  <ol>
                    {data?.prescription?.constraints.map((c, i) => (
                      <li key={c.code + i}>
                        {c.text}{" "}
                        <small>
                          {c.source}: {c.before} → {c.after}
                          {c.applied
                            ? " · limite applicato"
                            : " · non riduce ulteriormente"}
                          {c.blocksRequested ? " · impedisce la richiesta" : ""}
                        </small>
                      </li>
                    ))}
                  </ol>
                </details>
              </section>
              <details className="panel history">
                <summary>Andamento Readiness registrato</summary>
                <h2>Andamento Readiness</h2>
                <p className="muted">
                  {data?.history.limitation ??
                    "Caricamento delle valutazioni registrate…"}
                </p>
                {!data?.history.available ||
                data.history.entries.filter((e) => e.score !== null).length <
                  2 ? (
                  <p>
                    Storico non ancora sufficiente per mostrare un andamento.
                    Sono registrate solo le valutazioni effettuate da questa
                    versione.
                  </p>
                ) : (
                  <div className="tablewrap">
                    <table>
                      <thead>
                        <tr>
                          <th>Giorno</th>
                          <th>Readiness</th>
                          <th>Confidence</th>
                          <th>Proposta</th>
                        </tr>
                      </thead>
                      <tbody>
                        {data.history.entries.map((e) => (
                          <tr key={e.date}>
                            <td>{date(e.date)}</td>
                            <td>
                              <span
                                className="trend-bar"
                                style={{ width: `${e.score ?? 0}%` }}
                              />
                              {nf(e.score, "/100")}
                            </td>
                            <td>{nf(e.confidence, "/100")}</td>
                            <td>{e.recommendation}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </details>
              <section className="split">
                <article className="panel">
                  <div className="panel-title">
                    <h2>Ultima attività</h2>
                    <span>Intervals.icu via SQLite</span>
                  </div>
                  <div className="entries">
                    {data?.activities.length ? (
                      data.activities.slice(0, 1).map((a, i) => (
                        <div className="entry" key={a.activity_id}>
                          <div>
                            <strong>{a.name || "Attività"}</strong>
                            <small>
                              {date(a.activity_date)}
                              {a.startLocal
                                ? " · " + a.startLocal.slice(11, 16)
                                : ""}{" "}
                              · {a.category || "—"}
                            </small>
                          </div>
                          <div className="right">
                            <strong>{nf(a.duration_min, " min")}</strong>
                            <small>
                              {nf(a.training_load, " load")} ·{" "}
                              {nf(a.avg_power, " W")}
                            </small>
                          </div>
                        </div>
                      ))
                    ) : (
                      <p className="muted empty">
                        Nessuna attività presente nello snapshot.
                      </p>
                    )}
                  </div>
                </article>
                <article className="panel">
                  <div className="panel-title">
                    <h2>Alimentazione di oggi</h2>
                    <span>{nutritionDay} · Europe/Rome</span>
                  </div>
                  <div className="entries">
                    {todayMeals.length ? (
                      todayMeals.map((m, i) => (
                        <div className="entry" key={i}>
                          <div>
                            <strong>{m.meal_type || "Pasto"}</strong>
                            <small>
                              {date(m.date)} · {m.description || "—"}
                            </small>
                          </div>
                          <div className="right">
                            <strong>{nf(m.calories, " kcal")}</strong>
                            <small>
                              P {nf(m.protein_g, "g")} · C {nf(m.carbs_g, "g")}{" "}
                              · F {nf(m.fat_g, "g")}
                            </small>
                          </div>
                        </div>
                      ))
                    ) : (
                      <p className="muted empty">
                        Nessun pasto registrato oggi.
                      </p>
                    )}
                  </div>
                </article>
              </section>
            </div>
            <section
              id="panel-training"
              role="tabpanel"
              aria-labelledby="tab-training"
              hidden={tab !== "training"}
            >
              <p className="notice">
                Le proposte rispettano Readiness e limiti: una richiesta intensa
                può ricevere un’alternativa motivata. La selezione è locale;
                Intervals rimane in sola lettura.
              </p>
            </section>
            <section
              id="panel-nutrition"
              role="tabpanel"
              aria-labelledby="tab-nutrition"
              hidden={tab !== "nutrition"}
              className="panel"
            >
              <h2>Totali di oggi</h2>
              <p>
                {last
                  ? "Riepilogo giornaliero registrato"
                  : "Totali dei pasti odierni registrati"}
              </p>
              <div className="metrics">
                {(
                  [
                    ["calories_in", "calories", "kcal"],
                    ["protein_g", "protein_g", "Proteine g"],
                    ["carbs_g", "carbs_g", "Carboidrati g"],
                    ["fat_g", "fat_g", "Grassi g"],
                  ] as const
                ).map(([dailyKey, mealKey, label]) => (
                  <div className="stat" key={dailyKey}>
                    <span>{label}</span>
                    <b>
                      {nf(
                        last?.[dailyKey] ??
                          (todayMeals.length &&
                          todayMeals.every((m) => m[mealKey] != null)
                            ? todayMeals.reduce(
                                (sum, m) => sum + m[mealKey]!,
                                0,
                              )
                            : null),
                      )}
                    </b>
                  </div>
                ))}
              </div>
            </section>
            <section
              id="panel-debug"
              role="tabpanel"
              aria-labelledby="tab-debug"
              hidden={tab !== "debug"}
            >
              <DebugPanel active={tab === "debug"} />
            </section>
            <CoachWorkspace tab={tab} meals={dayMeals} refresh={refresh} />
          </>
        )}
        <footer>
          Coach AI Web 0.8.0 ·{" "}
          {data?.dataSource === "local"
            ? "Database applicativo locale"
            : "Snapshot SQLite in sola lettura"}{" "}
          · Integrazioni secondo configurazione
        </footer>
      </main>
    </div>
  );
}
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
