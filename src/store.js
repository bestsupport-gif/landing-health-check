// 단순 JSON 파일 저장소 (DATA_DIR/db.json)
const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const FILE = path.join(DATA_DIR, 'db.json');

const empty = () => ({ advertisers: [], runs: {}, history: {}, prices: {}, settings: { slackWebhook: '' } });

// 기본 모니터링 광고주 (저장 파일이 비어 있으면 자동 등록 — 무료 호스팅에서 재시작돼도 유지)
const DEFAULT_ADVERTISERS = [
  {
    id: 'hera',
    name: '헤라',
    aliases: ['HERA'],
    domains: ['hera.com', 'brand.naver.com/hera'],
    naverKeywords: ['헤라'],
    metaPageIds: [],
    googleAdvertiserIds: [],
    platforms: { meta: true, google: true, naver: true },
    schedule: true,
  },
];

let db = null;

function load() {
  if (db) return db;
  try {
    db = { ...empty(), ...JSON.parse(fs.readFileSync(FILE, 'utf8')) };
  } catch {
    db = empty();
  }
  if (!db.seeded) {
    for (const a of DEFAULT_ADVERTISERS) {
      if (!db.advertisers.some(x => x.id === a.id)) db.advertisers.unshift({ ...a, createdAt: new Date().toISOString() });
    }
    db.seeded = true;
  }
  return db;
}

let writing = Promise.resolve();
function save() {
  const snapshot = JSON.stringify(db);
  writing = writing.then(async () => {
    await fs.promises.mkdir(DATA_DIR, { recursive: true });
    const tmp = FILE + '.tmp';
    await fs.promises.writeFile(tmp, snapshot);
    await fs.promises.rename(tmp, FILE);
  }).catch(e => console.error('save failed', e));
  return writing;
}

module.exports = { load, save, DATA_DIR };
