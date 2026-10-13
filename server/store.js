// File-based persistence: data/runs/<id>/run.json (+ artifacts) and data/scripts/<id>.json.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import config from './config.js';

const runsDir = path.join(config.dataDir, 'runs');
const scriptsDir = path.join(config.dataDir, 'scripts');
const safeId = (id) => (/^[\w-]+$/.test(id) ? id : null);

export const newId = (prefix) => {
  const d = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  return `${prefix}-${d}-${crypto.randomBytes(2).toString('hex')}`;
};

export function runDir(id) {
  if (!safeId(id)) throw new Error('bad id');
  const dir = path.join(runsDir, id);
  fs.mkdirSync(path.join(dir, 'screenshots'), { recursive: true });
  return dir;
}

export function saveRun(run) {
  fs.writeFileSync(path.join(runDir(run.id), 'run.json'), JSON.stringify(run, null, 2));
}

export function loadRun(id) {
  if (!safeId(id)) return null;
  try {
    return JSON.parse(fs.readFileSync(path.join(runsDir, id, 'run.json'), 'utf8'));
  } catch {
    return null;
  }
}

export function listRuns() {
  return fs
    .readdirSync(runsDir)
    .map((id) => loadRun(id))
    .filter(Boolean)
    .sort((a, b) => (b.startedAt || '').localeCompare(a.startedAt || ''))
    .map(({ id, mode, url, goal, scriptName, status, summary, startedAt, durationMs, model }) => ({ id, mode, url, goal, scriptName, status, summary, startedAt, durationMs, model }));
}

export function deleteRun(id) {
  if (!safeId(id)) return false;
  fs.rmSync(path.join(runsDir, id), { recursive: true, force: true });
  return true;
}

// ---------------------------------------------------------------- scripts
export function listScripts() {
  return fs
    .readdirSync(scriptsDir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      try {
        return JSON.parse(fs.readFileSync(path.join(scriptsDir, f), 'utf8'));
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
}

export function loadScript(id) {
  if (!safeId(id)) return null;
  try {
    return JSON.parse(fs.readFileSync(path.join(scriptsDir, `${id}.json`), 'utf8'));
  } catch {
    return null;
  }
}

export function validateScript(s) {
  if (!s || typeof s !== 'object') throw new Error('Script must be a JSON object');
  if (!s.name) throw new Error('Script needs a "name"');
  if (!s.url || !/^https?:\/\//.test(s.url)) throw new Error('Script needs an http(s) "url"');
  if (!Array.isArray(s.tests) || !s.tests.length) throw new Error('Script needs a non-empty "tests" array');
  for (const t of s.tests) {
    if (!t.title || !Array.isArray(t.steps)) throw new Error('Each test needs "title" and "steps"');
    for (const st of t.steps) if (!st.action) throw new Error(`Step without "action" in test "${t.title}"`);
  }
}

export function saveScript(script) {
  validateScript(script);
  const now = new Date().toISOString();
  const s = { ...script, id: safeId(script.id || '') || newId('s'), updatedAt: now, createdAt: script.createdAt || now };
  fs.writeFileSync(path.join(scriptsDir, `${s.id}.json`), JSON.stringify(s, null, 2));
  return s;
}

export function deleteScript(id) {
  if (!safeId(id)) return false;
  fs.rmSync(path.join(scriptsDir, `${id}.json`), { force: true });
  return true;
}
