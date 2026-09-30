import { describe, expect, it } from "vitest";
import { dataUrlBlob } from "../../public/design/js/files.js";

const b64 = (bytes) => btoa(String.fromCharCode(...bytes));
const JPEG = [0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1];

describe("dataUrlBlob", () => {
  it("labels a raster by its bytes, so a JPEG saved as image/png is sent as a JPEG", () => {
    expect(dataUrlBlob(`data:image/png;base64,${b64(JPEG)}`).type).toBe("image/jpeg");
  });
  it("keeps the declared type when the bytes are right", () => {
    const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0];
    expect(dataUrlBlob(`data:image/png;base64,${b64(png)}`).type).toBe("image/png");
  });
  it("leaves SVG alone", () => {
    expect(dataUrlBlob(`data:image/svg+xml;utf8,${encodeURIComponent("<svg/>")}`).type).toBe("image/svg+xml");
  });
});
