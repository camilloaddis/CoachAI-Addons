import { rmSync, readFileSync } from "node:fs";
if (JSON.parse(readFileSync("package.json","utf8")).name !== "coachai-web") throw new Error("Wrong build directory");
rmSync("build", {recursive:true,force:true});
