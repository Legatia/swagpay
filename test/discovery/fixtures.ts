// Saved shapes of the services discovery talks to: Gemini with Google Search, shop pages and the VAT whitelist (synthetic data).

export const page = (body: string, headers: Record<string, string> = {}) =>
  new Response(`<html><body>${body}</body></html>`, { headers: { "content-type": "text/html; charset=utf-8", ...headers } });

/** A grounded generateContent answer listing `shops` as a fenced JSON array. */
export function geminiAnswer(shops: unknown[], searches = 3): Response {
  return Response.json({
    candidates: [{
      content: { parts: [{ text: "Thinking about it", thought: true }, { text: "Here are the shops:\n```json\n" + JSON.stringify(shops) + "\n```" }] },
      groundingMetadata: {
        webSearchQueries: Array.from({ length: searches }, (_, i) => `drukarnia koszulki ${i}`),
        groundingChunks: [{ web: { uri: "https://vertexaisearch.cloud.google.com/grounding-api-redirect/abc", title: "druk.pl" } }],
      },
    }],
  });
}

/** A whitelist answer: each NIP registered with the given name, VAT status and working address. */
export function whitelistAnswer(subjects: Record<string, { name: string; status: string; address: string }>): Response {
  return Response.json({
    result: {
      entries: Object.entries(subjects).map(([nip, s]) => ({
        identifier: nip,
        subjects: [{ name: s.name, nip, statusVat: s.status, residenceAddress: null, workingAddress: s.address, accountNumbers: ["11111111111111111111111111"] }],
      })),
      requestId: "test",
    },
  });
}

/** The whitelist's real response shape (fetched 2026-10-09), with synthetic subjects. */
export const WHITELIST_FIXTURE = {
  result: {
    entries: [
      { identifier: "1234567890", subjects: [] },
      {
        identifier: "1234563218",
        subjects: [{
          name: "DRUKARNIA TESTOWA SPÓŁKA Z OGRANICZONĄ ODPOWIEDZIALNOŚCIĄ", nip: "1234563218", statusVat: "Czynny", regon: "000000000", pesel: null, krs: "0000000000",
          residenceAddress: null, workingAddress: "UL. DŁUGA 1, 80-001 GDAŃSK", representatives: [], authorizedClerks: [], partners: [],
          registrationLegalDate: "2020-01-01", accountNumbers: ["11111111111111111111111111"], hasVirtualAccounts: false,
        }],
      },
      {
        identifier: "7251801126",
        subjects: [{ name: "JAN NOWAK NADRUKI", nip: "7251801126", statusVat: "Zwolniony", residenceAddress: "UL. PRYWATNA 2/3, 90-001 ŁÓDŹ", workingAddress: null, accountNumbers: [] }],
      },
      {
        identifier: "5260250995",
        subjects: [{ name: "WYKRESLONA SP. Z O.O.", nip: "5260250995", statusVat: "Niezarejestrowany", residenceAddress: null, workingAddress: "00-001 WARSZAWA", accountNumbers: [] }],
      },
    ],
    requestDateTime: "09-10-2026 10:25:26",
    requestId: "test",
  },
};
