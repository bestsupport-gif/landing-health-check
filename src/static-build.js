// GitHub Actions 용 정적 빌드: advertisers.json 의 광고주를 모두 점검하고 GitHub Pages 에 올릴 site/ 를 만든다.
//  - 이전 점검 상태(가격 이력·신규 이슈 판단용)는 배포된 사이트의 data/state.json 에서 받아 이어 쓴다
//  - 사용법: node src/static-build.js   (환경변수 PAGES_URL, GITHUB_REPOSITORY, SLACK_WEBHOOK_URL 선택)
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SITE = path.join(ROOT, 'site');
const STATE_DIR = path.join(ROOT, '.state');
process.env.DATA_DIR = STATE_DIR;

const store = require('./store');
const { runCheck } = require('./runner');
const { closeBrowser } = require('./browser');
const { advertiserSummary, toCsv, toReportJson } = require('./report');

async function restoreState() {
  const base = (process.env.PAGES_URL || '').replace(/\/$/, '');
  if (!base) return;
  try {
    const r = await fetch(`${base}/data/state.json`);
    if (!r.ok) return console.log(`이전 상태 없음 (HTTP ${r.status})`);
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(path.join(STATE_DIR, 'db.json'), await r.text());
    console.log('이전 점검 상태를 불러왔습니다');
  } catch (e) {
    console.log(`이전 상태 불러오기 실패: ${e.message}`);
  }
}

function writeFile(rel, content) {
  const p = path.join(SITE, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}

(async () => {
  await restoreState();
  const db = store.load();

  // 광고주 목록은 저장소의 advertisers.json 이 기준
  const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'advertisers.json'), 'utf8'));
  db.advertisers = config.map(a => ({ schedule: true, ...a, id: a.id || encodeURIComponent(a.name) }));
  db.settings = { slackWebhook: '' }; // 웹훅은 환경변수(SLACK_WEBHOOK_URL)로만 받는다
  const ids = new Set(db.advertisers.map(a => a.id));
  for (const k of Object.keys(db.runs)) if (!ids.has(k)) delete db.runs[k];

  const only = process.argv[2];
  for (const adv of db.advertisers) {
    if (only && adv.id !== only) continue;
    console.log(`\n=== ${adv.name} ===`);
    try {
      await runCheck(adv.id, { log: m => console.log(`· ${m}`) });
    } catch (e) {
      console.log(`실패: ${e.message}`);
    }
    await closeBrowser();
  }

  // 사이트 생성: public/ 복사 + 정적 모드 표시 + 데이터
  fs.rmSync(SITE, { recursive: true, force: true });
  fs.cpSync(path.join(ROOT, 'public'), SITE, { recursive: true });
  const repo = process.env.GITHUB_REPOSITORY || 'bestsupport-gif/landing-health-check';
  const html = fs.readFileSync(path.join(SITE, 'index.html'), 'utf8')
    .replace('<script src="app.js"></script>', `<script>window.STATIC_MODE = ${JSON.stringify({ repo, builtAt: new Date().toISOString() })};</script>\n<script src="app.js"></script>`);
  writeFile('index.html', html);

  writeFile('data/advertisers.json', JSON.stringify(db.advertisers.map(a => advertiserSummary(a, db.runs[a.id]))));
  for (const a of db.advertisers) {
    const run = db.runs[a.id] || null;
    writeFile(`data/results/${a.id}.json`, JSON.stringify({ run, history: db.history[a.id] || [] }));
    if (run) {
      writeFile(`data/results/${a.id}.csv`, toCsv(run));
      writeFile(`data/results/${a.id}.report.json`, JSON.stringify(toReportJson(run)));
    }
  }
  writeFile('data/state.json', JSON.stringify(db));
  writeFile('.nojekyll', '');
  console.log(`\n사이트 생성 완료: ${SITE}`);
})().catch(async e => {
  console.error(e);
  await closeBrowser();
  process.exit(1);
});
