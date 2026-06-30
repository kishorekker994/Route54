/**
 * Render poster.html as a 4K PNG using Puppeteer
 * 4K = 3840 x 5433px (A4 aspect ratio at 4x scale)
 */
const puppeteer = require('puppeteer');
const path = require('path');

(async () => {
  const posterPath = 'file://' + path.resolve(__dirname, 'poster.html');
  const outputPath = path.resolve(__dirname, 'route54-poster-4k.png');

  console.log('Launching browser...');
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  const page = await browser.newPage();

  // A4 at 96dpi = 794 x 1123px
  // 4K scale factor = ~4.8x to hit ~3840px wide
  const SCALE = 4;
  const WIDTH  = 794;
  const HEIGHT = 1123;

  // Set viewport at poster size
  await page.setViewport({
    width:  WIDTH,
    height: HEIGHT,
    deviceScaleFactor: SCALE
  });

  console.log(`Loading poster: ${posterPath}`);
  await page.goto(posterPath, { waitUntil: 'networkidle0', timeout: 30000 });

  // Wait for Google Fonts to load
  await new Promise(r => setTimeout(r, 3000));

  // Add rendering class to hide print button + invert QR
  await page.evaluate(() => {
    document.body.classList.add('rendering');
    // Hide print button
    const btn = document.querySelector('.print-btn');
    if (btn) btn.style.display = 'none';
  });

  await new Promise(r => setTimeout(r, 500));

  // Screenshot just the .poster element
  const posterEl = await page.$('.poster');
  if (!posterEl) {
    console.error('Could not find .poster element!');
    await browser.close();
    process.exit(1);
  }

  console.log(`Rendering at ${WIDTH * SCALE} x ${HEIGHT * SCALE}px (${SCALE}x scale)...`);
  await posterEl.screenshot({
    path: outputPath,
    type: 'png',
    omitBackground: false
  });

  await browser.close();

  console.log(`✅ 4K poster saved: ${outputPath}`);
  console.log(`   Resolution: ~${WIDTH * SCALE} x ${HEIGHT * SCALE} pixels`);
})();
