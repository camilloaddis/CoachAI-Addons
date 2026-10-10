import React, { useRef, useState } from "react";
import type { Proposal } from "../server/coach/training.js";
import type { NutritionMeal } from "../server/coach/groq.js";

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
type Activity = { activity_id: string; activity_date: string; name: string };
type CoachState = {
  activities: Activity[];
  groqEnabled: boolean;
  config: Proposal["config"];
  selected: string | null;
  proposals: { id: string; proposal: Proposal }[];
  drafts: { id: string; meals: NutritionMeal[] }[];
  reports: { daily: string; weekly: string; weight: string };
  recovery: { legs: number; observation_date: string; note: string | null }[];
  feedback: {
    activity_id: string;
    legs: number;
    note: string | null;
    context: string;
  }[];
};
const randomKey = () =>
  Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
const localDay = () =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Rome",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
const emptyMeal = (): Meal => ({
  date: localDay(),
  meal_type: "pranzo",
  description: "",
  calories: 0,
  protein_g: 0,
  carbs_g: 0,
  fat_g: 0,
});
export function CoachWorkspace({
  activities,
  meals,
  refresh,
}: {
  activities: Activity[];
  meals: Meal[];
  refresh: () => Promise<void>;
}) {
  const [token, setToken] = useState(""),
    [connected, setConnected] = useState(false),
    [state, setState] = useState<CoachState | null>(null);
  const [busy, setBusy] = useState(false),
    [message, setMessage] = useState("");
  const [proposal, setProposal] = useState<{
    id: string;
    proposal: Proposal;
  } | null>(null);
  const [meal, setMeal] = useState<Meal>(emptyMeal),
    [activity, setActivity] = useState(""),
    [legs, setLegs] = useState(3),
    [note, setNote] = useState("");
  const [recovery, setRecovery] = useState(3),
    [recoveryNote, setRecoveryNote] = useState(""),
    [nutritionText, setNutritionText] = useState("");
  const [archiveMeals, setArchiveMeals] = useState<Meal[] | null>(null);
  const [draft, setDraft] = useState<{
    id: string;
    meals: NutritionMeal[];
  } | null>(null);
  const keys = useRef(new Map<string, string>());
  async function api(path: string, body?: object, key?: string) {
    const r = await fetch(path, {
      method: body ? "POST" : "GET",
      cache: "no-store",
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body
          ? { "Content-Type": "application/json", "Idempotency-Key": key! }
          : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!r.ok) {
      const error = await r.json().catch(() => ({}));
      if (error.error === "stale_proposal")
        throw new Error(
          "La proposta non è più compatibile con lo stato attuale: genera un nuovo allenamento.",
        );
      if (r.status === 401) {
        setConnected(false);
        throw new Error("Token amministrativo non valido.");
      }
      throw new Error(
        r.status === 400
          ? "Controlla i valori inseriti; la richiesta non è stata salvata."
          : r.status === 409
            ? "Le modifiche richiedono il database locale definitivo."
            : "Operazione non completata. Puoi riprovare con gli stessi dati senza duplicarli.",
      );
    }
    return r.json();
  }
  async function load() {
    const s = (await api("/api/coach")) as CoachState;
    setState(s);
    if (!proposal && s.proposals.length) setProposal(s.proposals[0]);
    if (!draft && s.drafts.length) setDraft(s.drafts[0]);
    return s;
  }
  async function action(name: string, body: object) {
    const signature = JSON.stringify({ name, body });
    let key = keys.current.get(signature);
    if (!key) {
      key = randomKey();
      keys.current.set(signature, key);
    }
    const result = await api(`/api/coach/${name}`, body, key);
    await load();
    await refresh();
    setArchiveMeals(null);
    keys.current.delete(signature);
    return result;
  }
  async function perform(work: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setMessage("");
    try {
      await work();
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "Operazione non completata.");
    } finally {
      setBusy(false);
    }
  }
  async function generate(request: string, regenerate = false) {
    await perform(async () => {
      const p = await action("workout", { request, regenerate });
      setProposal(p);
    });
  }
  return (
    <section className="card coach-workspace">
      <h2>Il tuo Coach</h2>
      <p className="muted">
        Accedi per registrare dati e gestire il piano. Il token resta in memoria
        fino alla chiusura o al blocco della sessione.
      </p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void perform(async () => {
            await load();
            setConnected(true);
          });
        }}
        className="web-form"
      >
        <label>
          Token amministrativo
          <input
            type="password"
            autoComplete="off"
            value={token}
            onChange={(e) => {
              setToken(e.target.value);
              setConnected(false);
            }}
            minLength={32}
            required
          />
        </label>
        <button disabled={busy}>Accedi</button>
        <button
          type="button"
          onClick={() => {
            setToken("");
            setConnected(false);
            setState(null);
            setProposal(null);
            setDraft(null);
            keys.current.clear();
          }}
        >
          Blocca sessione
        </button>
      </form>
      {message && <p role="status">{message}</p>}
      {connected && state && (
        <fieldset disabled={busy} className="coach-fields">
          <h3>Allenamento</h3>
          <div className="actions">
            {[
              ["allenamento", "Genera"],
              ["leggero", "Leggero"],
              ["intenso", "Intenso"],
              ["ss", "Sweet Spot"],
              ["vo2max", "VO2max"],
              ["endurance", "Endurance"],
              ["forza", "Forza"],
            ].map(([request, label]) => (
              <button
                type="button"
                key={request}
                onClick={() => void generate(request)}
              >
                {label}
              </button>
            ))}
          </div>
          {proposal && (
            <article>
              <h4>{proposal.proposal.workout.name}</h4>
              <p>
                {proposal.proposal.requestSatisfied
                  ? "Richiesta soddisfatta"
                  : "Proposta alternativa: richiesta limitata"}{" "}
                · {proposal.proposal.duration} min ·{" "}
                {proposal.proposal.recommendation}
              </p>
              <ul>
                {[
                  ...new Set(
                    proposal.proposal.limitingFactors.map((c) => c.text),
                  ),
                ].map((t) => (
                  <li key={t}>{t}</li>
                ))}
              </ul>
              <pre className="workout-structure">
                {proposal.proposal.workout.structure}
              </pre>
              <button
                type="button"
                onClick={() =>
                  void generate(proposal.proposal.requestCommand, true)
                }
              >
                Rigenera
              </button>{" "}
              <button
                type="button"
                onClick={() =>
                  void perform(async () => {
                    await action("select-workout", { id: proposal.id });
                    setMessage(
                      "Allenamento selezionato localmente. Nessun caricamento su Intervals.",
                    );
                  })
                }
              >
                {state.selected === proposal.id ? "Selezionato" : "Seleziona"}
              </button>
              <details>
                <summary>Spiegazione tecnica completa</summary>
                <pre>
                  {JSON.stringify(proposal.proposal.constraints, null, 2)}
                </pre>
              </details>
            </article>
          )}
          <h3>Feedback della seduta</h3>
          <p className="muted">
            Come erano le gambe durante l’attività: non è una misura del
            recupero di oggi.
          </p>
          <form
            className="web-form"
            onSubmit={(e) => {
              e.preventDefault();
              void perform(async () => {
                await action("activity-feedback", {
                  activity_id: activity,
                  legs,
                  note: note || undefined,
                });
                setMessage("Feedback retrospettivo salvato.");
              });
            }}
          >
            <label>
              Attività
              <select
                required
                value={activity}
                onChange={(e) => setActivity(e.target.value)}
              >
                <option value="">Scegli una seduta</option>
                {state.activities.map((a) => (
                  <option key={a.activity_id} value={a.activity_id}>
                    {a.activity_date} · {a.name || "Attività"}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Gambe (1 pesanti, 5 ottime)
              <input
                type="number"
                min={1}
                max={5}
                value={legs}
                onChange={(e) => setLegs(Number(e.target.value))}
              />
            </label>
            <label>
              Nota
              <input
                maxLength={2000}
                value={note}
                onChange={(e) => setNote(e.target.value)}
              />
            </label>
            <button>Salva feedback</button>
          </form>
          <h3>Recupero attuale · {localDay()}</h3>
          <form
            className="web-form"
            onSubmit={(e) => {
              e.preventDefault();
              void perform(async () => {
                await action("recovery", {
                  date: localDay(),
                  legs: recovery,
                  note: recoveryNote,
                });
                setMessage(
                  "Recupero attuale salvato separatamente dalla seduta.",
                );
              });
            }}
          >
            <label>
              Come stanno le gambe oggi?
              <input
                type="number"
                min={1}
                max={5}
                value={recovery}
                onChange={(e) => setRecovery(Number(e.target.value))}
              />
            </label>
            <label>
              Nota
              <input
                maxLength={2000}
                value={recoveryNote}
                onChange={(e) => setRecoveryNote(e.target.value)}
              />
            </label>
            <button>Salva recupero di oggi</button>
          </form>
          {state.recovery[0] && (
            <p>
              Ultima osservazione: {state.recovery[0].observation_date}, gambe{" "}
              {state.recovery[0].legs}/5.
            </p>
          )}
          <h3>Diario alimentare</h3>
          <form
            className="web-form"
            onSubmit={(e) => {
              e.preventDefault();
              void perform(async () => {
                await action(meal.id ? "edit-meal" : "meal", meal);
                setMeal(emptyMeal());
                setMessage("Pasto salvato.");
              });
            }}
          >
            <label>
              Data
              <input
                type="date"
                value={meal.date}
                max={localDay()}
                required
                onChange={(e) => setMeal({ ...meal, date: e.target.value })}
              />
            </label>
            <label>
              Pasto
              <input
                value={meal.meal_type}
                maxLength={80}
                required
                onChange={(e) =>
                  setMeal({ ...meal, meal_type: e.target.value })
                }
              />
            </label>
            <label>
              Descrizione
              <input
                value={meal.description}
                maxLength={2000}
                required
                onChange={(e) =>
                  setMeal({ ...meal, description: e.target.value })
                }
              />
            </label>
            {(
              [
                ["calories", "kcal"],
                ["protein_g", "Proteine g"],
                ["carbs_g", "Carboidrati g"],
                ["fat_g", "Grassi g"],
              ] as const
            ).map(([key, label]) => (
              <label key={key}>
                {label}
                <input
                  type="number"
                  min={0}
                  step="any"
                  required
                  value={meal[key] ?? ""}
                  onChange={(e) =>
                    setMeal({
                      ...meal,
                      [key]:
                        e.target.value === "" ? null : Number(e.target.value),
                    })
                  }
                />
              </label>
            ))}
            <button>{meal.id ? "Salva modifica" : "Registra pasto"}</button>
            <button type="button" onClick={() => setMeal(emptyMeal())}>
              Annulla modifica
            </button>
          </form>
          <label>
            Diario di un altro giorno
            <input
              type="date"
              max={localDay()}
              onChange={(e) => {
                const day = e.target.value;
                if (day)
                  void perform(async () => {
                    const result = await api(`/api/day/${day}`);
                    setArchiveMeals(result.meals);
                  });
              }}
            />
          </label>
          <button type="button" onClick={() => setArchiveMeals(null)}>
            Mostra pasti recenti
          </button>
          <ul>
            {(archiveMeals ?? meals).map((m, i) => (
              <li key={m.id ?? i}>
                {m.date} · {m.description}{" "}
                {m.id && (
                  <>
                    <button type="button" onClick={() => setMeal({ ...m })}>
                      Modifica
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        if (confirm("Eliminare questo pasto?"))
                          void perform(async () => {
                            await action("delete-meal", { id: m.id });
                          });
                      }}
                    >
                      Elimina
                    </button>
                  </>
                )}
              </li>
            ))}
          </ul>
          <button
            type="button"
            onClick={() =>
              void perform(async () => {
                await action("close-day", { date: localDay() });
                setMessage("Diario di oggi chiuso.");
              })
            }
          >
            Chiudi diario di oggi
          </button>
          <details>
            <summary>Stima alimentare assistita</summary>
            <p>
              Le stime richiedono Groq configurato. Nessun pasto viene
              registrato prima della conferma.
            </p>
            <textarea
              aria-label="Alimenti e quantità"
              maxLength={12000}
              value={nutritionText}
              onChange={(e) => setNutritionText(e.target.value)}
            />
            <button
              type="button"
              disabled={!state.groqEnabled}
              onClick={() =>
                void perform(async () => {
                  setDraft(
                    await action("nutrition-preview", { text: nutritionText }),
                  );
                })
              }
            >
              Prepara anteprima
            </button>
            {draft && (
              <>
                <p>Controlla alimenti, quantità e stime prima di confermare.</p>
                {draft.meals.map((m, i) => (
                  <article key={i}>
                    <h4>
                      {m.consumed_date} · {m.meal_type}
                    </h4>
                    {m.items.map((item, j) => (
                      <div className="web-form" key={j}>
                        {(
                          [
                            "name",
                            "quantity",
                            "calories",
                            "protein_g",
                            "carbs_g",
                            "fat_g",
                          ] as const
                        ).map((k) => (
                          <label key={k}>
                            {
                              {
                                name: "Alimento",
                                quantity: "Quantità",
                                calories: "kcal",
                                protein_g: "Proteine g",
                                carbs_g: "Carboidrati g",
                                fat_g: "Grassi g",
                              }[k]
                            }
                            <input
                              type={
                                k === "name" || k === "quantity"
                                  ? "text"
                                  : "number"
                              }
                              min={0}
                              step="any"
                              value={item[k]}
                              onChange={(e) => {
                                const edited = structuredClone(draft);
                                (
                                  edited.meals[i].items[j] as unknown as Record<
                                    string,
                                    string | number
                                  >
                                )[k] =
                                  k === "name" || k === "quantity"
                                    ? e.target.value
                                    : Number(e.target.value);
                                for (const macro of [
                                  "calories",
                                  "protein_g",
                                  "carbs_g",
                                  "fat_g",
                                ] as const)
                                  edited.meals[i].totals[macro] = edited.meals[
                                    i
                                  ].items.reduce((s, x) => s + x[macro], 0);
                                setDraft(edited);
                              }}
                            />
                          </label>
                        ))}
                      </div>
                    ))}
                  </article>
                ))}
                <button
                  type="button"
                  onClick={() =>
                    void perform(async () => {
                      await action("nutrition-confirm", {
                        id: draft.id,
                        meals: draft.meals,
                      });
                      setDraft(null);
                      setMessage("Pasti confermati e registrati.");
                    })
                  }
                >
                  Conferma
                </button>
                <button
                  type="button"
                  onClick={() =>
                    void perform(async () => {
                      await action("nutrition-cancel", { id: draft.id });
                      setDraft(null);
                    })
                  }
                >
                  Annulla
                </button>
              </>
            )}
          </details>
          <details>
            <summary>Riepiloghi</summary>
            <p style={{ whiteSpace: "pre-wrap" }}>{state.reports.daily}</p>
            <p style={{ whiteSpace: "pre-wrap" }}>{state.reports.weekly}</p>
            <p style={{ whiteSpace: "pre-wrap" }}>{state.reports.weight}</p>
          </details>
          <details>
            <summary>Configurazione Coach</summary>
            <form
              className="web-form"
              onSubmit={(e) => {
                e.preventDefault();
                const form = new FormData(e.currentTarget);
                void perform(async () => {
                  await action(
                    "settings",
                    Object.fromEntries(
                      [...form.entries()].filter(([, v]) => v !== ""),
                    ),
                  );
                  setMessage("Configurazione salvata.");
                });
              }}
            >
              <label>
                FTP W
                <input
                  name="ftp"
                  type="number"
                  min={50}
                  max={600}
                  defaultValue={state.config.ftp}
                  required
                />
              </label>
              <label>
                Durata min
                <input
                  name="workout_duration_min"
                  type="number"
                  min={15}
                  max={300}
                  defaultValue={state.config.duration}
                />
              </label>
              <label>
                Settimane
                <input
                  name="plan_weeks"
                  type="number"
                  min={2}
                  max={52}
                  defaultValue={state.config.weeks}
                />
              </label>
              <label>
                Inizio piano
                <input
                  name="start_date"
                  type="date"
                  defaultValue={state.config.start ?? ""}
                />
              </label>
              <label>
                Obiettivo
                <input
                  name="goal"
                  maxLength={500}
                  defaultValue={state.config.goal}
                />
              </label>
              <label>
                Peso obiettivo kg
                <input
                  name="target_weight"
                  type="number"
                  min={30}
                  max={250}
                  step="any"
                  defaultValue={(state.config.targetWeight as number) ?? ""}
                />
              </label>
              <button>Salva configurazione</button>
            </form>
          </details>
        </fieldset>
      )}
    </section>
  );
}
