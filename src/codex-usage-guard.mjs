import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const CODEX_WEEKLY_LIMIT = 85;

export function codexWeeklyPercent(file = path.join(os.homedir(), '.codex-peers', 'limits.json')) {
  try {
    const limits = JSON.parse(fs.readFileSync(file, 'utf8')).rateLimits;
    const weekly = [limits?.primary, limits?.secondary].find(window => window?.windowDurationMins === 10080);
    return Number.isFinite(weekly?.usedPercent) ? weekly.usedPercent : null;
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
