// 팝업과 백그라운드가 같이 쓰는 설정·데이터 로더
const BASE = 'https://bestsupport-gif.github.io/landing-health-check/';
const REPO = 'bestsupport-gif/landing-health-check';
const LINKS = {
  page: BASE,
  run: `https://github.com/${REPO}/actions/workflows/check.yml`,
  edit: `https://github.com/${REPO}/edit/main/advertisers.json`,
};

async function getJson(path) {
  const r = await fetch(BASE + path + (path.includes('?') ? '&' : '?') + 't=' + Date.now(), { cache: 'no-store' });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

const loadAdvertisers = () => getJson('data/advertisers.json');
const loadResult = id => getJson(`data/results/${encodeURIComponent(id)}.json`);

// 배지: OFF/랜딩 수정 개수(빨강) 우선, 없으면 점검 필요 개수(주황)
function badgeOf(advertisers) {
  let critical = 0, warn = 0;
  for (const a of advertisers) {
    critical += a.lastRun?.summary?.critical || 0;
    warn += a.lastRun?.summary?.warn || 0;
  }
  if (critical) return { text: String(critical), color: '#d92d20', critical, warn };
  if (warn) return { text: String(warn), color: '#dc6803', critical, warn };
  return { text: '', color: '#067647', critical, warn };
}
