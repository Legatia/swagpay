// The Polish tax ID (NIP): its checksum, and finding it in a shop's page text.

const WEIGHTS = [6, 5, 7, 2, 3, 4, 5, 6, 7];

/** Ten digits whose first nine, weighted 6,5,7,2,3,4,5,6,7, sum mod 11 to the tenth (a remainder of 10 is never valid). */
export function isValidNip(nip: string): boolean {
  if (!/^\d{10}$/.test(nip)) return false;
  const check = WEIGHTS.reduce((sum, w, i) => sum + w * Number(nip[i]), 0) % 11;
  return check !== 10 && check === Number(nip[9]);
}

/** Valid NIPs written after "NIP" (optionally ":" or ".", "PL", spaces or dashes between digits), in order, each once, at most `max`. */
export function findNips(text: string, max = 2): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/\bNIP\s*[:.]?\s*(?:PL\s*)?(\d(?:[\s-]?\d){9})(?!\d)/gi)) {
    const nip = m[1].replace(/[\s-]/g, "");
    if (isValidNip(nip) && !out.includes(nip)) out.push(nip);
    if (out.length >= max) break;
  }
  return out;
}
