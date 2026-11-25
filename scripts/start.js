import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const root = resolve(fileURLToPath(new URL("../", import.meta.url)));

if (!process.env.DATABASE_URL) {
  process.env.PGHOST ||= "127.0.0.1";
  process.env.PGPORT ||= process.env.POSTGRES_PORT || "5433";
  process.env.PGUSER ||= "gatherflow";
  process.env.PGDATABASE ||= "gatherflow";
  process.env.PGPASSWORD ||= process.env.POSTGRES_PASSWORD;
}

function run(script) {
  const result = spawnSync(process.execPath, [script], {
    cwd: root,
    env: process.env,
    stdio: "inherit"
  });
  if (result.error) {
    console.error(`Could not start ${script}: ${result.error.message}`);
    process.exitCode = 1;
    return false;
  }
  if (result.status !== 0) {
    process.exitCode = result.status ?? 1;
    return false;
  }
  return true;
}

if (process.argv[2] === "--serve" || run("scripts/migrate.js")) {
  run("server.js");
}
