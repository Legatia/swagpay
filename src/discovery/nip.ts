// The Polish tax ID (NIP): its checksum, and finding it in a shop's page text.

const WEIGHTS = [6, 5, 7, 2, 3, 4, 5, 6, 7];

/** Ten digits whose first nine, weighted 6,5,7,2,3,4,5,6,7, sum mod 11 to the tenth (a remainder of 10 is never valid). */
export function isValidNip(nip: string): boolean {
  if (!/^\d{10}$/.test(nip)) return false;
  const check = WEIGHTS.reduce((sum, w, i) => sum + w * Number(nip[i]), 0) % 11;
  return check !== 10 && check === Number(nip[9]);
}

/**
 * Valid NIPs written after "NIP": up to 12 characters of label first ("NIP:", "NIP/VAT:", "NIP nr", "NIP (VAT):", "PL-"), then ten digits
 * that may be split by spaces, dots or dashes. In order, each once, at most `max`.
 */
export function findNips(text: string, max = 2): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/\bNIP\b[^\d\n]{0,12}?(\d(?:[\s.\u00a0-]?\d){9})(?!\d)/gi)) {
    const nip = m[1].replace(/[\s.\u00a0-]/g, "");
    if (isValidNip(nip) && !out.includes(nip)) out.push(nip);
    if (out.length >= max) break;
  }
  return out;
}
