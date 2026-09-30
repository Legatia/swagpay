import { describe, expect, it } from "vitest";
import { CACHE, PRECACHE, route } from "../../public/design/js/sw-routes.js";

const O = "https://app.swagpay.me";
const r = (path) => route(new URL(path, O), O);

describe("service worker routes", () => {
  it("never caches the API, order pages or admin", () => {
    expect(r("/api/pricing")).toBe("network");
    expect(r("/api/o/abc/design")).toBe("network");
    expect(r(`/o/${"t".repeat(43)}`)).toBe("network");
    expect(r("/admin")).toBe("network");
    expect(r("/new")).toBe("network");
  });
  it("caches the editor and the brand files it uses", () => {
    expect(r("/design/")).toBe("static");
    expect(r("/design/js/app.js")).toBe("static");
    expect(r("/design/price-table.json")).toBe("static");
    expect(r("/brand-tokens.css")).toBe("static");
    expect(r("/mascot.svg")).toBe("static");
  });
  it("caches Google Fonts", () => {
    expect(route(new URL("https://fonts.googleapis.com/css2?family=Figtree"), O)).toBe("font");
    expect(route(new URL("https://fonts.gstatic.com/s/figtree/v1/x.woff2"), O)).toBe("font");
  });
  it("leaves other sites alone", () => {
    expect(route(new URL("https://challenges.cloudflare.com/turnstile/v0/api.js"), O)).toBe("network");
  });
  it("precaches only static routes", () => {
    expect(CACHE).toMatch(/^swagpay-design-v\d+$/);
    for (const p of PRECACHE) expect(r(p)).toBe("static");
    expect(PRECACHE).toContain("/design/js/app.js");
    expect(PRECACHE).toContain("/design/js/submit.js");
  });
});
