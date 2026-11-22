import { expect, test } from "@playwright/test";

// Installable, no service worker (spec §3.14).

/** Width and height from a PNG's IHDR chunk (bytes 16–23, big-endian). */
function pngSize(png: Buffer): string {
  expect(png.subarray(1, 4).toString("latin1")).toBe("PNG");
  return `${png.readUInt32BE(16)}x${png.readUInt32BE(20)}`;
}

test("manifest is served with its type and its icons exist at the declared sizes", async ({
  request,
}) => {
  const res = await request.get("/manifest.webmanifest");
  expect(res.status()).toBe(200);
  expect(res.headers()["content-type"]).toBe("application/manifest+json");

  const manifest = (await res.json()) as {
    name: string;
    display: string;
    start_url: string;
    icons: { src: string; sizes: string; type: string; purpose: string }[];
  };
  expect(manifest.name).toBe("Our Calendar");
  expect(manifest.display).toBe("standalone");
  expect(manifest.start_url).toBe("/");
  expect(manifest.icons.map((i) => i.purpose).sort()).toEqual(["any", "any", "maskable"]);

  for (const icon of manifest.icons) {
    const img = await request.get(icon.src);
    expect(img.status(), icon.src).toBe(200);
    expect(img.headers()["content-type"], icon.src).toBe("image/png");
    expect(pngSize(await img.body()), icon.src).toBe(icon.sizes);
  }
});

test("index links the manifest and the home-screen icons", async ({ page, request }) => {
  await page.goto("/signin");
  await expect(page.locator('link[rel="manifest"]')).toHaveAttribute(
    "href",
    "/manifest.webmanifest",
  );

  const touch = await page.locator('link[rel="apple-touch-icon"]').getAttribute("href");
  expect(touch).toBeTruthy();
  const img = await request.get(touch!);
  expect(img.headers()["content-type"]).toBe("image/png");
  expect(pngSize(await img.body())).toBe("180x180");

  for (const href of ["/favicon.svg", "/favicon.png"]) {
    expect((await request.get(href)).status(), href).toBe(200);
  }
});
