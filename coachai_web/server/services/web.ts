import { requestWorkoutAdvice, applyWorkoutAdvice } from "../coach/workout-advisor.js";
import type { CatalogWorkout } from "../coach/library-catalog.js";
import { workoutLibraryRepository } from "../storage/workout-library.js";
import { intentForRequest, validateIntent } from "../coach/intent.js";
import type { DatabaseSync } from "node:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { transaction, diagnostic } from "../storage/database.js";
import {
  recordServices,
  ValidationError,
  type MealInput,
  type FeedbackInput,
} from "./records.js";
import {
  selectWorkout,
  workoutStillSafe,
  trainingConfig,
  updateTrainingConfig,
} from "../coach/training.js";
import {
  recalculate,
  dailyReport,
  weeklyReport,
  weightReport,
} from "../coach/summaries.js";
import { groqClient, validateNutrition } from "../coach/groq.js";
import { today, validDate, type Result } from "../readiness/types.js";
import type { RuntimeConfig } from "../config.js";

export function webServices(
  db: DatabaseSync,
  config: RuntimeConfig,
  readiness: () => Promise<Result>,
  fetcher: typeof fetch = fetch,
  clock: () => Date = () => new Date(),
  libraryAccount?: string,
) {
  const records = recordServices(db, clock),
    ai = groqClient(config, fetcher);
  const pending = new Map<string, Promise<unknown>>();
  const fail = () => {
    throw new ValidationError("invalid_request");
  };
  async function mutate(
    action: string,
    body: Record<string, unknown>,
    key: string,
  ) {
    if (!key || key.length > 160 || !/^[a-zA-Z0-9_-]+$/.test(key)) fail();
    if (
      db.prepare("SELECT value FROM app_state WHERE key='import_mode'").get()
        ?.value !== "final"
    )
      fail();
    const requestKey = "web:" + key;
    const hash = createHash("sha256")
      .update(JSON.stringify({ action, body }))
      .digest("hex");
    const cached = () => {
      const old = db
        .prepare(
          "SELECT request_hash FROM service_requests WHERE request_key=?",
        )
        .get(requestKey);
      if (!old) return null;
      if (old.request_hash !== hash) fail();
      return JSON.parse(
        String(
          db
            .prepare("SELECT value FROM app_state WHERE key=?")
            .get("web_result:" + key)?.value,
        ),
      );
    };
    const old = cached();
    if (old !== null) return old;
    if (pending.has(key)) {
      await pending.get(key);
      return cached();
    }
    const job = (async () => {
      let prepared: unknown;
      let finalizeWorkout: (() => unknown) | undefined;
      if (action === "workout") {
        const allowed = [
          "allenamento",
          "leggero",
          "intenso",
          "ss",
          "vo2max",
          "endurance",
          "forza",
          "tempo", "soglia", "recupero", "riposo",
        ];
        if (
          typeof body.request !== "string" ||
          !allowed.includes(body.request) ||
          (body.regenerate !== undefined &&
            typeof body.regenerate !== "boolean")
        )
          fail();
        let intent: ReturnType<typeof validateIntent> | undefined;
        try { intent = body.intent === undefined ? intentForRequest(body.request as string) : validateIntent(body.intent); }
        catch { fail(); }
        const command = body.intent !== undefined && intent?.mode === "automatic"
          ? { recommended: "allenamento", lighter: "leggero", harder: "intenso" }[intent.preference]
          : body.request as string;
        let previousWorkout: CatalogWorkout | undefined;
        if (body.previousProposalId !== undefined) {
          if (body.regenerate !== true || typeof body.previousProposalId !== "string") fail();
          const previousPayload = db.prepare("SELECT payload FROM workout_proposals WHERE id=?").get(body.previousProposalId as string)?.payload;
          if (typeof previousPayload !== "string") throw new ValidationError("stale_proposal");
          const previous = JSON.parse(previousPayload);
          if (previous.decision && JSON.stringify(previous.decision.intent) !== JSON.stringify(intent)) fail();
          previousWorkout = previous.workout;
        }
        const initialReadiness = await readiness();
        const select = (evaluation: Result) => {
          let candidates: CatalogWorkout[] = [];
          const plan = selectWorkout(db, evaluation, clock(), command, body.regenerate === true, intent,
            libraryAccount, previousWorkout, rows => { candidates = rows; });
          return { plan, candidates };
        };
        const initial = select(initialReadiness);
        const advice = await requestWorkoutAdvice(initial.plan, initial.candidates, config.groqEnabled === true && !!config.groqKey, input => ai.workout(input));
        const currentReadiness = advice.status === "selected" || advice.status === "provider_unavailable" ? await readiness() : initialReadiness;
        finalizeWorkout = () => {
          const current = select(currentReadiness);
          return applyWorkoutAdvice(current.plan, current.candidates, advice);
        };
      } else if (action === "select-workout") {
        if (typeof body.id !== "string") fail();
        const payload = db.prepare("SELECT payload FROM workout_proposals WHERE id=?").get(body.id as string)?.payload;
        if (typeof payload !== "string") fail();
        const stored = JSON.parse(payload as string);
        let intent: ReturnType<typeof validateIntent> | undefined;
        try { intent = stored.decision ? validateIntent(stored.decision.intent) : undefined; }
        catch { throw new ValidationError("stale_proposal"); }
        prepared = {
          payload,
          fresh: selectWorkout(db, await readiness(), clock(), stored.requestCommand ?? "allenamento", false, intent, libraryAccount),
        };
      } else if (action === "nutrition-preview") {
        if (
          typeof body.text !== "string" ||
          !body.text.trim() ||
          body.text.length > 12000
        )
          fail();
        prepared = await ai.nutrition(body.text as string, today(clock()));
      }
      return transaction(db, () => {
        const duplicate = cached();
        if (duplicate !== null) return duplicate;
        let result: unknown = { saved: true };
        if (action === "workout") {
          prepared = finalizeWorkout!();
          const id = randomUUID();
          db.prepare(
            "INSERT INTO workout_proposals(id,created_at,payload) VALUES(?,?,?)",
          ).run(id, clock().toISOString(), JSON.stringify(prepared));
          result = { id, proposal: prepared };
        } else if (action === "select-workout") {
          if (
            typeof body.id !== "string" ||
            !db
              .prepare("SELECT id FROM workout_proposals WHERE id=?")
              .get(body.id)
          )
            fail();
          const stored = JSON.parse(
            String(
              db
                .prepare("SELECT payload FROM workout_proposals WHERE id=?")
                .get(body.id as string)!.payload,
            ),
          );
          if (!stored.workout?.library) throw new ValidationError("no_compatible_workout");
          const selection = prepared as { payload: string; fresh: ReturnType<typeof selectWorkout> };
          const fresh = selection.fresh;
          if (JSON.stringify(stored) !== JSON.stringify(JSON.parse(selection.payload)))
            throw new ValidationError("stale_proposal");
          if (stored.workout?.library) {
            const ref = stored.workout.library;
            const account = libraryAccount?.replace(/^i?/, "i");
            const current = account && account === ref.account ? workoutLibraryRepository(db).get(account, ref.id) : null;
            if (!current?.available || !current.compatible || current.contentHash !== ref.contentHash)
              throw new ValidationError("stale_proposal");
          }
          const ranks = [
            "riposo",
            "recupero",
            "endurance",
            "tempo",
            "sweet spot/soglia",
            "VO2max",
          ];
          if (
            stored.date !== today(clock()) ||
            !stored.config ||
            stored.config.ftp !== fresh.config.ftp ||
            !workoutStillSafe(stored.workout, fresh) ||
            ranks.indexOf(stored.recommendation) < 0 ||
            ranks.indexOf(stored.recommendation) >
              ranks.indexOf(fresh.recommendation)
          )
            throw new ValidationError("stale_proposal");
          db.prepare(
            "INSERT INTO app_state VALUES('web_selected_workout',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
          ).run(body.id as string);
          result = { saved: true, id: body.id, uploaded: false, decision: fresh.decision };
        } else if (action === "meal" || action === "edit-meal") {
          let previous: Record<string, unknown> | undefined;
          if (action === "edit-meal") {
            if (!Number.isSafeInteger(body.id)) fail();
            previous = db
              .prepare("SELECT * FROM meals WHERE id=?")
              .get(body.id as number);
            if (!previous) fail();
          }
          const input = body as unknown as MealInput;
          if (!validDate(input.date) || input.date > today(clock())) fail();
          records.meal(input, requestKey + ":meal", true);
          if (previous) {
            const newRow = db
              .prepare("SELECT id FROM meals WHERE request_key=?")
              .get(requestKey + ":meal")!;
            db.prepare(
              "UPDATE meals SET date=?,meal_type=?,description=?,calories=?,protein_g=?,carbs_g=?,fat_g=? WHERE id=?",
            ).run(
              input.date,
              input.meal_type,
              input.description,
              input.calories,
              input.protein_g,
              input.carbs_g,
              input.fat_g,
              body.id as number,
            );
            db.prepare("DELETE FROM meals WHERE id=?").run(newRow.id);
            db.prepare("DELETE FROM nutrition_items WHERE meal_id=?").run(
              body.id as number,
            );
            recalculate(db, String(previous.date));
          }
          recalculate(db, input.date);
        } else if (action === "delete-meal") {
          if (!Number.isSafeInteger(body.id)) fail();
          const row = db
            .prepare("SELECT date FROM meals WHERE id=?")
            .get(body.id as number);
          if (!row) fail();
          db.prepare("DELETE FROM meals WHERE id=?").run(body.id as number);
          recalculate(db, String(row!.date));
        } else if (action === "activity-feedback") {
          records.feedback(
            {
              ...body,
              context: "activity",
              sensation_date: undefined,
            } as FeedbackInput,
            requestKey + ":feedback",
            true,
          );
        } else if (action === "recovery") {
          if (
            !Number.isInteger(body.legs) ||
            Number(body.legs) < 1 ||
            Number(body.legs) > 5 ||
            typeof body.date !== "string" ||
            !validDate(body.date) ||
            body.date !== today(clock()) ||
            (body.note !== undefined &&
              (typeof body.note !== "string" || body.note.length > 2000))
          )
            fail();
          db.prepare("INSERT INTO recovery_observations VALUES(?,?,?,?,?)").run(
            requestKey,
            body.legs as number,
            body.date as string,
            typeof body.note === "string" ? body.note : null,
            clock().toISOString(),
          );
          diagnostic(db, "feedback_received", "current_recovery");
        } else if (action === "settings") {
          const allowed = [
            "ftp",
            "target_weight",
            "workout_duration_min",
            "plan_weeks",
            "start_date",
            "goal",
          ];
          if (
            !Object.keys(body).length ||
            Object.keys(body).some((k) => !allowed.includes(k))
          )
            fail();
          for (const [key, value] of Object.entries(body)) {
            if (typeof value !== "string" && typeof value !== "number") fail();
            updateTrainingConfig(db, `${key} ${value}`, clock());
          }
          result = trainingConfig(db);
        } else if (action === "close-day") {
          if (
            typeof body.date !== "string" ||
            !validDate(body.date) ||
            body.date > today(clock())
          )
            fail();
          recalculate(db, body.date as string);
          db.prepare(
            "UPDATE daily_summary SET food_complete=1 WHERE date=?",
          ).run(body.date as string);
        } else if (action === "nutrition-preview") {
          const id = "web-" + randomUUID();
          db.prepare("INSERT INTO nutrition_drafts VALUES(?,?,?)").run(
            id,
            JSON.stringify(prepared),
            clock().toISOString(),
          );
          result = { id, ...(prepared as object) };
        } else if (action === "nutrition-edit") {
          if (
            typeof body.id !== "string" ||
            !body.id.startsWith("web-") ||
            !db
              .prepare("SELECT id FROM nutrition_drafts WHERE id=?")
              .get(body.id as string)
          )
            fail();
          const parsed = validateNutrition(
            { meals: body.meals },
            today(clock()),
          );
          db.prepare("UPDATE nutrition_drafts SET payload=? WHERE id=?").run(
            JSON.stringify(parsed),
            body.id as string,
          );
          result = { id: body.id, ...parsed };
        } else if (action === "nutrition-confirm") {
          if (typeof body.id !== "string" || !body.id.startsWith("web-"))
            fail();
          const draft = db
            .prepare("SELECT payload FROM nutrition_drafts WHERE id=?")
            .get(body.id as string);
          if (!draft) fail();
          const parsed = validateNutrition(
            body.meals === undefined
              ? JSON.parse(String(draft!.payload))
              : { meals: body.meals },
            today(clock()),
          );
          for (const [i, meal] of parsed.meals.entries()) {
            const mealKey = requestKey + ":meal:" + i;
            records.meal(
              {
                date: meal.consumed_date,
                meal_type: meal.meal_type,
                description: meal.description,
                ...meal.totals,
              },
              mealKey,
              true,
            );
            const row = db
              .prepare("SELECT id FROM meals WHERE request_key=?")
              .get(mealKey)!;
            db.prepare("INSERT INTO nutrition_items VALUES(?,?)").run(
              row.id,
              JSON.stringify(meal.items),
            );
            recalculate(db, meal.consumed_date);
          }
          db.prepare("DELETE FROM nutrition_drafts WHERE id=?").run(
            body.id as string,
          );
        } else if (action === "nutrition-cancel") {
          if (typeof body.id !== "string" || !body.id.startsWith("web-"))
            fail();
          db.prepare("DELETE FROM nutrition_drafts WHERE id=?").run(
            body.id as string,
          );
        } else fail();
        db.prepare("INSERT INTO service_requests VALUES(?,?,?)").run(
          requestKey,
          hash,
          "web:" + action,
        );
        db.prepare("INSERT INTO app_state VALUES(?,?)").run(
          "web_result:" + key,
          JSON.stringify(result),
        );
        db.prepare(
          "INSERT INTO app_state VALUES('data_revision','1') ON CONFLICT(key) DO UPDATE SET value=CAST(value AS INTEGER)+1",
        ).run();
        return result;
      });
    })();
    pending.set(key, job);
    try {
      return await job;
    } finally {
      pending.delete(key);
    }
  }
  function state() {
    return {
      groqEnabled: config.groqEnabled === true,
      config: trainingConfig(db),
      proposals: db
        .prepare(
          "SELECT id,created_at,payload FROM workout_proposals ORDER BY created_at DESC,rowid DESC LIMIT 10",
        )
        .all()
        .map((r) => ({
          id: r.id,
          created_at: r.created_at,
          proposal: JSON.parse(String(r.payload)),
        }))
        .filter(
          (r) =>
            (r.proposal?.workout && typeof r.proposal.workout.structure === "string") || ["rest","no_compatible_workout"].includes(r.proposal?.status),
        )
        .map((r) => ({
          ...r,
          proposal: {
            ...r.proposal,
            constraints: r.proposal.constraints ?? [],
            limitingFactors: r.proposal.limitingFactors ?? [],
            requestCommand: r.proposal.requestCommand ?? "allenamento",
            requestSatisfied: r.proposal.requestSatisfied ?? false,
          },
        })),
      activities: db
        .prepare(
          "SELECT activity_id,activity_date,name FROM training_activities ORDER BY activity_date DESC,activity_id DESC LIMIT 1000",
        )
        .all(),
      selected:
        db
          .prepare(
            "SELECT value FROM app_state WHERE key='web_selected_workout'",
          )
          .get()?.value ?? null,
      feedback: db
        .prepare(
          "SELECT activity_id,legs,note,updated_at,context FROM training_feedback",
        )
        .all(),
      recovery: db
        .prepare(
          "SELECT legs,observation_date,note,updated_at FROM recovery_observations ORDER BY updated_at DESC LIMIT 10",
        )
        .all(),
      drafts: db
        .prepare(
          "SELECT id,payload FROM nutrition_drafts WHERE id LIKE 'web-%' ORDER BY created_at DESC LIMIT 10",
        )
        .all()
        .map((r) => ({ id: r.id, ...JSON.parse(String(r.payload)) })),
      reports: {
        daily: dailyReport(db, today(clock())),
        weekly: weeklyReport(db, clock()),
        weight: weightReport(db, clock()),
      },
    };
  }
  return { mutate, state };
}
