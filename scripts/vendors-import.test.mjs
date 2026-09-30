import { test } from "node:test";
import assert from "node:assert/strict";
import { toVendorRows, upsertSql } from "./vendors-import-lib.mjs";

const warsaw = { name: "Projektant Nadruków", nip: "5342708006", email: "a@b.pl", website: "https://x.pl/", methods: ["dtg", "sublimation"], lead_days: {}, lat: 52.2, lng: 21, vat_status: "active", vat_checked_at: "2026-09-29" };

test("a Warsaw printer with an active VAT and an email is screened", () => {
  const [r] = toVendorRows("warsaw", [warsaw]);
  assert.equal(r.status, "screened");
  assert.equal(r.tax_id_type, "NIP");
  assert.equal(r.tax_id, "5342708006");
  assert.equal(r.tax_checked_at, "2026-09-29");
  assert.equal(r.city, "Warsaw");
  assert.equal(r.country, "PL");
  assert.equal(r.methods, JSON.stringify(["dtg"]));
  assert.equal(r.lead_days, "{}");
  assert.equal(r.source_ref, "warsaw:projektant-nadrukow");
});

test("Lisbon NIF valid as string or boolean screens", () => {
  const base = { name: "Gráfica Lisboa", email: "g@x.pt", methods: ["screen"], tax_id_type: "NIF", tax_id: "500000000" };
  assert.equal(toVendorRows("lisbon", [{ ...base, tax_status: "valid" }])[0].status, "screened");
  assert.equal(toVendorRows("lisbon", [{ ...base, tax_status: true }])[0].status, "screened");
  assert.equal(toVendorRows("lisbon", [{ ...base, tax_status: false }])[0].status, "candidate");
  assert.equal(toVendorRows("lisbon", [base])[0].source_ref, "lisbon:grafica-lisboa");
});

test("Lisbon screens on the VIES string the research records, and never on a false or invalid one", () => {
  // As in event-swag/data/lisbon-printers.json (STAMPA).
  const real = "valid: true; VIES name: S T A M P A - SERIGRAFIA E TRABALHOS ARTISTICOS PARA MATERIAIS DE POLIESTER E ALGODÃO S A";
  const base = { name: "STAMPA", email: "comercial@stampa.pt", methods: ["screen", "banner"], tax_id: "502334070", tax_checked_at: "2026-09-30" };
  const [r] = toVendorRows("lisbon", [{ ...base, tax_status: real }]);
  assert.equal(r.status, "screened");
  assert.equal(r.tax_status, real);
  assert.equal(toVendorRows("lisbon", [{ ...base, tax_status: "Valid" }])[0].status, "screened");
  for (const s of ["valid: false", "Valid: FALSE; VIES name: X", "valid: true; invalid since 2026", "invalid", "not valid", "unverified (NIF not published)", "validated elsewhere"]) {
    assert.equal(toVendorRows("lisbon", [{ ...base, tax_status: s }])[0].status, "candidate", s);
  }
  // Still needs an email.
  assert.equal(toVendorRows("lisbon", [{ ...base, email: null, tax_status: real }])[0].status, "candidate");
});

test("a Mumbai GSTIN that is format-checked only stays a candidate", () => {
  const [r] = toVendorRows("mumbai", [{ name: "Print Hungama", email: "i@x.in", methods: ["screen", "dtf"], tax_id_type: "GSTIN", tax_id: "27BRAPP6496D1ZI", tax_status: "format-checked only (15 chars)" }]);
  assert.equal(r.status, "candidate");
  assert.equal(r.country, "IN");
  assert.equal(toVendorRows("mumbai", [{ name: "N", email: "i@x.in", methods: [], tax_status: null }])[0].status, "candidate");
});

test("London screens on an active company number; a VAT number alone does not", () => {
  const base = { name: "Printsome (London)", email: "a@p.com", methods: ["screen"], tax_id_type: "UK VAT", tax_id: "513474993", tax_status: "unverified (api auth)" };
  assert.equal(toVendorRows("london", [base])[0].status, "candidate");
  assert.equal(toVendorRows("london", [{ ...base, company_number: "123", company_status: "dormant" }])[0].status, "candidate");
  assert.equal(toVendorRows("london", [{ ...base, company_number: "123", company_status: "active" }])[0].status, "screened");
  assert.equal(toVendorRows("london", [{ ...base, company_number: "123", company_status: "active", email: null }])[0].status, "candidate");
});

test("no email means candidate", () => {
  assert.equal(toVendorRows("warsaw", [{ ...warsaw, email: null }])[0].status, "candidate");
  assert.equal(toVendorRows("warsaw", [{ ...warsaw, email: "" }])[0].status, "candidate");
});

test("upsertSql escapes quotes and never touches payout or a partner/paused status", () => {
  const rows = toVendorRows("warsaw", [{ ...warsaw, name: "O'Neil's Print" }]);
  const sql = upsertSql(rows, "2099-01-01T00:00:00.000Z");
  assert.match(sql, /'O''Neil''s Print'/);
  assert.match(sql, /ON CONFLICT\(source_ref\) DO UPDATE SET/);
  assert.match(sql, /status = CASE WHEN vendors\.status IN \('partner', 'paused'\) THEN vendors\.status ELSE excluded\.status END/);
  const [insertPart, updatePart] = sql.split("ON CONFLICT");
  assert.ok(!/payout_/.test(insertPart) && !/payout_/.test(updatePart));
  assert.equal(upsertSql([], "x"), "");
});

test("skips nameless records and duplicate slugs with a warning", () => {
  const warns = [];
  const rows = toVendorRows("warsaw", [warsaw, { ...warsaw, name: "" }, { ...warsaw, name: undefined }, { ...warsaw, name: "PROJEKTANT nadrukow", email: "z@z.pl" }], (m) => warns.push(m));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].email, "a@b.pl");
  assert.equal(warns.length, 3);
});

test("a far printer keeps its own city and country; one without a city or country is skipped with a warning", () => {
  const base = { email: "p@x.pt", methods: ["screen"], tax_id_type: "NIF", tax_id: "500000000", tax_status: "valid" };
  const warnings = [];
  const rows = toVendorRows("far", [
    { ...base, name: "Porto Press", city: "Porto", country: "PT" },
    { ...base, name: "Nowhere Ltd" },
    { ...base, name: "Bad Country", city: "Riga", country: "Latvia" },
  ], (w) => warnings.push(w));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].city, "Porto");
  assert.equal(rows[0].country, "PT");
  assert.equal(rows[0].status, "screened");
  assert.equal(rows[0].source_ref, "far:porto:porto-press");
  assert.equal(warnings.length, 2);
  assert.match(warnings[0], /Nowhere Ltd/);
});
