import type { DatabaseSync } from "node:sqlite";
import { groqClient, type NutritionMeal } from "./groq.js";
import { recordServices, ValidationError } from "../services/records.js";
import { diagnostic, transaction } from "../storage/database.js";
import {
  commandDate,
  recalculate,
  dailyReport,
  weeklyReport,
  weightReport,
} from "./summaries.js";
import {
  selectWorkout,
  renderWorkout,
  trainingConfig,
  updateTrainingConfig,
  type Proposal,
} from "./training.js";
import { today, shift, type Result } from "../readiness/types.js";
import { jsonRequest } from "./http.js";
import type { RuntimeConfig } from "../telegram/config.js";
import { reconcileFeedback } from "./feedback.js";
type Prepared = {
  kind: string;
  text: string;
  nutrition?: { meals: NutritionMeal[] };
  proposal?: Proposal;
  replaceId?: number;
  replaceBefore?: string;
  error?: boolean;
};
export type CoachHandler = {
  prepare(text: string, updateId: number): Promise<Prepared>;
  apply(
    prepared: Prepared,
    updateId: number,
  ): { outcome: string; reply: string };
};
export function coachCommands(
  db: DatabaseSync,
  config: RuntimeConfig,
  readiness: () => Promise<Result>,
  intervals: { key?: string; athlete?: string },
  fetcher: typeof fetch = fetch,
  clock: () => Date = () => new Date(),
): CoachHandler {
  const ai = groqClient(config, fetcher);
  const normalize = (value: string) =>
    value
      .trim()
      .replace(/^\//, "")
      .replace(/^([a-z_]+)@[\w]+(?=\s|$)/i, "$1");
  const cached = (id: number) =>
    db.prepare("SELECT payload FROM ai_preparations WHERE update_id=?").get(id);
  const latestProposal = () =>
    db
      .prepare(
        "SELECT * FROM workout_proposals ORDER BY created_at DESC,rowid DESC LIMIT 1",
      )
      .get();
  async function prepare(raw: string, id: number): Promise<Prepared> {
    const old = cached(id);
    if (old) return JSON.parse(String(old.payload));
    const text = normalize(raw),
      lower = text.toLowerCase();
    let prepared: Prepared = { kind: "command", text };
    if (text.length > 12000)
      return {
        kind: "error",
        text: "Messaggio troppo lungo: suddividi il diario.",
        error: true,
      };
    try {
      if (lower === "accetta" || lower.startsWith("accetta allenamento ")) {
        const specified = lower.slice("accetta allenamento ".length),
          row =
            lower === "accetta"
              ? latestProposal()
              : db
                  .prepare("SELECT * FROM workout_proposals WHERE id=?")
                  .get(specified);
        if (!row) throw new Error("missing_proposal");
        if (
          !config.intervalsWriteEnabled ||
          !intervals.key ||
          !/^i?\d+$/.test(intervals.athlete || "")
        ) {
          prepared = {
            kind: "reply",
            text: "Caricamento Intervals disabilitato. La proposta è disponibile in formato Intervals; nessun evento creato.",
          };
        } else if (row.status !== "proposed") {
          prepared = {
            kind: "reply",
            text: `Proposta già elaborata (${row.status}). Gli invii incerti non vengono ripetuti.`,
          };
        } else {
          const p = JSON.parse(String(row.payload)) as Proposal;
          // Re-evaluate before any write: an old proposal must not bypass current recovery limits.
          const fresh = selectWorkout(db, await readiness(), clock());
          const order = [
            "riposo",
            "recupero",
            "endurance",
            "tempo",
            "sweet spot/soglia",
            "VO2max",
          ];
          if (
            p.date !== today(clock()) ||
            order.indexOf(p.recommendation) >
              order.indexOf(fresh.recommendation) ||
            p.config.ftp !== fresh.config.ftp ||
            p.duration > fresh.config.duration
          )
            throw new Error("stale_proposal");
          transaction(db, () => {
            const changed = db
              .prepare(
                "UPDATE workout_proposals SET status='sending' WHERE id=? AND status='proposed'",
              )
              .run(row.id).changes;
            if (!changed) throw new Error("proposal_busy");
          });
          try {
            const event = await jsonRequest(
              fetcher,
              `https://intervals.icu/api/v1/athlete/${intervals.athlete}/events`,
              {
                method: "POST",
                headers: {
                  authorization:
                    "Basic " +
                    Buffer.from("API_KEY:" + intervals.key).toString("base64"),
                  "content-type": "application/json",
                },
                body: JSON.stringify({
                  name: p.workout.name,
                  type: "Ride",
                  category: "WORKOUT",
                  description: p.workout.structure,
                  start_date_local: p.date + "T08:00:00",
                  athlete_id: intervals.athlete,
                }),
              },
            );
            const eventId = (event as { id?: unknown })?.id;
            if (typeof eventId !== "number" && typeof eventId !== "string")
              throw new Error("invalid_event");
            db.prepare(
              "UPDATE workout_proposals SET status='sent',event_id=? WHERE id=?",
            ).run(String(eventId), row.id);
            prepared = {
              kind: "reply",
              text: "Allenamento creato su Intervals. Sincronizzazione Garmin non verificabile.",
            };
          } catch {
            db.prepare(
              "UPDATE workout_proposals SET status='unknown' WHERE id=?",
            ).run(row.id);
            diagnostic(db, "error", "intervals_event_unknown");
            prepared = {
              kind: "reply",
              text: "Esito del caricamento incerto. Verifica Intervals prima di qualsiasi nuovo invio.",
            };
          }
        }
      } else if (
        /^(allenamento|intenso|leggero|vo2|ss|soglia|endurance|recupero|tempo|forza|pianifica)$/.test(
          lower,
        )
      ) {
        const p = selectWorkout(db, await readiness(), clock(), lower);
        if (config.groqEnabled) {
          try {
            const explanation = await ai.explanation({
              recommendation: p.recommendation,
              phase: p.phase,
              week: p.week,
              readiness: p.readiness,
              confidence: p.confidence,
              reasons: p.reasons,
            });
            prepared = {
              kind: lower === "pianifica" ? "plan" : "workout",
              text,
              proposal: { ...p, explanation },
            };
          } catch {
            diagnostic(db, "error", "groq_workout_unavailable");
            prepared = {
              kind: lower === "pianifica" ? "plan" : "workout",
              text,
              proposal: p,
            };
          }
        } else
          prepared = {
            kind: lower === "pianifica" ? "plan" : "workout",
            text,
            proposal: p,
          };
      } else if (
        !/^pasto\s+\{/.test(lower) &&
        !/^accetta pasto$|^elimina pasto/.test(lower) &&
        (/\b(colazione|pranzo|cena|merenda|spuntino|ho mangiato)\b/.test(
          lower,
        ) ||
          /^correggi pasto \d+\s+/.test(lower))
      ) {
        const correction = /^correggi pasto (\d+)\s+([\s\S]+)$/i.exec(text);
        let replaceId: number | undefined, replaceBefore: string | undefined;
        if (correction) {
          replaceId = Number(correction[1]);
          const row = db
            .prepare("SELECT * FROM meals WHERE id=?")
            .get(replaceId);
          if (!row) throw new Error("unknown_meal");
          replaceBefore = JSON.stringify(row);
        }
        const nutrition = await ai.nutrition(
          correction
            ? `${JSON.parse(replaceBefore!).date}: ${correction[2]}`
            : text,
          today(clock()),
        );
        if (correction && nutrition.meals.length !== 1)
          throw new Error("ambiguous_correction");
        prepared = {
          kind: "nutrition",
          text,
          nutrition,
          replaceId,
          replaceBefore,
        };
      }
    } catch {
      diagnostic(db, "error", "coach_preparation_failed");
      prepared = {
        kind: "error",
        text: "Richiesta non elaborabile o servizio non disponibile. Nessun nuovo record salvato. Specifica quantità/date; per allenamenti rigenera una proposta aggiornata.",
        error: true,
      };
    }
    // Persist completed AI estimates before update effects. A replay never regenerates different macros.
    db.prepare("INSERT OR IGNORE INTO ai_preparations VALUES(?,?)").run(
      id,
      JSON.stringify(prepared),
    );
    return prepared;
  }
  function apply(p: Prepared, id: number) {
    const records = recordServices(db, clock),
      text = p.text,
      lower = text.toLowerCase();
    let reply = "Comando non riconosciuto. Usa home per il menu.",
      outcome = p.kind;
    if (p.kind === "error" || p.kind === "reply") reply = p.text;
    else if (p.kind === "nutrition") {
      db.prepare(
        "INSERT INTO nutrition_drafts VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload,created_at=excluded.created_at",
      ).run(
        "active",
        JSON.stringify({ ...p, requestId: id }),
        clock().toISOString(),
      );
      reply =
        "Stima da verificare prima del salvataggio:\n" +
        p
          .nutrition!.meals.map(
            (m) =>
              `${m.consumed_date} ${m.meal_type}: ${m.description}\n${m.items
                .slice(0, 8)
                .map((i) => `${i.name}: ${i.quantity}`)
                .join(
                  "; ",
                )}${m.items.length > 8 ? `; altre ${m.items.length - 8} portate (incluse nei totali)` : ""}\n${m.totals.calories} kcal, P ${m.totals.protein_g} g / C ${m.totals.carbs_g} g / F ${m.totals.fat_g} g; affidabilità ${m.confidence}`,
          )
          .join("\n") +
        "\n“accetta pasto” conferma; “annulla” elimina la bozza. Per correggere invia una descrizione completa sostitutiva.";
    } else if (p.kind === "workout" || p.kind === "plan") {
      const proposalId = String(id);
      db.prepare(
        "INSERT INTO workout_proposals(id,created_at,payload) VALUES(?,?,?)",
      ).run(proposalId, clock().toISOString(), JSON.stringify(p.proposal));
      reply = renderWorkout(p.proposal!, proposalId);
      if (p.kind === "plan")
        reply +=
          "\nPiano condizionale: oggi la proposta sopra; domani recupero/riposo se persiste fatica, altrimenti endurance; dopodomani rivalutazione prima di qualità. Nessuna Readiness futura è stimata.";
    } else if (lower === "accetta pasto") {
      const row = db
        .prepare("SELECT payload FROM nutrition_drafts WHERE id='active'")
        .get();
      if (!row) throw new ValidationError("no_draft");
      const draft = JSON.parse(String(row.payload)) as Prepared & {
        requestId: number;
      };
      const affected = new Set<string>();
      if (draft.replaceId !== undefined) {
        const before = db
          .prepare("SELECT * FROM meals WHERE id=?")
          .get(draft.replaceId);
        if (JSON.stringify(before) !== draft.replaceBefore)
          throw new ValidationError("changed_meal");
        affected.add(String(before!.date));
        db.prepare("DELETE FROM meals WHERE id=?").run(draft.replaceId);
      }
      draft.nutrition!.meals.forEach((m, i) => {
        const key = `nutrition:${draft.requestId}:${i}`;
        records.meal(
          {
            date: m.consumed_date,
            meal_type: m.meal_type,
            description: m.description,
            ...m.totals,
          },
          key,
          true,
        );
        const meal = db
          .prepare("SELECT id FROM meals WHERE request_key=?")
          .get(key)!;
        db.prepare("INSERT INTO nutrition_items VALUES(?,?)").run(
          meal.id,
          JSON.stringify(m.items),
        );
        db.prepare("UPDATE meals SET confidence=? WHERE id=?").run(
          { high: 1, medium: 0.6, low: 0.3 }[m.confidence],
          meal.id,
        );
        affected.add(m.consumed_date);
      });
      for (const d of affected) recalculate(db, d);
      db.prepare("DELETE FROM nutrition_drafts WHERE id='active'").run();
      reply = "Pasti confermati e riepiloghi aggiornati.";
    } else if (lower === "annulla") {
      db.prepare("DELETE FROM nutrition_drafts WHERE id='active'").run();
      reply = "Bozza annullata. Nessun pasto registrato.";
    } else if (/^pasto\s+\{/.test(lower)) {
      const raw = JSON.parse(text.slice(6));
      records.meal(raw, `telegram:${id}`, true);
      recalculate(db, raw.date);
      reply = "Pasto registrato.";
    } else if (lower.startsWith("gambe ")) {
      const parts = text.split(/\s+/);
      if (parts.length < 3 || parts.length > 4) throw new ValidationError();
      records.feedback(
        {
          activity_id: parts[1],
          legs: Number(parts[2]),
          sensation_date: parts[3],
        },
        `telegram:${id}`,
        true,
      );
      db.prepare(
        "UPDATE feedback_requests SET status='received' WHERE activity_id=?",
      ).run(parts[1]);
      reply =
        "Feedback registrato per l’attività indicata. Data della sensazione assente se non esplicitata.";
    } else if (lower.startsWith("legs|")) {
      const m = /^legs\|(\d+)\|([1-5])$/.exec(text);
      if (!m) throw new ValidationError();
      const row = db
        .prepare(
          "SELECT activity_id FROM feedback_requests WHERE id=? AND status IN ('sent','unknown','received','legacy_unknown')",
        )
        .get(Number(m[1]));
      if (!row) throw new ValidationError();
      records.feedback(
        { activity_id: String(row.activity_id), legs: Number(m[2]) },
        `telegram:${id}`,
        true,
      );
      db.prepare(
        "UPDATE feedback_requests SET status='received' WHERE id=?",
      ).run(Number(m[1]));
      reply =
        "Sensazione durante l’attività registrata. Non è una misurazione del recupero di oggi.";
    } else if (lower === "settimana") reply = weeklyReport(db, clock());
    else if (lower === "peso") reply = weightReport(db, clock());
    else if (
      lower === "oggi" ||
      lower === "ieri" ||
      lower.startsWith("resoconto ")
    )
      reply = dailyReport(
        db,
        commandDate(lower.replace(/^resoconto /, ""), clock()),
      );
    else if (lower === "giorno")
      reply = "Scrivi resoconto YYYY-MM-DD (oppure DD/MM/YYYY).";
    else if (lower === "pasto")
      reply =
        "Descrivi un pasto, quantità e data. Esempio: pranzo: 80 g di riso, pollo e verdure. Verifica le stime e conferma con accetta pasto.";
    else if (lower === "pasti")
      reply =
        "Scrivi pasti YYYY-MM-DD per vedere gli identificativi dei pasti.";
    else if (lower.startsWith("pasti ")) {
      const date = commandDate(text.slice(6), clock()),
        rows = db
          .prepare(
            "SELECT id,meal_type,description,calories FROM meals WHERE date=? ORDER BY id",
          )
          .all(date);
      reply =
        `Pasti ${date}:\n` +
        (rows.length
          ? rows
              .map(
                (r) =>
                  `#${r.id} ${r.meal_type}: ${r.description} (${r.calories ?? "n/d"} kcal)`,
              )
              .join("\n")
          : "nessun pasto registrato.");
    } else if (/^elimina pasto \d+$/.test(lower)) {
      const mealId = Number(lower.split(" ").at(-1)),
        row = db.prepare("SELECT date FROM meals WHERE id=?").get(mealId);
      if (!row) throw new ValidationError();
      db.prepare("DELETE FROM meals WHERE id=?").run(mealId);
      recalculate(db, String(row.date));
      reply = "Pasto eliminato; riepilogo aggiornato.";
    } else if (lower === "chiudi giornata" || lower === "riapri giornata") {
      const date = today(clock());
      if (!db.prepare("SELECT id FROM meals WHERE date=? LIMIT 1").get(date))
        throw new ValidationError();
      recalculate(db, date);
      db.prepare("UPDATE daily_summary SET food_complete=? WHERE date=?").run(
        lower === "chiudi giornata" ? 1 : 0,
        date,
      );
      reply =
        lower === "chiudi giornata"
          ? "Diario odierno chiuso."
          : "Diario odierno riaperto.";
    } else if (lower === "impostazioni")
      reply =
        JSON.stringify(trainingConfig(db), null, 2) +
        "\nModifica: impostazioni ftp|target_weight|workout_duration_min|plan_weeks|start_date|goal VALORE";
    else if (lower.startsWith("impostazioni ")) {
      updateTrainingConfig(db, text.slice(13), clock());
      reply = "Configurazione aggiornata.";
    } else if (lower === "feedback mancanti") {
      reconcileFeedback(db, clock());
      const rows = db
        .prepare(
          "SELECT status,COUNT(*) n FROM feedback_requests GROUP BY status",
        )
        .all();
      reply =
        "Richieste feedback: " +
        rows.map((r) => `${r.status}: ${r.n}`).join(", ") +
        ". Pending: recupero automatico entro 7 giorni. Unknown/legacy_unknown: verificare Telegram manualmente, nessun reinvio automatico.";
    } else if (
      /^(start|home|menu|menu_home|menu_training|menu_nutrition|menu_stats|menu_settings)$/.test(
        lower,
      )
    )
      reply =
        "Coach AI\nAllenamento: allenamento, pianifica, leggero, intenso, vo2, ss, forza, accetta.\nDiario: descrivi il pasto → accetta pasto / annulla; pasti DATA, elimina pasto ID, correggi pasto ID DESCRIZIONE.\nRiepiloghi: oggi, ieri, resoconto DATA, settimana, peso, chiudi giornata, riapri giornata.\nConfigurazione: impostazioni.\nFeedback: gambe ID 1-5 [DATA], feedback mancanti.";
    db.prepare(
      "INSERT INTO app_state VALUES('data_revision','1') ON CONFLICT(key) DO UPDATE SET value=CAST(value AS INTEGER)+1",
    ).run();
    // Telegram text limit is enforced without dropping the confirmation instructions.
    if (reply.length > 3900)
      reply =
        reply.slice(0, 3500) +
        "\n[… dettaglio abbreviato; tutti i dati validati sono nella bozza.]\naccetta pasto conferma; annulla elimina; invia una descrizione sostitutiva per correggere.";
    return { outcome, reply };
  }
  return { prepare, apply };
}
