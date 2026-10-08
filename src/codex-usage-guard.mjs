import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const CODEX_WEEKLY_LIMIT = 85;

const HUB_LIMITS = path.join(process.env.AGENTS_HUB_HOME ?? os.homedir(), '.agents-hub-bot', 'codex-limits.json');
const HUB_LIMITS_FRESH_MS = 30 * 60 * 1000;

// limits.json is overwritten by every rateLimits update, including blank ones (08.10: primary = null at 7d = 100 %, so this guard saw null and let a Desktop critic spend paid credits);
// the dispatcher keeps the last good reading in codex-limits.json (refreshed every 2 min), trusted while it is younger than 30 min.
export function codexWeeklyPercent(file = path.join(os.homedir(), '.codex-peers', 'limits.json'), fallback = HUB_LIMITS) {
  try {
    const limits = JSON.parse(fs.readFileSync(file, 'utf8')).rateLimits;
    const weekly = [limits?.primary, limits?.secondary].find(window => window?.windowDurationMins === 10080);
    if (Number.isFinite(weekly?.usedPercent)) return weekly.usedPercent;
  } catch { /* fall through */ }
  try {
    const known = JSON.parse(fs.readFileSync(fallback, 'utf8'));
    return Number.isFinite(known.weekly) && Date.now() - known.ts * 1000 < HUB_LIMITS_FRESH_MS ? known.weekly : null;
  } catch {
    return null;
  }
}

export const CODEX_EXHAUSTED = 100;

// Codex Desktop tasks run on ChatGPT auth only: at 100 % of the week nothing starts or continues there, whatever the model or flags (hub P0, 08.10.2026; reset 14.10).
export function assertCodexAvailable(file) {
  const percent = codexWeeklyPercent(file);
  if (percent >= CODEX_EXHAUSTED) {
    throw new Error(`Codex Desktop недоступен до сброса недельного лимита (сейчас ${percent} %, сброс 14.10): критика — Claude-сабагент другой модели (правило critic); Codex-задача — через codex-peer на маршруте Devora (codex-peer new …), не через create_oai_session / send_to_oai_session`);
  }
  return percent;
}

export function assertCodexBudget({ model, allowHighCodexUsage = false, file } = {}) {
  assertCodexAvailable(file);
  const percent = codexWeeklyPercent(file);
  if (percent > CODEX_WEEKLY_LIMIT && model !== 'gpt-6-astra' && !allowHighCodexUsage) {
    throw new Error(`Codex ${percent} % — запусти критика Claude-сабагентом другой модели (правило critic)`);
  }
  return percent;
}
