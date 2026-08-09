import { writeSync } from "node:fs";
import { inspect } from "node:util";

/**
 * TODO: tijdelijk voor diagnose — verwijderen zodra de herstart-oorzaak bekend is.
 *
 * Logt waaróm het Node-proces eindigt. Dit bestand wordt als eerste (na dotenv)
 * geïmporteerd door de worker, zodat ook fouten tijdens het opstarten van de
 * andere modules hier nog zichtbaar worden.
 */

const t0 = Date.now();

/**
 * Synchroon naar stdout schrijven. console.log is op een pipe — en in Docker is
 * stdout altijd een pipe — asynchroon: wat vlak voor het afsluiten nog in de
 * buffer staat, gaat verloren. Dat is precies waarom de Railway-logs nu niets
 * tonen vóór het stoppen. writeSync heeft dat probleem niet.
 */
function log(...parts: unknown[]) {
  const text = parts
    .map((p) => (typeof p === "string" ? p : inspect(p, { depth: 4 })))
    .join(" ");
  writeSync(1, `[lifecycle +${((Date.now() - t0) / 1000).toFixed(1)}s] ${text}\n`);
}

/** Wat houdt de event loop nog bezig? Leeg = het proces stopt zo vanzelf. */
function activeHandles(): string {
  try {
    const p = process as unknown as {
      _getActiveHandles?: () => unknown[];
      _getActiveRequests?: () => unknown[];
    };
    const all = [...(p._getActiveHandles?.() ?? []), ...(p._getActiveRequests?.() ?? [])];
    if (!all.length) return "(geen)";
    const counts = new Map<string, number>();
    for (const h of all) {
      const name = (h as { constructor?: { name?: string } })?.constructor?.name ?? typeof h;
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }
    return [...counts].map(([name, n]) => (n > 1 ? `${name}×${n}` : name)).join(", ");
  } catch {
    return "(niet op te vragen)";
  }
}

log(
  `pid=${process.pid} node=${process.version} PORT=${process.env.PORT ?? "(niet gezet)"} ` +
    `RELAY_PORT=${process.env.RELAY_PORT ?? "(niet gezet)"}`,
);

// De event loop is leeg. Als dit verschijnt, is niet een fout de oorzaak maar
// het ontbreken van werk: de setInterval en/of de http-server zijn weg of
// nooit gestart. Het proces eindigt dan netjes met code 0.
process.on("beforeExit", (code) => {
  log(`beforeExit code=${code} — event loop leeg, niets houdt het proces meer bezig`);
  log(`  actieve handles: ${activeHandles()}`);
});

process.on("exit", (code) => {
  // Hier mag alleen nog synchroon werk; writeSync kan dat.
  log(`exit code=${code}`);
});

// Een signaal komt altijd van buiten het proces (Railway, Docker, npm).
// Zien we dit vóór het stoppen, dan eindigt het proces niet uit zichzelf.
for (const sig of ["SIGTERM", "SIGINT"] as const) {
  process.on(sig, () => {
    log(`signaal ${sig} ontvangen — van buiten het proces`);
    log(`  actieve handles: ${activeHandles()}`);
  });
}

// LET OP: door deze twee handlers te registreren onderdrukken we Node's
// standaardgedrag (crashen). We loggen daarom eerst en beëindigen daarna zelf
// met code 1, zodat het gedrag hetzelfde blijft maar de oorzaak zichtbaar wordt.
process.on("uncaughtException", (err, origin) => {
  log(`uncaughtException (origin=${origin}):`, err);
  process.exit(1);
});

process.on("unhandledRejection", (reason) => {
  log("unhandledRejection:", reason);
  process.exit(1);
});
