/**
 * Nederlandse namen voor de partnerstatussen uit db/schema.sql.
 *
 * Staat apart omdat zowel het dashboard als de Excel-export ze nodig heeft; een
 * export waarin 'self_reported' staat is voor de ontvanger niet te lezen.
 */
export const STATUS_LABELS: Record<string, string> = {
  pending: "nog niet aangekondigd",
  announced: "mail verstuurd",
  scheduled: "belafspraak",
  calling: "in gesprek",
  completed: "wacht op akkoord",
  verified: "bevestigd",
  self_reported: "zelf ingevuld",
  no_answer: "niet opgenomen",
  refused: "wil niet meedoen",
  invalid: "nummer klopt niet",
  excluded: "niet bellen",
};

export function statusLabel(status: string): string {
  return STATUS_LABELS[status] ?? status;
}

/** Waar het antwoord vandaan komt: aan de telefoon of via het webformulier. */
export function sourceLabel(source: string | null): string {
  if (!source) return "";
  return { call: "telefonisch", form: "webformulier" }[source] ?? source;
}
