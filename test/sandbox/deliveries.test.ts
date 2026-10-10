import { describe, expect, it } from "vitest";
import type { VendorRow } from "../../src/vendors";
import { SIMULATED, simulatedDeliveries } from "../../src/sandbox/printer";

const vendor = (city: string, country = "PL") => ({ id: 1, name: "Tee Works", city, country }) as VendorRow;
const READY = "2026-10-14"; // a Wednesday

describe("simulatedDeliveries", () => {
  it("offers pickup and same-day when the printer is in the delivery city", () => {
    const d = simulatedDeliveries(vendor("Warszawa"), "warszawa", READY);
    expect(d.map((x) => x.method)).toEqual(["pickup", "same_day"]);
    expect(d[0]).toMatchObject({ costPln: 0, arrivesAt: READY });
    expect(d[1]).toMatchObject({ costPln: 0.6, arrivesAt: READY });
  });
  it("matches cities by key, whatever the spelling", () => {
    expect(simulatedDeliveries(vendor("Kraków"), "krakow", READY)[0].method).toBe("pickup");
  });
  it("offers a courier or a parcel locker elsewhere in Poland, skipping the weekend", () => {
    const d = simulatedDeliveries(vendor("Łódź"), "warszawa", "2026-10-16"); // a Friday
    expect(d.map((x) => [x.method, x.costPln, x.arrivesAt])).toEqual([["courier", 0.25, "2026-10-20"], ["parcel_locker", 0.15, "2026-10-20"]]);
  });
  it("offers a slower and a faster courier from abroad", () => {
    const d = simulatedDeliveries(vendor("Lisboa", "PT"), "warszawa", READY);
    expect(d.map((x) => [x.method, x.costPln, x.arrivesAt])).toEqual([["courier", 0.9, "2026-10-21"], ["printer_courier", 1.5, "2026-10-19"]]);
  });
  it("treats an unknown printer or city as elsewhere in Poland", () => {
    expect(simulatedDeliveries(null, "warszawa", READY).map((x) => x.method)).toEqual(["courier", "parcel_locker"]);
    expect(simulatedDeliveries(vendor("Warszawa"), null, READY).map((x) => x.method)).toEqual(["courier", "parcel_locker"]);
  });
  it("keeps every option under $1 and labels it simulated", () => {
    for (const [v, c] of [[vendor("Warszawa"), "warszawa"], [vendor("Gdańsk"), "warszawa"], [vendor("Lisboa", "PT"), "warszawa"]] as const) {
      for (const x of simulatedDeliveries(v, c, READY)) {
        expect(x.costPln / 3.95).toBeLessThan(1);
        expect(x.note).toContain(SIMULATED);
      }
    }
  });
});
