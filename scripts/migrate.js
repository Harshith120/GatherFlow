import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { delimiter, dirname, isAbsolute, resolve } from "node:path";

const root = resolve(fileURLToPath(new URL("../", import.meta.url)));
const databaseUrl = process.env.DATABASE_URL
  ? new URL(process.env.DATABASE_URL)
  : null;
const host = databaseUrl?.hostname || process.env.PGHOST || "localhost";
const port = databaseUrl?.port || process.env.PGPORT || "5432";
const database = databaseUrl?.pathname.slice(1) || process.env.PGDATABASE || "gatherflow";
const user = databaseUrl?.username
  ? decodeURIComponent(databaseUrl.username)
  : process.env.PGUSER || "gatherflow";
const password = databaseUrl?.password
  ? decodeURIComponent(databaseUrl.password)
  : process.env.PGPASSWORD || "";
const query = databaseUrl?.search || "";
const flywayArgs = [
  "-baselineOnMigrate=true",
  "-baselineVersion=2",
  "-validateMigrationNaming=true",
  "-connectRetries=10",
  "migrate"
];
const environment = {
  ...process.env,
  FLYWAY_URL: `jdbc:postgresql://${host}:${port}/${database}${query}`,
  FLYWAY_USER: user,
  FLYWAY_PASSWORD: password,
  FLYWAY_LOCATIONS: "filesystem:migrations"
};
const options = { cwd: root, env: environment, stdio: "inherit" };
const dockerDesktopCli = "C:\\Program Files\\Docker\\Docker\\resources\\bin\\docker.exe";
const dockerExecutable = process.platform === "win32" && existsSync(dockerDesktopCli)
  ? dockerDesktopCli
  : "docker";

function runLocalFlyway() {
  if (process.platform === "win32") {
    const available = spawnSync("where.exe", ["flyway"], { encoding: "utf8" });
    if (available.error || available.status !== 0) return null;

    return spawnSync("cmd.exe", [
      "/d",
      "/s",
      "/c",
      `flyway ${flywayArgs.join(" ")}`
    ], options);
  }

  const result = spawnSync("flyway", flywayArgs, options);
  return result.error?.code === "ENOENT" ? null : result;
}

function runDockerFlyway() {
  const available = spawnSync(dockerExecutable, ["--version"], { encoding: "utf8" });
  if (available.error || available.status !== 0) {
    console.error(
      "Flyway CLI and Docker were not found. Install Flyway CLI 11 with Java 21, " +
      "or install and start Docker Desktop, then rerun `npm.cmd run db:migrate`."
    );
    return null;
  }

  const containerEnvironment = { ...environment, FLYWAY_LOCATIONS: "filesystem:/flyway/sql" };
  if (isAbsolute(dockerExecutable)) {
    containerEnvironment.PATH = [
      dirname(dockerExecutable),
      containerEnvironment.PATH || ""
    ].join(delimiter);
  }
  if (["localhost", "127.0.0.1", "::1"].includes(host)) {
    containerEnvironment.FLYWAY_URL =
      `jdbc:postgresql://host.docker.internal:${port}/${database}${query}`;
  }

  const volume = `${root.replace(/\\/g, "/")}:/flyway/sql:ro`;
  const result = spawnSync(dockerExecutable, [
    "run",
    "--rm",
    "--add-host=host.docker.internal:host-gateway",
    "--volume",
    volume,
    "--env",
    "FLYWAY_URL",
    "--env",
    "FLYWAY_USER",
    "--env",
    "FLYWAY_PASSWORD",
    "--env",
    "FLYWAY_LOCATIONS",
    "flyway/flyway:11-alpine",
    ...flywayArgs
  ], { ...options, env: containerEnvironment });
  if (result.status !== 0) {
    console.error("Docker could not run Flyway. Start Docker Desktop and complete its first-run setup.");
  }
  return result;
}

const result = runLocalFlyway() || runDockerFlyway();
if (!result) {
  process.exitCode = 1;
} else if (result.error) {
  console.error("Could not run Flyway:", result.error.message);
  process.exitCode = 1;
} else {
  process.exitCode = result.status ?? 1;
}
