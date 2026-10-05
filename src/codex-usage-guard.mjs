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

export function assertCodexBudget({ model, allowHighCodexUsage = false, file } = {}) {
  const percent = codexWeeklyPercent(file);
  if (percent > CODEX_WEEKLY_LIMIT && model !== 'gpt-6-astra' && !allowHighCodexUsage) {
    throw new Error(`Codex ${percent} % — запусти критика Claude-сабагентом другой модели (правило critic)`);
  }
  return percent;
}
