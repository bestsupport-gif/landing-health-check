const { chromium } = require('playwright');
const { UA_DESKTOP } = require('./util');

let browserPromise = null;

// 저사양 서버(512MB)에서도 버티도록 동시에 여는 페이지 수를 제한
const MAX_PAGES = Number(process.env.BROWSER_CONCURRENCY || 1);
let active = 0;
const waiters = [];
async function acquire() {
  if (active < MAX_PAGES) { active++; return; }
  await new Promise(r => waiters.push(r));
}
function release() {
  const next = waiters.shift();
  if (next) next(); else active--;
}

async function getBrowser() {
  if (!browserPromise) {
    browserPromise = chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--no-zygote', '--renderer-process-limit=2'] }).catch(e => {
      browserPromise = null;
      throw e;
    });
  }
  const b = await browserPromise;
  if (!b.isConnected()) { browserPromise = null; return getBrowser(); }
  return b;
}

async function withPage(fn, { userAgent = UA_DESKTOP, viewport = { width: 1280, height: 1800 } } = {}) {
  await acquire();
  let ctx;
  try {
    const browser = await getBrowser();
    ctx = await browser.newContext({ userAgent, viewport, locale: 'ko-KR', timezoneId: 'Asia/Seoul' });
    // 이미지·폰트·미디어는 받지 않아 속도와 트래픽을 줄인다
    await ctx.route('**/*', route => {
      const t = route.request().resourceType();
      return ['image', 'media', 'font'].includes(t) ? route.abort() : route.continue();
    });
    const page = await ctx.newPage();
    return await fn(page);
  } finally {
    if (ctx) await ctx.close().catch(() => {});
    release();
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
