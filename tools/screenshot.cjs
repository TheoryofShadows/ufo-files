// Dev visual check: render the built app in headless Chrome and save a PNG.
// Usage:
//   npm run preview            # in one shell
//   node tools/screenshot.cjs [url] [out.png]
// Requires the puppeteer devDependency (and `npx puppeteer browsers install chrome`).
const puppeteer = require("puppeteer");

(async () => {
  const url = process.argv[2] || "http://localhost:4173/";
  const out = process.argv[3] || "screenshot.png";
  const browser = await puppeteer.launch({ args: ["--no-sandbox", "--disable-setuid-sandbox"] });
  const page = await browser.newPage();
  await page.setViewport({ width: 402, height: 874, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
  await new Promise((r) => setTimeout(r, 4500)); // let fonts load + the canvas animation settle
  await page.screenshot({ path: out });
  console.log("saved", out);
  await browser.close();
})();
