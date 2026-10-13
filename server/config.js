import path from 'node:path';
import fs from 'node:fs';

const num = (v, d) => (v === undefined || v === '' || Number.isNaN(Number(v)) ? d : Number(v));
const bool = (v, d) => (v === undefined || v === '' ? d : !['0', 'false', 'no', 'off'].includes(String(v).toLowerCase()));

const dataDir = path.resolve(process.env.DATA_DIR || 'data');
fs.mkdirSync(path.join(dataDir, 'runs'), { recursive: true });
fs.mkdirSync(path.join(dataDir, 'scripts'), { recursive: true });

const config = {
  port: num(process.env.PORT, 8080),
  dataDir,
  ollamaUrl: (process.env.OLLAMA_URL || 'http://localhost:11434').replace(/\/$/, ''),
  // Defaults; can be changed at runtime from the Settings tab (persisted in data/settings.json).
  model: process.env.OLLAMA_MODEL || 'qwen3-vl:4b-instruct',
  visionModel: process.env.VISION_MODEL ?? '',
  autoPull: bool(process.env.OLLAMA_AUTO_PULL, true),
  numCtx: num(process.env.OLLAMA_NUM_CTX, 8192),
  llmTimeoutMs: num(process.env.LLM_TIMEOUT_MS, 300_000),
  // Remote Playwright browser server (docker-compose "browser" service). Empty = launch Chromium locally.
  browserWs: process.env.BROWSER_WS_ENDPOINT || '',
  viewport: { width: num(process.env.VIEWPORT_WIDTH, 1280), height: num(process.env.VIEWPORT_HEIGHT, 800) },
  maxTests: num(process.env.MAX_TESTS, 4),
  maxStepsPerTest: num(process.env.MAX_STEPS_PER_TEST, 8),
  actionTimeoutMs: num(process.env.ACTION_TIMEOUT_MS, 8000),
  maxElements: num(process.env.SNAPSHOT_MAX_ELEMENTS, 40),
  maxTextChars: num(process.env.SNAPSHOT_MAX_TEXT, 700),
  // Hardware summary + model rationale written to .env by start.sh (host-side detection).
  hardware: process.env.HW_SUMMARY || '',
  modelReason: process.env.MODEL_REASON || '',
};

export default config;
