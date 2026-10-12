import { LibrarySettings } from "./LibrarySettings.js";
import { LanLogin } from "./LanLogin.js";
import packageMetadata from "../package.json";
import { apiFetch, type Tab } from "./api.js";
import { ReadinessPanel } from "./ReadinessPanel.js";
import { DebugPanel } from "./DebugPanel.js";
import type { Constraint, Result } from "../server/readiness/types.js";
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
      model_version?: string;
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
const date = (s: string) => {
  const d = new Date(s + "T12:00:00");
  return Number.isNaN(d.valueOf())
    ? s
    : d.toLocaleDateString("it-IT", { day: "2-digit", month: "short" });
};
function App() {
  const [tab, setTab] = useState<Tab>("today");
  const [authorized, setAuthorized] = useState<boolean | null>(null);
  const [lanEnabled, setLanEnabled] = useState(false);
  const [session, setSession] = useState(false);
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
    const unauthorized = () => { setAuthorized(false); setData(null); setDayMeals([]); setSession(false); };
    window.addEventListener("coachai-unauthorized", unauthorized);
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
      .then(async (r) => {
        setAuthorized(r.ok);
        if (r.ok) {
          const sessionAccess = (await r.json()).method === "session";
          setSession(sessionAccess); setLanEnabled(sessionAccess); void refresh();
        } else {
          const config = await apiFetch("/auth/config");
          if (config.ok) setLanEnabled((await config.json()).lanEnabled === true);
        }
      })
      .catch(() => {
        setAuthorized(false);
      });
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("coachai-unauthorized", unauthorized);
      document.removeEventListener("visibilitychange", checkDay);
    };
  }, []);
  const tabs: [Tab, string][] = [
    ["today", "Training"],
    ["meal", "Pasto"],
    ["trends", "Trend"],
    ["settings", "Impostazioni"],
  ];
  const nutritionDay = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Rome",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
  const last = data?.daily.find((d) => d.date === nutritionDay);

  return (
    <div className="shell">
      <header>
        <div className="brand">
          <span className="brandmark">C</span>
        </div>
        {authorized === true && (
          <div className="header-actions">
          {session && <button onClick={async () => {
            try {
              const response = await apiFetch("/auth/session", { method: "DELETE" });
              if (!response.ok) throw new Error();
              setAuthorized(false); setSession(false); setData(null); setDayMeals([]); setTab("today");
            } catch { setError("Disconnessione non riuscita. Riprova."); }
          }}>Esci</button>}
          <button className="reload-button" aria-label={loading ? "Aggiornamento in corso" : "Aggiorna"}
            title="Aggiorna" disabled={loading} aria-busy={loading} onClick={() => void refresh()}>
            {/* Lucide: rotate-cw. License: web/lucide-LICENSE.txt. */}
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
              <path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8" />
              <path d="M21 3v5h-5" />
            </svg>
          </button>
          </div>
        )}
      </header>
      <main>
        {authorized !== true ? (
          authorized === false && lanEnabled ? <LanLogin onLogin={() => {
            setAuthorized(true); setSession(true); setTab("today"); void refresh();
          }} /> :
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
                  aria-label={label}
                  title={label}
                  aria-selected={tab === key}
                  aria-controls={key === "today" ? "panel-today workspace-training" : key === "meal" ? "workspace-nutrition" : key === "trends" ? "panel-trends workspace-trends" : "panel-settings workspace-debug workspace-summary"}
                  tabIndex={tab === key ? 0 : -1}
                  onClick={() => setTab(key)}
                  onKeyDown={(e) => {
                    const next =
                      e.key === "ArrowRight"
                        ? (i + 1) % tabs.length
                        : e.key === "ArrowLeft"
                          ? (i + tabs.length - 1) % tabs.length
                          : e.key === "Home"
                            ? 0
                            : e.key === "End"
                              ? tabs.length - 1
                              : -1;
                    if (next >= 0) {
                      e.preventDefault();
                      setTab(tabs[next][0]);
                      document.getElementById(`tab-${tabs[next][0]}`)?.focus();
                    }
                  }}
                >
                  {/* Lucide: bike, utensils, chart-no-axes-column, settings. License: web/lucide-LICENSE.txt. */}
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
                    {key === "today" ? <>
                      <circle cx="18.5" cy="17.5" r="3.5" />
                      <circle cx="5.5" cy="17.5" r="3.5" />
                      <circle cx="15" cy="5" r="1" />
                      <path d="M12 17.5V14l-3-3 4-3 2 3h2" />
                    </> : key === "meal" ? <>
                      <path d="M3 2v7c0 1.1.9 2 2 2h4a2 2 0 0 0 2-2V2" />
                      <path d="M7 2v20" />
                      <path d="M21 15V2a5 5 0 0 0-5 5v6c0 1.1.9 2 2 2h3Zm0 0v7" />
                    </> : key === "settings" ? <>
              <path d="M9.671 4.136a2.34 2.34 0 0 1 4.659 0 2.34 2.34 0 0 0 3.319 1.915 2.34 2.34 0 0 1 2.33 4.033 2.34 2.34 0 0 0 0 3.831 2.34 2.34 0 0 1-2.33 4.033 2.34 2.34 0 0 0-3.319 1.915 2.34 2.34 0 0 1-4.659 0 2.34 2.34 0 0 0-3.32-1.915 2.34 2.34 0 0 1-2.33-4.033 2.34 2.34 0 0 0 0-3.831A2.34 2.34 0 0 1 6.35 6.051a2.34 2.34 0 0 0 3.319-1.915" />
              <circle cx="12" cy="12" r="3" />
                    </> : <>
                      <path d="M5 21v-6" />
                      <path d="M12 21V3" />
                      <path d="M19 21V9" />
                    </>}
                  </svg>
                </button>
              ))}
            </nav>
            {tab === "settings" && <div className="heading">
              <div>
                <h1>Impostazioni</h1>
                <p className="muted">Gestisci la configurazione del coach e delle integrazioni.</p>
              </div>
            </div>}
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
              id="panel-today"
              role="tabpanel"
              aria-labelledby="tab-today"
              hidden={tab !== "today"}
            >
              <ReadinessPanel
                readiness={data?.readiness ?? null}
                prescription={data?.prescription}
              />
            </div>
            <CoachWorkspace tab={tab} meals={dayMeals} refresh={refresh} activities={data?.activities ?? []} exerciseKcal={last?.exercise_kcal} />
            <section
              id="panel-trends"
              role="tabpanel"
              aria-labelledby="tab-trends"
              hidden={tab !== "trends"}
              className="panel"
            >
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
                    Sono mostrate solo valutazioni realmente registrate.
                  </p>
                ) : (
                  <div className="tablewrap">
                    <table>
                      <thead>
                        <tr>
                          <th>Giorno</th>
                          <th>Modello</th>
                          <th>Readiness</th>
                          <th>Confidence</th>
                          <th>Proposta</th>
                        </tr>
                      </thead>
                      <tbody>
                        {data.history.entries.map((e) => (
                          <tr key={`${e.date}:${e.model_version ?? "legacy"}`}>
                            <td>{date(e.date)}</td>
                            <td>
                              {!e.model_version || e.model_version === "legacy"
                                ? "Legacy (non registrato)"
                                : e.model_version}
                            </td>
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
              <h2>Totali registrati oggi</h2>
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
                          (dayMeals.length &&
                          dayMeals.every((m) => m[mealKey] != null)
                            ? dayMeals.reduce(
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
              id="panel-settings"
              role="region"
              aria-labelledby="tab-settings"
              hidden={tab !== "settings"}
            >
              <LibrarySettings active={tab === "settings"} />
              <details><summary>Diagnostica avanzata</summary><DebugPanel active={tab === "settings"} /></details>
            </section>
          </>
        )}
        <footer>
          Coach AI Web {packageMetadata.version} ·{" "}
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
