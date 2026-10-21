const { chromium } = require('playwright');
const { UA_DESKTOP } = require('./util');

let browserPromise = null;

async function getBrowser() {
  if (!browserPromise) {
    browserPromise = chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] }).catch(e => {
      browserPromise = null;
      throw e;
    });
  }
  const b = await browserPromise;
  if (!b.isConnected()) { browserPromise = null; return getBrowser(); }
  return b;
}

async function withPage(fn, { userAgent = UA_DESKTOP, viewport = { width: 1280, height: 1800 } } = {}) {
  const browser = await getBrowser();
  const ctx = await browser.newContext({ userAgent, viewport, locale: 'ko-KR', timezoneId: 'Asia/Seoul' });
  // 이미지·폰트·미디어는 받지 않아 속도와 트래픽을 줄인다
  await ctx.route('**/*', route => {
    const t = route.request().resourceType();
    return ['image', 'media', 'font'].includes(t) ? route.abort() : route.continue();
  });
  const page = await ctx.newPage();
  try {
    return await fn(page);
  } finally {
    await ctx.close().catch(() => {});
  }
}

async function closeBrowser() {
  if (browserPromise) {
    const b = await browserPromise.catch(() => null);
    browserPromise = null;
    if (b) await b.close().catch(() => {});
  }
}

module.exports = { withPage, closeBrowser };
