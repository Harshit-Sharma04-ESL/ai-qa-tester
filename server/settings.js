// Runtime-editable settings (model choice etc.), persisted to data/settings.json.
import fs from 'node:fs';
import path from 'node:path';
import config from './config.js';

const file = path.join(config.dataDir, 'settings.json');
const defaults = { model: config.model, visionModel: config.visionModel, maxTests: config.maxTests, maxStepsPerTest: config.maxStepsPerTest };

let current = { ...defaults };
try {
  current = { ...defaults, ...JSON.parse(fs.readFileSync(file, 'utf8')) };
} catch { /* first start */ }

export function getSettings() {
  return { ...current };
}

export function updateSettings(patch) {
  for (const key of Object.keys(defaults)) {
    if (patch[key] === undefined) continue;
    current[key] = typeof defaults[key] === 'number' ? Math.max(1, Number(patch[key]) || defaults[key]) : String(patch[key]).trim();
  }
  fs.writeFileSync(file, JSON.stringify(current, null, 2));
  return getSettings();
}
