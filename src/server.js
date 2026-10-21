const express = require('express');
const path = require('path');
const crypto = require('crypto');
const cron = require('node-cron');
const store = require('./store');
const { runCheck } = require('./runner');

const app = express();
app.use(express.json({ limit: '1mb' }));

// 선택: ADMIN_PASSWORD 가 있으면 Basic 인증 (아이디는 아무 값)
const PASSWORD = process.env.ADMIN_PASSWORD;
const CRON_TOKEN = process.env.CRON_TOKEN;
app.get('/healthz', (req, res) => res.send('ok'));
app.post('/api/cron', (req, res, next) => {
  if (CRON_TOKEN && req.get('x-cron-token') === CRON_TOKEN) return enqueueAll('cron', res);
  next();
});
app.use((req, res, next) => {
  if (!PASSWORD) return next();
  const [, b64] = (req.get('authorization') || '').split(' ');
  const pass = b64 ? Buffer.from(b64, 'base64').toString().split(':').slice(1).join(':') : '';
  if (pass && crypto.timingSafeEqual(crypto.createHash('sha256').update(pass).digest(), crypto.createHash('sha256').update(PASSWORD).digest())) return next();
  res.set('WWW-Authenticate', 'Basic realm="landing-health"').status(401).send('인증 필요');
});
app.use(express.static(path.join(__dirname, '..', 'public')));

// ---- 작업 큐: 브라우저 메모리를 아끼려고 한 번에 하나씩 실행 ----
const jobs = new Map();
let queue = Promise.resolve();

function enqueue(advertiserId, trigger) {
  const running = [...jobs.values()].find(j => j.advertiserId === advertiserId && ['queued', 'running'].includes(j.status));
  if (running) return running;
  const job = { id: crypto.randomUUID(), advertiserId, trigger, status: 'queued', log: [], createdAt: new Date().toISOString() };
  jobs.set(job.id, job);
  queue = queue.then(async () => {
    job.status = 'running';
    const log = m => { job.log.push(`${new Date().toLocaleTimeString('ko-KR', { timeZone: 'Asia/Seoul' })} ${m}`); };
    try {
      await runCheck(advertiserId, { log });
      job.status = 'done';
    } catch (e) {
      log(`오류: ${e.message}`);
      job.status = 'error';
    }
    job.finishedAt = new Date().toISOString();
  });
  // 오래된 작업 정리
  for (const [id, j] of jobs) if (j.finishedAt && Date.now() - Date.parse(j.finishedAt) > 6 * 3600e3) jobs.delete(id);
  return job;
}

function enqueueAll(trigger, res) {
  const db = store.load();
  const list = db.advertisers.filter(a => a.schedule !== false).map(a => enqueue(a.id, trigger).id);
  if (res) res.json({ queued: list.length });
  return list;
}

// ---- 광고주 ----
const list = v => (Array.isArray(v) ? v : String(v || '').split(/[,\n]/)).map(s => String(s).trim()).filter(Boolean);

function sanitize(body, base = {}) {
  return {
    ...base,
    name: String(body.name ?? base.name ?? '').trim(),
    aliases: list(body.aliases ?? base.aliases),
    domains: list(body.domains ?? base.domains),
    naverKeywords: list(body.naverKeywords ?? base.naverKeywords),
    metaPageIds: list(body.metaPageIds ?? base.metaPageIds),
    googleAdvertiserIds: list(body.googleAdvertiserIds ?? base.googleAdvertiserIds),
    platforms: {
      meta: body.platforms?.meta ?? base.platforms?.meta ?? true,
      google: body.platforms?.google ?? base.platforms?.google ?? true,
      naver: body.platforms?.naver ?? base.platforms?.naver ?? true,
    },
    schedule: body.schedule ?? base.schedule ?? true,
  };
}

app.get('/api/advertisers', (req, res) => {
  const db = store.load();
  res.json(db.advertisers.map(a => {
    const run = db.runs[a.id];
    const job = [...jobs.values()].reverse().find(j => j.advertiserId === a.id);
    return { ...a, lastRun: run ? { startedAt: run.startedAt, summary: run.summary, platformStatus: run.platformStatus } : null, job: job && { id: job.id, status: job.status } };
  }));
});

app.post('/api/advertisers', async (req, res) => {
  const adv = sanitize(req.body);
  if (!adv.name) return res.status(400).json({ error: '광고주명을 입력하세요' });
  adv.id = crypto.randomBytes(5).toString('hex');
  adv.createdAt = new Date().toISOString();
  const db = store.load();
  db.advertisers.push(adv);
  await store.save();
  const job = req.body.runNow === false ? null : enqueue(adv.id, 'manual');
  res.json({ ...adv, job });
});

app.put('/api/advertisers/:id', async (req, res) => {
  const db = store.load();
  const i = db.advertisers.findIndex(a => a.id === req.params.id);
  if (i < 0) return res.status(404).json({ error: 'not found' });
  db.advertisers[i] = sanitize(req.body, db.advertisers[i]);
  await store.save();
  res.json(db.advertisers[i]);
});

app.delete('/api/advertisers/:id', async (req, res) => {
  const db = store.load();
  db.advertisers = db.advertisers.filter(a => a.id !== req.params.id);
  delete db.runs[req.params.id];
  delete db.history[req.params.id];
  await store.save();
  res.json({ ok: true });
});

app.post('/api/advertisers/:id/check', (req, res) => {
  if (!store.load().advertisers.some(a => a.id === req.params.id)) return res.status(404).json({ error: 'not found' });
  res.json(enqueue(req.params.id, 'manual'));
});

app.get('/api/advertisers/:id/result', (req, res) => {
  const db = store.load();
  res.json({ run: db.runs[req.params.id] || null, history: db.history[req.params.id] || [] });
});

// 소재 On/Off 제안 연동용 CSV
app.get('/api/advertisers/:id/report.csv', (req, res) => {
  const db = store.load();
  const adv = db.advertisers.find(a => a.id === req.params.id);
  const run = db.runs[req.params.id];
  if (!adv || !run) return res.status(404).send('결과 없음');
  const esc = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const head = ['플랫폼', '소재ID', '광고주(노출명)', '소재', '제안', '심각도', '이슈', '랜딩URL', '최종URL', 'HTTP', '랜딩가격', '소재링크', '점검시각'];
  const lines = run.rows.map(r => [r.platform, r.adId, r.advertiser, r.title, r.action, r.level, r.issues.map(i => i.msg).join(' / '),
    r.landingUrl, r.finalUrl, r.httpStatus, r.price, r.adUrl, run.startedAt].map(esc).join(','));
  res.set('content-type', 'text/csv; charset=utf-8');
  res.set('content-disposition', `attachment; filename*=UTF-8''${encodeURIComponent(`${adv.name}_랜딩헬스체크.csv`)}`);
  res.send('﻿' + [head.map(esc).join(','), ...lines].join('\n'));
});

app.get('/api/advertisers/:id/report.json', (req, res) => {
  const run = store.load().runs[req.params.id];
  if (!run) return res.status(404).json({ error: '결과 없음' });
  res.json({ ...run, rows: run.rows.map(r => ({ platform: r.platform, adId: r.adId, action: r.action, level: r.level, issues: r.issues, landingUrl: r.landingUrl })) });
});

app.get('/api/jobs/:id', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'not found' });
  res.json(job);
});

app.post('/api/check-all', (req, res) => enqueueAll('manual', res));

app.get('/api/settings', (req, res) => {
  const s = store.load().settings;
  res.json({ slackWebhook: s.slackWebhook ? '설정됨' : '', slackFromEnv: !!process.env.SLACK_WEBHOOK_URL, cron: CRON_EXPR });
});
app.put('/api/settings', async (req, res) => {
  const db = store.load();
  if (typeof req.body.slackWebhook === 'string') {
    const v = req.body.slackWebhook.trim();
    if (v && !/^https:\/\/hooks\.slack\.com\//.test(v)) return res.status(400).json({ error: '슬랙 웹훅 URL 형식이 아닙니다' });
    db.settings.slackWebhook = v;
  }
  await store.save();
  res.json({ ok: true });
});

// ---- 정기 점검 ----
const CRON_EXPR = process.env.CHECK_CRON || '0 */6 * * *';
if (CRON_EXPR !== 'off') {
  cron.schedule(CRON_EXPR, () => enqueueAll('schedule'), { timezone: 'Asia/Seoul' });
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`랜딩 헬스체크 http://localhost:${PORT} (정기점검: ${CRON_EXPR})`));
