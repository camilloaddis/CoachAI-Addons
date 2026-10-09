import { parseArgs } from "node:util";
import { writeFileSync } from "node:fs";
import { importHistory } from "./importer.js";
const { values } = parseArgs({
  options: {
    source: { type: "string" },
    destination: { type: "string" },
    mode: { type: "string" },
    "schema-report": { type: "string" },
    "schema-hash": { type: "string" },
    "node-red-stopped": { type: "boolean" },
  },
});
try {
  if (
    !values.source ||
    !["inspect", "preliminary", "final"].includes(values.mode ?? "")
  )
    throw new Error(
      "Required: --source PATH --mode inspect|preliminary|final [--destination PATH]",
    );
  if (values["schema-report"] && values.mode !== "inspect")
    throw new Error("Schema report is inspect-only");
  const result = importHistory({
    source: values.source,
    destination: values.destination,
    mode: values.mode as "inspect" | "preliminary" | "final",
    schemaHash: values["schema-hash"],
    nodeRedStopped: values["node-red-stopped"],
  });
  // Counts and schema only: never print row content or credentials.
  if (values["schema-report"])
    writeFileSync(
      values["schema-report"],
      JSON.stringify(
        { tables: result.schema, objects: result.schemaObjects },
        null,
        2,
      ),
      { mode: 0o600, flag: "wx" },
    );
  const { schema, schemaObjects, ...summary } = result;
  console.log(JSON.stringify(summary, null, 2));
} catch {
  console.error(
    "Import refused or failed: verify mode, source schema/integrity, destination, reviewed schema hash and stopped Node-RED. No source writes performed.",
  );
  process.exitCode = 1;
}
