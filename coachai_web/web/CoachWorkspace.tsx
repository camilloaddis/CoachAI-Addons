import type { Publication } from "../server/coach/calendar-publication.js";
import { TrendsPanel } from "./TrendsPanel.js";
import { TrainingMode } from "./TrainingMode.js";
import { TrainingProposal, TrainingInsight, TrainingAlert } from "./TrainingProposal.js";
import { apiFetch, type Tab } from "./api.js";
import React, { useEffect, useRef, useState } from "react";
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
type Activity = {
  activity_id: string; activity_date: string; name: string;
  startLocal?: string | null; category?: string;
  rpe?: number | null;
  duration_min?: number | null; training_load?: number | null; avg_power?: number | null;
};
type CoachState = {
  activities: Activity[];
  groqEnabled: boolean;
  config: Proposal["config"];
  calendarEnabled: boolean;
  proposals: { id: string; proposal: Proposal; publication: Publication | null }[];
  drafts: { id: string; meals: NutritionMeal[] }[];
  selected?: string | null;
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
const shiftDay = (day: string, offset: number) => {
  const date = new Date(`${day}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + offset);
  return date.toISOString().slice(0, 10);
};
const dayLabel = (day: string) => day === localDay() ? "oggi" : day === shiftDay(localDay(), -1) ? "ieri" : new Intl.DateTimeFormat("it-IT", { weekday: "long", day: "numeric", timeZone: "UTC" }).format(new Date(`${day}T12:00:00Z`));
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
  tab,
  meals,
  refresh,
  activities = [],
  exerciseKcal,
}: {
  tab: Tab;
  meals: Meal[];
  refresh: () => Promise<void>;
  activities?: Activity[];
  exerciseKcal?: number | null;
}) {
  const [state, setState] = useState<CoachState | null>(null);
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
  const [previewing, setPreviewing] = useState(false);
  const [editingDraft, setEditingDraft] = useState(false);
  const [mealMenu, setMealMenu] = useState<number | null>(null);
  const calendar = useRef<HTMLInputElement>(null);
  const [calendarOpen, setCalendarOpen] = useState(false);
  const [archiveMeals, setArchiveMeals] = useState<Meal[] | null>(null);
  const [archiveDate, setArchiveDate] = useState<string | null>(null);
  const [draft, setDraft] = useState<{
    id: string;
    meals: NutritionMeal[];
  } | null>(null);
  const [sendingId, setSendingId] = useState<string | null>(null);
  const [publications, setPublications] = useState<Record<string, Publication>>({});
  const [effortActivity, setEffortActivity] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const keys = useRef(new Map<string, string>());
  async function api(path: string, body?: object, key?: string) {
    const r = await apiFetch(path, {
      method: body ? "POST" : "GET",
      cache: "no-store",
      headers: {
        ...(body
          ? { "Content-Type": "application/json", "Idempotency-Key": key! }
          : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!r.ok) {
      const error = await r.json().catch(() => ({}));
      if (path.endsWith("/activity-rpe") && r.status === 503)
        throw new Error("Sforzo non confermato su Intervals. Controlla connessione e permessi; se necessario verifica l’RPE dell’attività su Intervals e riprova.");
      if (error.error === "stale_proposal")
        throw new Error(
          "La proposta non è più compatibile con lo stato attuale: genera un nuovo allenamento.",
        );
      if (r.status === 401) {
        throw new Error("Sessione scaduta: riapri Coach AI da Home Assistant.");
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
    setPublications(Object.fromEntries(s.proposals.filter(p => p.publication).map(p => [p.id, p.publication!])));
    if (!proposal && s.proposals.length) setProposal(s.proposals[0]);
    if (!draft && s.drafts.length) setDraft(s.drafts[0]);
    return s;
  }
  async function publish(verify: boolean) {
    if (!proposal || busy) return;
    const current = proposal;
    await perform(async () => {
      setSendingId(current.id);
      try {
        const response = await apiFetch(`/api/coach/proposals/${encodeURIComponent(current.id)}/publish`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ date: current.proposal.date, verify }),
        });
        const result = await response.json();
        if (!response.ok) {
          setMessage(result.error === "stale_proposal" ? "La proposta non è più valida: genera un nuovo allenamento." : "Pubblicazione non disponibile. Controlla configurazione e sessione.");
          await load();
          return;
        }
        setPublications(p => ({ ...p, [current.id]: result }));
      } catch {
        setPublications(p => ({ ...p, [current.id]: { status: "unknown", date: current.proposal.date, remoteId: null, retryable: false, error: "ambiguous_result" } }));
        try { await load(); } catch { /* Never suggest resending an uncertain creation. */ }
      } finally { setSendingId(null); }
    });
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
    if (archiveDate && ["meal", "edit-meal", "delete-meal", "nutrition-confirm"].includes(name))
      setArchiveMeals((await api(`/api/day/${archiveDate}`)).meals);

    keys.current.delete(signature);
    return result;
  }
  async function selectNutritionDay(day: string) {
    if (day < "1900-01-01" || day > localDay()) return;
    await perform(async () => {
      const result = await api(`/api/day/${day}`);
      setArchiveDate(day); setArchiveMeals(result.meals); setMealMenu(null); setCalendarOpen(false);
    });
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
  async function generate(
    request: string,
    regenerate = false,
    intent?: Proposal["decision"]["intent"],
  ) {
    await perform(async () => {
      const p = await action("workout", {
        request,
        regenerate,
        ...(intent ? { intent } : {}),
        ...(regenerate && proposal ? { previousProposalId: proposal.id } : {}),
      });
      setProposal(p);
    });
  }
  useEffect(() => {
    void load().catch(() =>
      setMessage("Coach non disponibile. Riapri da Home Assistant o riprova."),
    );
  }, []);
  return (
    <section className="card coach-workspace">
      {message && <p role="status">{message}</p>}
      {state && (
        <fieldset disabled={busy} className="coach-fields">
          <section
            id="workspace-training"
            tabIndex={-1}
            hidden={tab !== "today"}
            aria-label="Gestione allenamento"
          >
            <section className="training-mode" aria-label="Generazione allenamento">
              <TrainingMode busy={busy}
                onGenerate={(request, intent) => { setConfirming(false); void generate(request, !!proposal, intent); }}
                canAccept={!!proposal?.proposal.workout?.library && state.calendarEnabled && sendingId !== proposal?.id && (proposal?.proposal.duration ?? 0) > 0 && (!publications[proposal?.id ?? ""] || publications[proposal?.id ?? ""].retryable)}
                scheduled={publications[proposal?.id ?? ""]?.status === "scheduled"}
                onAccept={() => setConfirming(true)} />
              {confirming && proposal && <section aria-label="Conferma pubblicazione">
                <p>Aggiungere «{proposal.proposal.workout?.name}» al calendario Intervals per il giorno {proposal.proposal.date}?</p>
                <button type="button" onClick={() => { setConfirming(false); void publish(false); }}>Conferma aggiunta</button>
                <button type="button" onClick={() => setConfirming(false)}>Annulla</button>
              </section>}
              {proposal && <TrainingProposal key={proposal.id} proposal={proposal.proposal} />}
              {proposal && publications[proposal.id]?.status === "scheduled" && <p role="status">Allenamento programmato per {publications[proposal.id].date}. Non risulta eseguito.</p>}
              {proposal && publications[proposal.id]?.status === "error" && <p role="alert">Intervals ha rifiutato la richiesta. Controlla credenziali e permesso calendario.</p>}
              {proposal && publications[proposal.id]?.status === "unknown" && <div>
                <p role="alert">Esito non verificato: l’allenamento potrebbe essere già programmato. Verifica l’esito prima di riprovare.</p>
                <button type="button" onClick={() => void publish(true)}>Verifica esito</button>
              </div>}
            </section>
            <TrainingAlert proposal={proposal?.proposal ?? null} />
            <TrainingInsight proposal={proposal?.proposal ?? null} />
            <details className="training-activities panel collapsible-card" aria-label="Ultime attività">
              <summary className="eyebrow card-heading">ULTIME ATTIVITÀ</summary>
              <div className="entries">
                {state.activities.slice(0, 10).map(a => {
                  const detail = activities.find(item => item.activity_id === a.activity_id) ?? a;
                  const rpe = a.rpe === undefined ? detail.rpe : a.rpe;
                  const expanded = effortActivity === a.activity_id;
                  const number = (value: number | null | undefined, suffix: string) => value == null ? "—" : `${Math.round(value)}${suffix}`;
                  return <article className="activity-item" key={a.activity_id}>
                    <div className="entry">
                      <div><strong>{a.name || "Attività"}</strong><small>{new Date(a.activity_date + "T12:00:00").toLocaleDateString("it-IT", { day: "2-digit", month: "short" })}{detail.startLocal ? " · " + detail.startLocal.slice(11, 16) : ""}{detail.category ? " · " + detail.category : ""}</small></div>
                      <div className="activity-values right"><strong>{number(detail.duration_min, " min")}</strong><small>{number(detail.training_load, " load")} · {number(detail.avg_power, " W")}</small></div>
                      <div className={`effort-control${expanded ? " is-expanded" : ""}`} onKeyDown={e => { if (e.key === "Escape") { setEffortActivity(null); document.getElementById(`effort-${a.activity_id}`)?.focus(); } }}>
                        <button type="button" id={`effort-${a.activity_id}`} className="effort-toggle" hidden={expanded}
                          aria-label={`Sforzo: ${a.name || "Attività"}${rpe == null ? "" : `, RPE ${rpe}/10`}`} aria-expanded={expanded}
                          onClick={() => setEffortActivity(a.activity_id)}>{rpe == null ? "SFORZO" : rpe}</button>
                        {expanded && <div className="effort-options" role="group" aria-label={`Sforzo percepito: ${a.name || "Attività"}`}>
                          {Array.from({ length: 10 }, (_, i) => i + 1).map(value => <button type="button" key={value}
                            aria-pressed={rpe === value} aria-label={`RPE ${value}/10`} autoFocus={value === (rpe ?? 1)}
                            onClick={() => void perform(async () => {
                              await action("activity-rpe", { activity_id: a.activity_id, rpe: value });
                              setEffortActivity(null);
                              setMessage("Sforzo salvato su Intervals.");
                              requestAnimationFrame(() => document.getElementById(`effort-${a.activity_id}`)?.focus());
                            })}>{value}</button>)}
                        </div>}
                      </div>
                    </div>
                  </article>;
                })}
                {!state.activities.length && <p className="muted empty">Nessuna attività disponibile.</p>}
              </div>
              <details className="training-history"><summary>Storico proposte</summary>
                {state.proposals.map(p => <article key={p.id}>
                  <strong>{p.proposal.workout?.name ?? (p.proposal.status === "rest" ? "Riposo" : "Nessun workout compatibile")}</strong>
                  <p>{p.proposal.date} · {p.proposal.duration} min · {publications[p.id]?.status === "scheduled" ? "Programmato" : "Proposta"}</p>
                  <button type="button" onClick={() => setProposal(p)}>Apri proposta</button>
                </article>)}
              </details>
            </details>
          </section>
          <section
            id="workspace-summary"
            hidden={tab !== "settings"}
            aria-label="Recupero attuale"
          >
            <details><summary>Osservazioni facoltative sul recupero e sulle sedute</summary>
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
            </details>
          </section>
          <section
            id="workspace-nutrition"
            hidden={tab !== "meal"}
            role="tabpanel"
            aria-labelledby="tab-meal"
            aria-label="Gestione alimentazione"
          >
            <article className="panel nutrition-card">
              <p className="eyebrow card-heading">{new Intl.DateTimeFormat("it-IT", { weekday: "long", day: "numeric", month: "long", timeZone: "Europe/Rome" }).format(new Date())}</p>
              <h2>Resoconto della giornata</h2>
              <div className="nutrition-metrics">
                {([["Kcal assunte", "calories", "kcal"], ["Proteine", "protein_g", "g"], ["Carboidrati", "carbs_g", "g"], ["Grassi", "fat_g", "g"]] as const).map(([label, key, unit]) => <div key={key}><span>{label}</span><strong>{meals.length && meals.every(m => m[key] != null) ? meals.reduce((sum, m) => sum + (m[key] ?? 0), 0).toLocaleString("it-IT", { maximumFractionDigits: 1 }) : "—"} <small>{unit}</small></strong></div>)}
                <div><span>Kcal bruciate · attività</span><strong>{exerciseKcal == null ? "—" : exerciseKcal.toLocaleString("it-IT", { maximumFractionDigits: 0 })} <small>kcal</small></strong></div>
              </div>
            </article>
            <article className="panel nutrition-card nutrition-add">
              <h3 className="eyebrow card-heading">AGGIUNGI UN PASTO</h3>
              {previewing ? <div className="nutrition-loading" role="status"><span className="nutrition-spinner" />Preparazione anteprima…</div> : draft ? <>
                {draft.meals.map((m, i) => <article className="nutrition-preview" key={i}>
                  <h4>{m.meal_type} · {m.consumed_date}</h4>
                  <p>{m.description}</p>
                  <p>{m.items.map(item => `${item.name} (${item.quantity})`).join(", ")}</p>
                  <p className="muted">{m.totals.calories} kcal · Proteine {m.totals.protein_g} g · Carboidrati {m.totals.carbs_g} g · Grassi {m.totals.fat_g} g</p>
                  {editingDraft && <>
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
                                    edited.meals[i].items[
                                      j
                                    ] as unknown as Record<
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
                                    edited.meals[i].totals[macro] =
                                      edited.meals[i].items.reduce(
                                        (s, x) => s + x[macro],
                                        0,
                                      );
                                  setDraft(edited);
                                }}
                              />
                            </label>
                          ))}
                        </div>
                      ))}
                  </>}
                </article>)}
                <div className="actions">
                  <button type="button" disabled={busy} onClick={() => void perform(async () => {
                    await action("nutrition-confirm", { id: draft.id, meals: draft.meals });
                    setDraft(null); setNutritionText(""); setEditingDraft(false);
                    setMessage("Pasti confermati e registrati.");
                  })}>Accetta</button>
                  <button type="button" className="nutrition-text-button" disabled={busy} onClick={() => setEditingDraft(v => !v)}>{editingDraft ? "Fine modifica" : "Modifica"}</button>
                </div>
              </> : <>
                <textarea aria-label="Alimenti e quantità" placeholder="Descrivi cosa hai mangiato e le quantità…" maxLength={12000} value={nutritionText} onChange={e => setNutritionText(e.target.value)} />
                <button type="button" disabled={busy || !state.groqEnabled || !nutritionText.trim()} onClick={() => void perform(async () => {
                  setPreviewing(true);
                  try { setDraft(await action("nutrition-preview", { text: nutritionText })); setEditingDraft(false); }
                  finally { setPreviewing(false); }
                })}>Anteprima</button>
                {!state.groqEnabled && <p className="muted">Configura Groq nelle impostazioni per generare l’anteprima.</p>}
              </>}
            </article>
            {meal.id != null && <article className="panel nutrition-card">
              <h3>Modifica pasto</h3>
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
                            e.target.value === ""
                              ? null
                              : Number(e.target.value),
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
            </article>}
            <article className="panel nutrition-card">
            <div className="nutrition-date-nav">
              <button type="button" className="nutrition-text-button" aria-label="Giorno precedente" disabled={busy || (archiveDate ?? localDay()) <= "1900-01-01"} onClick={() => void selectNutritionDay(shiftDay(archiveDate ?? localDay(), -1))}>‹</button>
              <button type="button" className="nutrition-text-button nutrition-date-label" onClick={() => { setCalendarOpen(v => !v); try { calendar.current?.showPicker(); } catch { /* The visible date input remains available. */ } }}>{dayLabel(archiveDate ?? localDay())}</button>
              <button type="button" className="nutrition-text-button" aria-label="Giorno successivo" disabled={busy || (archiveDate ?? localDay()) >= localDay()} onClick={() => void selectNutritionDay(shiftDay(archiveDate ?? localDay(), 1))}>›</button>
            </div>
            <label className="nutrition-calendar" hidden={!calendarOpen}>
              Scegli la data
              <input ref={calendar} type="date" min="1900-01-01" max={localDay()} value={archiveDate ?? localDay()} disabled={busy} onChange={e => { if (e.target.value) void selectNutritionDay(e.target.value); }} />
            </label>
            {! (archiveMeals ?? meals).length && <p className="muted empty">ancora nessun pasto</p>}
            <ul className="nutrition-meals">
              {(archiveMeals ?? meals).map((m, i) => (
                <li key={m.id ?? i}>
                  {mealMenu !== m.id && <div><strong>{m.meal_type}</strong><p>{m.description}</p><small className="muted">{m.calories ?? "—"} kcal · P {m.protein_g ?? "—"} g · C {m.carbs_g ?? "—"} g · G {m.fat_g ?? "—"} g</small></div>}
                  {m.id && (
                    <>
                      {mealMenu === m.id ? <div className="actions">
                      <button type="button" className="nutrition-text-button" onClick={() => setMeal({ ...m })}>
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
                      </div> : null}
                      <button type="button" className="nutrition-text-button nutrition-pencil" aria-label={`Azioni per ${m.meal_type}: ${m.description}`} aria-expanded={mealMenu === m.id} onClick={() => setMealMenu(mealMenu === m.id ? null : m.id!)}><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><path d="m16 3 5 5-13 13H3v-5Z M14 5l5 5" /></svg></button>
                    </>
                  )}
                </li>
              ))}
            </ul>
            </article>
          </section>
          <TrendsPanel active={tab === "trends"} revision={state} />
          <section
            id="workspace-debug"
            hidden={tab !== "settings"}
            aria-label="Configurazione Coach"
          >
            <details open>
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
                  Obiettivo
                  <input
                    name="goal"
                    list="training-goal-presets"
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
                <details>
                  <summary>Piano avanzato</summary>
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
                </details>
                <datalist id="training-goal-presets">
                  <option value="Miglioramento FTP" />
                  <option value="Prestazioni in salita" />
                  <option value="Endurance e uscite lunghe" />
                  <option value="Allenamento equilibrato" />
                </datalist>
                <p className="muted">L’obiettivo orienta la scelta tra workout compatibili. La data d’inizio è facoltativa: senza data il piano è adattivo. Groq, se già abilitato e configurato, può scegliere nella rosa verificata; altrimenti il consiglio resta locale.</p>
                <button>Salva configurazione</button>
              </form>
            </details>
          </section>
        </fieldset>
      )}
    </section>
  );
}
