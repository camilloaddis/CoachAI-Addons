import { parseArgs } from "node:util";
import { openStore, transaction } from "../storage/database.js";
const { values } = parseArgs({
  options: {
    database: { type: "string" },
    "last-update-id": { type: "string" },
    "node-red-stopped": { type: "boolean" },
  },
});
try {
  const id = Number(values["last-update-id"]);
  if (
    !values.database ||
    values["last-update-id"] === undefined ||
    !/^(0|[1-9]\d*)$/.test(values["last-update-id"]) ||
    !Number.isSafeInteger(id) ||
    id < 0 ||
    !values["node-red-stopped"]
  )
    throw new Error();
  const db = openStore(values.database);
  try {
    transaction(db, () => {
      if (
        db.prepare("SELECT value FROM app_state WHERE key='import_mode'").get()
          ?.value !== "final" ||
        db
          .prepare(
            "SELECT key FROM app_state WHERE key='telegram_last_update_id'",
          )
          .get()
      )
        throw new Error();
      db.prepare(
        "INSERT INTO app_state VALUES('telegram_last_update_id',?)",
      ).run(String(id));
    });
  } finally {
    db.close();
  }
  console.log("Telegram cursor initialized offline. Bot remains disabled.");
} catch {
  console.error(
    "Cursor initialization refused: final database, verified update ID and stopped Node-RED required; never reset an existing cursor.",
  );
  process.exitCode = 1;
}
