import { describe, expect, it } from "vitest";
import { findNips, isValidNip } from "../../src/discovery/nip";
import { CITY_PATTERN, cityFromAddress, cityKey, cleanText, shortLegalName } from "../../src/discovery/names";
import { extractPage, htmlText, readPage, safeUrl, type FetchLike } from "../../src/discovery/page";
import { parseSearchResponse, parseShops, searchShops } from "../../src/discovery/search";
import { checkWhitelist, parseWhitelist } from "../../src/discovery/whitelist";
import { WHITELIST_FIXTURE, page } from "./fixtures";

describe("NIP", () => {
  it("checks the checksum", () => {
    expect(isValidNip("5342708006")).toBe(true);
    expect(isValidNip("1234563218")).toBe(true);
    for (let d = 1; d <= 9; d++) expect(isValidNip(String(d).repeat(10))).toBe(true);
    expect(isValidNip("5342708007")).toBe(false);
    expect(isValidNip("1234567890")).toBe(false); // check digit would be 10
    expect(isValidNip("123456321")).toBe(false);
    expect(isValidNip("12345632a8")).toBe(false);
  });

  it("finds valid NIPs written after NIP, however they are formatted", () => {
    expect(findNips("Firma X, NIP: 534-270-80-06, REGON 543978521")).toEqual(["5342708006"]);
    expect(findNips("NIP PL 534 270 80 06")).toEqual(["5342708006"]);
    expect(findNips("nip:5342708006")).toEqual(["5342708006"]);
    expect(findNips("NIP 1234567890")).toEqual([]);
    expect(findNips("NIP 1111111111 NIP 1111111111 NIP 2222222222 NIP 3333333333")).toEqual(["1111111111", "2222222222"]);
    expect(findNips("SNIPPET 5342708006")).toEqual([]);
  });
});

describe("names", () => {
  it("keys cities without accents, case or English names", () => {
    for (const n of ["Gdańsk", "gdansk", "GDAŃSK", " Gdańsk "]) expect(cityKey(n)).toBe("gdansk");
    expect(cityKey("Warszawa")).toBe("warszawa");
    expect(cityKey("Warsaw")).toBe("warszawa");
    expect(cityKey("Kraków")).toBe("krakow");
    expect(cityKey("Cracow")).toBe("krakow");
    expect(cityKey("Łódź")).toBe("lodz");
    expect(cityKey("Bielsko-Biała")).toBe("bielsko biala");
    expect(cityKey(cityKey("Gdańsk"))).toBe("gdansk");
  });

  it("reads the city after the postal code of a registered address", () => {
    expect(cityFromAddress("POLANKI 31, 05-090 SŁOMIN")).toBe("Słomin");
    expect(cityFromAddress("UL. DŁUGA 1, 80-001 GDAŃSK")).toBe("Gdańsk");
    expect(cityFromAddress("43-300 BIELSKO-BIAŁA")).toBe("Bielsko-Biała");
    expect(cityFromAddress("UL. PRYWATNA 2/3, 90-001 ŁÓDŹ")).toBe("Łódź");
    expect(cityFromAddress("no postal code here")).toBeNull();
    expect(cityFromAddress(null)).toBeNull();
  });

  it("shortens legal forms and cleans web text", () => {
    expect(shortLegalName("PROJEKTANT NADRUKÓW SPÓŁKA Z OGRANICZONĄ ODPOWIEDZIALNOŚCIĄ")).toBe("PROJEKTANT NADRUKÓW sp. z o.o.");
    expect(shortLegalName("DRUK SPÓŁKA JAWNA")).toBe("DRUK sp.j.");
    expect(cleanText("a<b>\n c\u0000d", 20)).toBe("a b c d");
    expect(cleanText("x".repeat(100), 60)).toHaveLength(60);
  });

  it("accepts city names of letters, spaces and hyphens only", () => {
    for (const c of ["Gdańsk", "Bielsko-Biała", "Zielona Góra"]) expect(CITY_PATTERN.test(c)).toBe(true);
    for (const c of ["", "Gd4nsk", "<b>", "a".repeat(41), "-Gdańsk"]) expect(CITY_PATTERN.test(c)).toBe(false);
  });
});

describe("pages", () => {
  it("allows only public http(s) hosts on default ports", () => {
    expect(safeUrl("https://druk.pl/x")?.toString()).toBe("https://druk.pl/x");
    expect(safeUrl("http://druk.pl")?.toString()).toBe("http://druk.pl/");
    expect(safeUrl("http://druk.pl:80/")?.toString()).toBe("http://druk.pl/");
    expect(safeUrl("/kontakt", "https://druk.pl/")?.toString()).toBe("https://druk.pl/kontakt");
    for (const bad of ["ftp://druk.pl", "https://127.0.0.1/", "https://[::1]/", "https://localhost/", "https://printer.local/", "https://druk.pl:8443/", "https://u:p@druk.pl/", "https://druk/", "javascript:alert(1)", "not a url"]) {
      expect(safeUrl(bad)).toBeNull();
    }
  });

  it("follows redirects under the same rules and reads only HTML", async () => {
    const calls: string[] = [];
    const routes: Record<string, () => Response> = {
      "https://druk.pl/": () => new Response(null, { status: 301, headers: { location: "https://www.druk.pl/" } }),
      "https://www.druk.pl/": () => page("hello"),
      "https://bad.pl/": () => new Response(null, { status: 302, headers: { location: "http://10.0.0.1/" } }),
      "https://pdf.pl/": () => new Response("%PDF", { headers: { "content-type": "application/pdf" } }),
      "https://gone.pl/": () => new Response("no", { status: 404, headers: { "content-type": "text/html" } }),
      "https://big.pl/": () => new Response("a".repeat(400_000), { headers: { "content-type": "text/html" } }),
    };
    const f: FetchLike = async (input) => {
      calls.push(String(input));
      const r = routes[String(input)];
      if (!r) throw new Error("network down");
      return r();
    };
    const ok = await readPage(new URL("https://druk.pl/"), f);
    expect(ok?.url.toString()).toBe("https://www.druk.pl/");
    expect(ok?.html).toContain("hello");
    expect(await readPage(new URL("https://bad.pl/"), f)).toBeNull();
    expect(calls).not.toContain("http://10.0.0.1/");
    expect(await readPage(new URL("https://pdf.pl/"), f)).toBeNull();
    expect(await readPage(new URL("https://gone.pl/"), f)).toBeNull();
    expect(await readPage(new URL("https://down.pl/"), f)).toBeNull();
    expect((await readPage(new URL("https://big.pl/"), f))?.html.length).toBe(300_000);
  });

  it("extracts NIPs, an email on the shop's domain, methods and the contact page", () => {
    const html = `<html><head><script>var nip = "NIP: 1111111111";</script><style>.nip{}</style></head><body>
      <nav><a href="/o-nas">O nas</a> <a href="https://druk.pl/kontakt">Kontakt</a></nav>
      <p>Sitodruk, DTF i naklejki wycinane. Napisz: <a href="mailto:x@agency.com">agencja</a> lub <a href="mailto:biuro@druk.pl">biuro</a></p>
      <footer>DRUK sp. z o.o., NIP:&nbsp;534-270-80-06</footer></body></html>`;
    const facts = extractPage(html, new URL("https://www.druk.pl/"));
    expect(facts.nips).toEqual(["5342708006"]);
    expect(facts.email).toBe("biuro@druk.pl");
    expect(facts.methods).toEqual(["screen", "dtf", "diecut"]);
    // the kontakt link is on another host name (druk.pl, not www.druk.pl), so the about page is the fallback
    expect(facts.contactUrl?.toString()).toBe("https://www.druk.pl/o-nas");
    const same = extractPage(html.replace("https://druk.pl/kontakt", "/kontakt"), new URL("https://www.druk.pl/"));
    expect(same.contactUrl?.toString()).toBe("https://www.druk.pl/kontakt");
  });

  it("accepts a common Polish mailbox and drops other domains", () => {
    expect(extractPage(`<p>pisz: drukarnia@gmail.com</p>`, new URL("https://druk.pl/")).email).toBe("drukarnia@gmail.com");
    expect(extractPage(`<p>pisz: kontakt@agency.com</p>`, new URL("https://druk.pl/")).email).toBeNull();
    expect(extractPage(`<a href="/about-us">About</a>`, new URL("https://druk.pl/")).contactUrl?.toString()).toBe("https://druk.pl/about-us");
  });

  it("turns HTML into text", () => {
    expect(htmlText("<p>a&amp;b</p><script>x</script>&#211;&#x141; &amp;#211;")).toBe(" a&b ÓŁ &#211;");
  });
});

describe("search", () => {
  const shop = (name: string, website: string, extra: Record<string, unknown> = {}) => ({ name, website, nip: null, methods: ["screen"], ...extra });

  it("reads a fenced JSON array", () => {
    const text = "Here:\n```json\n" + JSON.stringify([shop("Druk", "https://druk.pl/oferta")]) + "\n```";
    expect(parseShops(text)).toEqual([{ name: "Druk", website: new URL("https://druk.pl"), nip: null, methods: ["screen"] }]);
  });

  it("finds the array between citation markers", () => {
    const text = `I found these [1][2]:\n${JSON.stringify([shop("Druk [Gdańsk]", "druk.pl")])}\nSources [3]`;
    expect(parseShops(text).map((s) => [s.name, s.website.toString()])).toEqual([["Druk [Gdańsk]", "https://druk.pl/"]]);
  });

  it("drops marketplaces, repeats and bad websites, normalises NIPs and methods, keeps at most 8", () => {
    const list = [
      shop("Allegro shop", "https://allegro.pl/sklep"),
      shop("FB", "https://www.facebook.com/druk"),
      shop("A", "https://a.pl", { nip: "534-270-80-06", methods: ["screen", "embroidery", "dtf", "dtf"] }),
      shop("A again", "https://www.a.pl/kontakt"),
      shop("Bad", "ftp://x.pl"),
      shop("", "https://noname.pl"),
      ...Array.from({ length: 10 }, (_, i) => shop(`S${i}`, `https://s${i}.pl`)),
    ];
    const out = parseShops(JSON.stringify(list));
    expect(out[0]).toEqual({ name: "A", website: new URL("https://a.pl"), nip: "5342708006", methods: ["screen", "dtf"] });
    expect(out.map((s) => s.name)).not.toContain("A again");
    expect(out).toHaveLength(8);
    expect(parseShops("no json here")).toEqual([]);
    expect(parseShops("[{ broken")).toEqual([]);
  });

  it("parses a grounded answer: skips thoughts, counts searches", () => {
    const r = parseSearchResponse({
      candidates: [{
        content: { parts: [{ text: "[{\"name\":\"no\"}]", thought: true }, { text: JSON.stringify([shop("Druk", "https://druk.pl")]) }] },
        groundingMetadata: { webSearchQueries: ["a", "b"], groundingChunks: [{ web: { uri: "https://vertexaisearch.cloud.google.com/x" } }] },
      }],
    });
    expect(r.shops.map((s) => s.name)).toEqual(["Druk"]);
    expect(r.searches).toBe(2);
    expect(r.links).toEqual(["https://vertexaisearch.cloud.google.com/x"]);
    expect(parseSearchResponse({})).toEqual({ shops: [], searches: 0, links: [] });
  });

  it("asks Gemini with Google Search grounding", async () => {
    let seen: { url: string; init: RequestInit | undefined } | null = null;
    const f: FetchLike = async (url, init) => {
      seen = { url: String(url), init };
      return Response.json({ candidates: [{ content: { parts: [{ text: "[]" }] } }] });
    };
    await searchShops({ GEMINI_API_KEY: "k" }, "Gdańsk", f);
    expect(seen!.url).toBe("https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent");
    expect((seen!.init?.headers as Record<string, string>)["x-goog-api-key"]).toBe("k");
    const body = JSON.parse(String(seen!.init?.body));
    expect(body.tools).toEqual([{ google_search: {} }]);
    expect(body.contents[0].parts[0].text).toContain("Gdańsk, Poland");
    const failing: FetchLike = async () => Response.json({ error: { message: "quota" } }, { status: 429 });
    await expect(searchShops({ GEMINI_API_KEY: "k" }, "Gdańsk", failing)).rejects.toThrow("Gemini 429: quota");
    await expect(searchShops({}, "Gdańsk", failing)).rejects.toThrow("GEMINI_API_KEY is not set");
  });
});

describe("whitelist", () => {
  it("keeps registered subjects (Czynny, Zwolniony) with their city and accounts", () => {
    const found = parseWhitelist(WHITELIST_FIXTURE);
    expect([...found.keys()]).toEqual(["1234563218", "7251801126"]);
    expect(found.get("1234563218")).toEqual({ nip: "1234563218", name: "DRUKARNIA TESTOWA SPÓŁKA Z OGRANICZONĄ ODPOWIEDZIALNOŚCIĄ", status: "Czynny", city: "Gdańsk", accounts: ["11111111111111111111111111"] });
    expect(found.get("7251801126")).toMatchObject({ status: "Zwolniony", city: "Łódź" });
    expect(parseWhitelist(null).size).toBe(0);
  });

  it("asks once for all NIPs and reports failures", async () => {
    const urls: string[] = [];
    const ok: FetchLike = async (url) => { urls.push(String(url)); return Response.json(WHITELIST_FIXTURE); };
    const r = await checkWhitelist(["1234563218", "7251801126", "1234563218"], "2026-10-09", ok);
    expect(urls).toEqual(["https://wl-api.mf.gov.pl/api/search/nips/1234563218,7251801126?date=2026-10-09"]);
    expect(r.ok && [...r.found.keys()]).toEqual(["1234563218", "7251801126"]);
    expect(await checkWhitelist([], "2026-10-09", async () => { throw new Error("no call expected"); })).toEqual({ ok: true, found: new Map() });
    const limited = await checkWhitelist(["1234563218"], "2026-10-09", async () => Response.json({ code: "WL-190", message: "limit" }, { status: 429 }));
    expect(limited.ok).toBe(false);
    const down = await checkWhitelist(["1234563218"], "2026-10-09", async () => { throw new Error("timeout"); });
    expect(down).toEqual({ ok: false, error: "whitelist unreachable: timeout" });
  });
});
