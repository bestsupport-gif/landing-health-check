// 사용법: node src/cli.js <광고주명> [--domains a.com,b.com] [--naver 키워드1,키워드2] [--only meta,google,naver]
const store = require('./store');
const { runCheck } = require('./runner');
const { closeBrowser } = require('./browser');

const args = process.argv.slice(2);
const opt = k => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : ''; };
const list = s => (s ? s.split(',').map(x => x.trim()).filter(Boolean) : []);

(async () => {
  const name = args[0];
  if (!name) { console.log('광고주명을 입력하세요'); process.exit(1); }
  const db = store.load();
  let adv = db.advertisers.find(a => a.name === name);
  if (!adv) {
    adv = { id: 'cli-' + Date.now().toString(36), name, aliases: [], domains: [], naverKeywords: [], platforms: {} };
    db.advertisers.push(adv);
  }
  if (opt('--domains')) adv.domains = list(opt('--domains'));
  if (opt('--naver')) adv.naverKeywords = list(opt('--naver'));
  if (opt('--only')) {
    const only = list(opt('--only'));
    adv.platforms = { meta: only.includes('meta'), google: only.includes('google'), naver: only.includes('naver') };
  }
  const run = await runCheck(adv.id, { log: m => console.log('·', m) });
  console.log(JSON.stringify(run.summary, null, 2));
  for (const r of run.rows.filter(r => r.level !== 'ok').slice(0, 40)) {
    console.log(`[${r.level}] ${r.platform} ${r.adId} ${r.landingUrl || '-'}\n   ${r.issues.map(i => i.msg).join(' | ')}`);
  }
  await closeBrowser();
})().catch(async e => { console.error(e); await closeBrowser(); process.exit(1); });
