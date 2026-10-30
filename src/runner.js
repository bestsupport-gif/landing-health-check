// 광고주 1곳에 대해: 플랫폼별 소재 수집 → 랜딩 URL 점검 → 결과 저장 → 신규 이슈 알림
const { crawlMeta } = require('./crawlers/meta');
const { crawlGoogle } = require('./crawlers/google');
const { crawlNaver } = require('./crawlers/naver');
const { checkUrl, missingUtm, urlKey, adPrices } = require('./checker');
const { pool } = require('./util');
const store = require('./store');
const { notify } = require('./notify');

const CRAWLERS = { meta: crawlMeta, google: crawlGoogle, naver: crawlNaver };
const LEVEL_RANK = { critical: 3, warn: 2, info: 1, ok: 0 };
// Meta 인스턴트 경험(캔버스) 등 외부 랜딩이 아닌 링크는 점검 대상에서 뺀다
const APP_STORE_RE = /^https?:\/\/(play\.google\.com|itunes\.apple\.com|apps\.apple\.com|onestore\.co\.kr|m\.onestore\.co\.kr)\//i;
const SKIP_URL_RE =/^https?:\/\/(www\.|m\.|l\.)?(fb\.com|facebook\.com|fb\.me|instagram\.com)\//i;
const ACTION = { critical: 'OFF/랜딩 수정', warn: '점검 필요', info: '수동 확인', ok: '유지' };

function fmt(n) { return Number(n).toLocaleString('ko-KR'); }

async function runCheck(advertiserId, { log = () => {} } = {}) {
  const db = store.load();
  const adv = db.advertisers.find(a => a.id === advertiserId);
  if (!adv) throw new Error('광고주를 찾을 수 없습니다');
  const startedAt = new Date().toISOString();
  const platforms = Object.keys(CRAWLERS).filter(p => adv.platforms?.[p] !== false);

  // 1) 소재 수집
  const ads = [];
  const platformStatus = {};
  for (const p of platforms) {
    log(`${p} 소재 수집 중...`);
    try {
      const list = await CRAWLERS[p](adv, { log });
      ads.push(...list);
      platformStatus[p] = { ok: true, ads: list.length };
    } catch (e) {
      log(`${p} 수집 실패: ${e.message}`);
      platformStatus[p] = { ok: false, error: e.message.split('\n')[0] };
    }
  }

  // 2) 고유 랜딩 URL 점검
  const urls = [...new Set(ads.flatMap(a => a.landingUrls))].filter(u => !SKIP_URL_RE.test(u));
  log(`랜딩 URL ${urls.length}개 점검 중...`);
  const results = new Map();
  let done = 0;
  await pool(urls, 4, async u => {
    results.set(u, await checkUrl(u));
    if (++done % 5 === 0 || done === urls.length) log(`랜딩 점검 ${done}/${urls.length}`);
  });

  // 3) 가격 변경 (이전 점검 대비)
  const priceChanges = new Map();
  for (const r of results.values()) {
    if (r.price == null) continue;
    const key = urlKey(r.finalUrl);
    const prev = db.prices[key];
    if (prev && prev.price !== r.price) priceChanges.set(r.url, { from: prev.price, to: r.price, at: prev.at });
    db.prices[key] = { price: r.price, at: startedAt };
  }

  // 4) 소재 × 랜딩 행 구성
  const rows = [];
  for (const ad of ads) {
    const landings = ad.landingUrls.length ? ad.landingUrls : [null];
    for (const u of landings) {
      const r = u ? results.get(u) : null;
      const issues = r ? [...r.issues] : [];
      if (!u) {
        issues.push({ type: 'no_url', level: 'info', msg: ad.platform === 'google' ? '랜딩 URL 비공개 소재 (투명성센터 미노출)' : '랜딩 URL 없음' });
      } else if (SKIP_URL_RE.test(u)) {
        issues.push({ type: 'skipped', level: 'info', msg: 'Meta 인스턴트 경험/SNS 링크 — 점검 제외' });
      }
      // 앱 설치 광고(스토어 링크)는 UTM 대신 스토어·MMP 추적을 쓰므로 UTM 점검에서 뺀다
      const appStore = u && APP_STORE_RE.test(u);
      if (r && !ad.utmNotApplicable && !appStore) {
        const miss = missingUtm(u, r.finalUrl);
        if (miss.length) {
          const note = ad.platform === 'meta' ? ' — Meta "URL 매개변수" 필드 사용 시 라이브러리에 안 보일 수 있음' : '';
          issues.push({ type: 'utm_missing', level: 'warn', msg: `UTM 누락: ${miss.join(', ')}${note}` });
        }
      }
      const pc = u && priceChanges.get(u);
      if (pc) issues.push({ type: 'price_change', level: 'warn', msg: `가격 변경 ${fmt(pc.from)}원 → ${fmt(pc.to)}원` });
      // 캐러셀(랜딩 여러 개)은 본문 가격이 어느 카드 것인지 알 수 없어 비교하지 않는다
      if (r && r.price && ad.landingUrls.length === 1) {
        const ap = adPrices(ad.text);
        if (ap.length && !ap.includes(r.price)) {
          issues.push({ type: 'price_mismatch', level: 'warn', msg: `광고 문구 가격(${ap.map(fmt).join('/')}원) ≠ 랜딩 가격(${fmt(r.price)}원)` });
        }
      }
      const level = issues.reduce((m, i) => (LEVEL_RANK[i.level] > LEVEL_RANK[m] ? i.level : m), 'ok');
      rows.push({
        platform: ad.platform,
        adId: ad.adId,
        adUrl: ad.adUrl,
        advertiser: ad.advertiser,
        format: ad.format || '',
        title: ad.title,
        landingUrl: u,
        finalUrl: r?.finalUrl || null,
        httpStatus: r?.httpStatus ?? null,
        price: r?.price ?? null,
        pageType: r?.pageType || null,
        pageTitle: r?.title || '',
        issues,
        level,
        action: ACTION[level],
      });
    }
  }
  rows.sort((a, b) => (LEVEL_RANK[b.level] || 0) - (LEVEL_RANK[a.level] || 0));

  const summary = {
    ads: ads.length,
    urls: urls.length,
    critical: rows.filter(r => r.level === 'critical').length,
    warn: rows.filter(r => r.level === 'warn').length,
    ok: rows.filter(r => r.level === 'ok').length,
    byType: rows.flatMap(r => r.issues).reduce((m, i) => ((m[i.type] = (m[i.type] || 0) + 1), m), {}),
  };

  // 5) 신규 이슈 (이전 실행에 없던 소재+유형) 알림
  const prev = db.runs[adv.id];
  const prevKeys = new Set((prev?.rows || []).flatMap(r => r.issues.map(i => `${r.platform}|${r.adId}|${r.landingUrl}|${i.type}`)));
  const newIssues = rows.flatMap(r => r.issues
    .filter(i => i.level !== 'info' && !prevKeys.has(`${r.platform}|${r.adId}|${r.landingUrl}|${i.type}`))
    .map(i => ({ ...i, row: r })));

  const run = { advertiserId: adv.id, startedAt, finishedAt: new Date().toISOString(), platformStatus, summary, rows, newIssueCount: newIssues.length };
  db.runs[adv.id] = run;
  db.history[adv.id] = [{ at: startedAt, ...summary, newIssues: newIssues.length }, ...(db.history[adv.id] || [])].slice(0, 30);
  await store.save();

  if (newIssues.length) {
    try { await notify(adv, run, newIssues); } catch (e) { log(`알림 실패: ${e.message}`); }
  }
  log(`완료: 소재 ${summary.ads}건 / OFF 제안 ${summary.critical} / 점검 ${summary.warn} / 신규 이슈 ${newIssues.length}`);
  return run;
}

module.exports = { runCheck };
