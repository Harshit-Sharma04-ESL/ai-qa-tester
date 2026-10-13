import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { WebSocketServer } from 'ws';
import config from './config.js';
import { getSettings, updateSettings } from './settings.js';
import { health, ensureModel, pullModel, pullState, onPullProgress } from './ollama.js';
import { TestRun } from './runner.js';
import * as store from './store.js';
import { toPlaywrightSpec } from './codegen.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(root, 'public')));

// ---------------------------------------------------------------- websocket fan-out
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });
const broadcast = (msg) => {
  const data = JSON.stringify(msg);
  for (const c of wss.clients) {
    // Drop live-view frames for slow clients instead of buffering them.
    if (msg.type === 'frame' && c.bufferedAmount > 2_000_000) continue;
    if (c.readyState === 1) c.send(data);
  }
};
onPullProgress((model, state) => broadcast({ type: 'pull', model, state }));

let active = null; // only one run at a time: a CPU-bound local model can't serve parallel agents well

wss.on('connection', (ws) => {
  ws.send(JSON.stringify({ type: 'hello', activeRun: active?.data() || null }));
  if (active?.lastFrame) ws.send(JSON.stringify({ type: 'frame', runId: active.id, data: active.lastFrame }));
});

function startRun(params) {
  if (active) {
    const err = new Error(`Run ${active.id} is still in progress`);
    err.status = 409;
    throw err;
  }
  const run = new TestRun({ ...params, settings: getSettings() }, broadcast);
  active = run;
  broadcast({ type: 'started', run: run.data() });
  run.start().finally(() => {
    if (active === run) active = null;
  });
  return run;
}

const isUrl = (u) => {
  try {
    return ['http:', 'https:'].includes(new URL(u).protocol);
  } catch {
    return false;
  }
};

const wrap = (fn) => async (req, res) => {
  try {
    await fn(req, res);
  } catch (err) {
    res.status(err.status || 400).json({ error: err.message });
  }
};

// ---------------------------------------------------------------- status & models
app.get('/api/status', wrap(async (_req, res) => {
  const s = getSettings();
  const h = await health();
  res.json({
    ollama: { ...h, url: config.ollamaUrl },
    settings: s,
    modelReady: h.models.some((m) => m.name === (s.model.includes(':') ? s.model : `${s.model}:latest`)),
    pulls: Object.fromEntries(pullState),
    browser: config.browserWs ? `remote (${config.browserWs})` : 'local Chromium',
    hardware: config.hardware || `${os.cpus().length} CPU cores, ${(os.totalmem() / 2 ** 30).toFixed(1)} GB RAM (container view)`,
    modelReason: config.modelReason,
    activeRun: active?.data() || null,
  });
}));

app.post('/api/models/pull', wrap(async (req, res) => {
  const name = String(req.body.name || '').trim();
  if (!/^[\w.\-/:]+$/.test(name)) throw new Error('Invalid model name');
  pullModel(name).catch(() => {}); // progress is streamed over the websocket
  res.json({ ok: true });
}));

app.get('/api/settings', (_req, res) => res.json(getSettings()));
app.post('/api/settings', wrap(async (req, res) => {
  const s = updateSettings(req.body || {});
  ensureModel(s.model).catch(() => {});
  if (s.visionModel) ensureModel(s.visionModel).catch(() => {});
  res.json(s);
}));

// ---------------------------------------------------------------- runs
app.post('/api/runs', wrap(async (req, res) => {
  const { mode = 'ai', url, goal, scriptId } = req.body || {};
  if (mode === 'script') {
    const script = store.loadScript(scriptId);
    if (!script) throw new Error('Script not found');
    return res.json(startRun({ mode, url: script.url, script }).data());
  }
  if (!isUrl(url)) throw new Error('Enter a valid http(s) URL');
  if (!goal || !String(goal).trim()) throw new Error('Describe the test goal in plain English');
  res.json(startRun({ mode: 'ai', url, goal: String(goal).trim() }).data());
}));

app.get('/api/runs', (_req, res) => res.json(store.listRuns()));

app.get('/api/runs/:id', (req, res) => {
  if (active?.id === req.params.id) return res.json(active.data());
  const run = store.loadRun(req.params.id);
  return run ? res.json(run) : res.status(404).json({ error: 'Not found' });
});

app.delete('/api/runs/:id', (req, res) => {
  if (active?.id === req.params.id) return res.status(409).json({ error: 'Run is active' });
  res.json({ ok: store.deleteRun(req.params.id) });
});

for (const action of ['pause', 'resume', 'stop']) {
  app.post(`/api/runs/:id/${action}`, (req, res) => {
    if (active?.id !== req.params.id) return res.status(404).json({ error: 'Run is not active' });
    active[action]();
    res.json({ ok: true, status: active.status });
  });
}

/** Turn a finished run into a re-runnable script (AI runs use their recorded steps). */
function scriptFromRun(run, name) {
  if (run.mode === 'script' && run.scriptId) {
    const s = store.loadScript(run.scriptId);
    if (s) return s;
  }
  const tests = run.tests.filter((t) => t.recorded?.length > 1).map((t) => ({ title: t.title, expected: t.expected, steps: t.recorded }));
  if (!tests.length) throw new Error('This run has no recorded steps to replay');
  return { name: name || `${new URL(run.url).hostname}: ${run.goal || run.scriptName}`.slice(0, 100), url: run.url, goal: run.goal, fromRun: run.id, tests };
}

app.post('/api/runs/:id/rerun', wrap(async (req, res) => {
  const run = store.loadRun(req.params.id);
  if (!run) throw new Error('Run not found');
  if (req.body?.replay || run.mode === 'script') {
    const script = scriptFromRun(run);
    return res.json(startRun({ mode: 'script', url: script.url, script: { ...script, name: script.name || 'Replay' }, rerunOf: run.id }).data());
  }
  res.json(startRun({ mode: 'ai', url: run.url, goal: run.goal, rerunOf: run.id }).data());
}));

app.post('/api/runs/:id/save-script', wrap(async (req, res) => {
  const run = store.loadRun(req.params.id);
  if (!run) throw new Error('Run not found');
  const s = scriptFromRun(run, req.body?.name);
  res.json(store.saveScript({ ...s, id: undefined, createdAt: undefined }));
}));

app.get('/api/runs/:id/files/:file', (req, res) => {
  const file = req.params.file;
  if (!['report.html', 'video.webm', 'trace.zip'].includes(file)) return res.status(404).end();
  const p = path.join(config.dataDir, 'runs', req.params.id.replace(/[^\w-]/g, ''), file);
  if (!fs.existsSync(p)) return res.status(404).end();
  if (req.query.download) res.attachment(`${req.params.id}-${file}`);
  res.sendFile(p);
});

app.get('/api/runs/:id/screenshots/:file', (req, res) => {
  const p = path.join(config.dataDir, 'runs', req.params.id.replace(/[^\w-]/g, ''), 'screenshots', req.params.file.replace(/[^\w.-]/g, ''));
  return fs.existsSync(p) ? res.sendFile(p) : res.status(404).end();
});

// ---------------------------------------------------------------- scripts
app.get('/api/scripts', (_req, res) => res.json(store.listScripts()));
app.get('/api/scripts/:id', (req, res) => {
  const s = store.loadScript(req.params.id);
  return s ? res.json(s) : res.status(404).json({ error: 'Not found' });
});
app.post('/api/scripts', wrap(async (req, res) => res.json(store.saveScript({ ...req.body, id: undefined }))));
app.put('/api/scripts/:id', wrap(async (req, res) => {
  const existing = store.loadScript(req.params.id);
  if (!existing) throw new Error('Script not found');
  res.json(store.saveScript({ ...req.body, id: existing.id, createdAt: existing.createdAt }));
}));
app.delete('/api/scripts/:id', (req, res) => res.json({ ok: store.deleteScript(req.params.id) }));
app.get('/api/scripts/:id/export', (req, res) => {
  const s = store.loadScript(req.params.id);
  if (!s) return res.status(404).end();
  // attachment() would infer video/mp2t from ".ts", so set the type afterwards.
  res.attachment(`${s.name.replace(/[^\w-]+/g, '-').replace(/^-|-$/g, '').toLowerCase()}.spec.ts`).type('text/plain').send(toPlaywrightSpec(s));
});

// ---------------------------------------------------------------- boot
// Runs that were in progress when the server stopped can never finish.
for (const r of store.listRuns().filter((x) => ['queued', 'starting', 'planning', 'running', 'paused'].includes(x.status))) {
  const run = store.loadRun(r.id);
  store.saveRun({ ...run, status: 'error', error: 'Interrupted: the server restarted during this run', activity: '' });
}

// Seed example scripts on first start.
const examplesDir = path.join(root, 'examples');
if (fs.existsSync(examplesDir) && !store.listScripts().length) {
  for (const f of fs.readdirSync(examplesDir).filter((x) => x.endsWith('.json'))) {
    try {
      store.saveScript(JSON.parse(fs.readFileSync(path.join(examplesDir, f), 'utf8')));
    } catch (err) {
      console.warn(`Example ${f} skipped: ${err.message}`);
    }
  }
}

server.listen(config.port, () => {
  console.log(`AI QA Tester listening on http://localhost:${config.port}`);
  console.log(`Ollama: ${config.ollamaUrl}  model: ${getSettings().model}  browser: ${config.browserWs || 'local'}`);
  // Warm up: make sure the model is present (pulls it on first start).
  ensureModel(getSettings().model)
    .then(() => console.log(`Model ${getSettings().model} ready`))
    .catch((err) => console.warn(`Model not ready yet: ${err.message}`));
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    active?.stop();
    setTimeout(() => process.exit(0), active ? 5000 : 0);
  });
}
