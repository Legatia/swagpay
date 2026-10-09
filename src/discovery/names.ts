// Names as discovery reads them: city keys, the city in a registered address, short legal names, cleaned web text.

/** A city name the agent or the live check may pass: 1 to 40 letters, spaces or hyphens, starting with a letter. */
export const CITY_PATTERN = /^\p{L}[\p{L} -]{0,39}$/u;

const ALIASES: Record<string, string> = { warsaw: "warszawa", cracow: "krakow", krakau: "krakow", danzig: "gdansk", breslau: "wroclaw", posen: "poznan" };

/** A city's matching key: accents and ł folded, lowercase, spaces and dashes collapsed, English and German names mapped to Polish. Idempotent. */
export function cityKey(name: string): string {
  const k = name.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[łŁ]/g, "l").toLowerCase().replace(/[\s-]+/g, " ").trim();
  return ALIASES[k] ?? k;
}

function titleCase(s: string): string {
  return s.toLowerCase().replace(/(^|[\s-])(\p{L})/gu, (_, sep: string, ch: string) => sep + ch.toUpperCase());
}

/** "POLANKI 31, 05-090 SŁOMIN" → "Słomin": the words after the last Polish postal code (NN-NNN), title-cased; null when there is none. */
export function cityFromAddress(address: string | null): string | null {
  if (!address) return null;
  const m = [...address.matchAll(/\b\d{2}-\d{3}\s+([^,\d]+)/g)].pop();
  const raw = m?.[1].trim();
  return raw ? titleCase(raw) : null;
}

const FORMS: Array<[RegExp, string]> = [
  [/SPÓŁKA Z OGRANICZONĄ ODPOWIEDZIALNOŚCIĄ/giu, "sp. z o.o."],
  [/SPÓŁKA KOMANDYTOWA/giu, "sp.k."],
  [/SPÓŁKA JAWNA/giu, "sp.j."],
  [/SPÓŁKA AKCYJNA/giu, "S.A."],
];

/** A registered name as the agent reads it: legal forms shortened, whitespace collapsed, at most 60 characters. */
export function shortLegalName(name: string): string {
  let s = name;
  for (const [re, short] of FORMS) s = s.replace(re, short);
  return cleanText(s, 60);
}

/** Web or model text made safe to show: control characters, angle brackets and backticks removed, whitespace collapsed, cut to `max`. */
export function cleanText(s: string, max: number): string {
  return s.replace(/[\u0000-\u001f\u007f<>`]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}
