import Holidays from "date-holidays";

const TZ = "Europe/Amsterdam";
const nl = new Holidays("NL");

/**
 * Wanneer mag er gebeld worden.
 *
 * Dit is bewust dezelfde logica als de inbound-assistent gebruikt om te
 * bepalen of het buiten kantooruren is — alleen omgekeerd. Draait op
 * Europe/Amsterdam, ongeacht waar de server staat.
 */

type Window = { start: string; end: string }; // "09:30", "16:30"

/** Onderdelen van een moment in Nederlandse tijd, ongeacht de servertijdzone. */
function amsterdamParts(at: Date) {
  const fmt = new Intl.DateTimeFormat("en-GB", {
    timeZone: TZ,
    weekday: "short",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const p = Object.fromEntries(
    fmt.formatToParts(at).map((x) => [x.type, x.value]),
  ) as Record<string, string>;

  return {
    weekday: p.weekday, // Mon .. Sun
    date: `${p.year}-${p.month}-${p.day}`,
    minutes: Number(p.hour) * 60 + Number(p.minute),
  };
}

function toMinutes(hhmm: string) {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

/** Officiële Nederlandse feestdag? Bevrijdingsdag telt alleen in lustrumjaren. */
export function isDutchHoliday(at: Date): false | string {
  const hit = nl.isHoliday(at);
  if (!hit) return false;

  const relevant = hit.find((h) => h.type === "public");
  if (!relevant) return false;

  // 5 mei is voor de meeste sectoren alleen elke vijf jaar een vrije dag.
  if (relevant.date.slice(5, 10) === "05-05") {
    const year = Number(relevant.date.slice(0, 4));
    if (year % 5 !== 0) return false;
  }

  return relevant.name;
}

export function isCallableMoment(at: Date, w: Window): boolean {
  const { minutes } = amsterdamParts(at);
  // TODO: tijdelijk uit voor test — terugzetten voor productie
  // const { weekday } = amsterdamParts(at);
  // if (weekday === "Sat" || weekday === "Sun") return false;
  if (isDutchHoliday(at)) return false;
  return minutes >= toMinutes(w.start) && minutes < toMinutes(w.end);
}

export function whyNotCallable(at: Date, w: Window): string | null {
  const { weekday, minutes } = amsterdamParts(at);
  if (weekday === "Sat" || weekday === "Sun") return "weekend";
  const holiday = isDutchHoliday(at);
  if (holiday) return `feestdag: ${holiday}`;
  if (minutes < toMinutes(w.start)) return `voor ${w.start}`;
  if (minutes >= toMinutes(w.end)) return `na ${w.end}`;
  return null;
}

/** Eerstvolgende moment waarop gebeld mag worden, vanaf `from`. */
export function nextCallableMoment(from: Date, w: Window): Date {
  const cursor = new Date(from);
  // Stap in kwartieren; over een week zoeken is ruim genoeg (max 4 vrije dagen op rij).
  for (let i = 0; i < 4 * 24 * 10; i++) {
    if (isCallableMoment(cursor, w)) return cursor;
    cursor.setMinutes(cursor.getMinutes() + 15);
  }
  return cursor;
}

/**
 * Wanneer proberen we het opnieuw na een mislukte poging?
 *
 * Bewust wisselende dagdelen: wie 's ochtends niet opneemt, is 's middags
 * vaak wel bereikbaar. Elke volgende poging schuift verder op.
 */
export function nextAttemptAt(attempts: number, w: Window, now = new Date()): Date {
  const offsets = [
    { days: 1, at: "14:00" }, // poging 2: volgende dag, middag
    { days: 3, at: "10:00" }, // poging 3: paar dagen later, ochtend
    { days: 7, at: "15:30" }, // poging 4: week later, eind middag
  ];
  const plan = offsets[Math.min(attempts - 1, offsets.length - 1)];

  const target = new Date(now);
  target.setDate(target.getDate() + plan.days);

  // Zet het doeltijdstip in Nederlandse tijd door te corrigeren voor het verschil.
  const { minutes } = amsterdamParts(target);
  target.setMinutes(target.getMinutes() + (toMinutes(plan.at) - minutes));

  return nextCallableMoment(target, w);
}
