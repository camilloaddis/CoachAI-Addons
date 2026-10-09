import { cpSync, mkdirSync } from "node:fs";
mkdirSync("build/storage/migrations", { recursive: true });
cpSync("server/storage/migrations", "build/storage/migrations", {
  recursive: true,
});
