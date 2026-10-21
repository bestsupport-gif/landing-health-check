// 단순 JSON 파일 저장소 (DATA_DIR/db.json)
const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const FILE = path.join(DATA_DIR, 'db.json');

const empty = () => ({ advertisers: [], runs: {}, history: {}, prices: {}, settings: { slackWebhook: '' } });

let db = null;

function load() {
  if (db) return db;
  try {
    db = { ...empty(), ...JSON.parse(fs.readFileSync(FILE, 'utf8')) };
  } catch {
    db = empty();
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
