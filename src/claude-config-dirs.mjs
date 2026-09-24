import fs from 'node:fs';
import path from 'node:path';
import { homeDir } from './platform.mjs';

// CCS resolves CCS_DIR directly, and the legacy CCS_HOME as <home>/.ccs.
// Discover per call: creating/switching a profile must not require an MCP restart.
export function discoverClaudeConfigDirs(env = process.env) {
  const home = env.HOME ?? env.USERPROFILE ?? homeDir();
  const directories = new Map();
  const warnings = [];
  const warn = (directory, error) => {
    if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') warnings.push({ path: directory, code: error.code ?? 'UNREADABLE' });
  };
  const add = (directory, source) => {
    try {
      const canonical = fs.realpathSync.native(path.resolve(directory));
      if (!fs.statSync(canonical).isDirectory()) return;
      const row = directories.get(canonical) ?? { path: canonical, sources: [] };
      if (!row.sources.includes(source)) row.sources.push(source);
      directories.set(canonical, row);
    } catch (error) { warn(directory, error); }
  };
  if (env.CLAUDE_CONFIG_DIR) add(env.CLAUDE_CONFIG_DIR, 'CLAUDE_CONFIG_DIR');
  add(path.join(home, '.claude'), 'default');
  if (env.CCS_HOME) add(path.join(path.resolve(env.CCS_HOME), '.claude'), 'CCS_HOME');
  const preferredCcs = env.CCS_DIR ? path.resolve(env.CCS_DIR)
    : path.join(env.CCS_HOME ? path.resolve(env.CCS_HOME) : home, '.ccs');
  const roots = [...new Set([preferredCcs, path.join(home, '.ccs')])];
  for (const root of roots) {
    const instances = path.join(root, 'instances');
    let entries;
    try { entries = fs.readdirSync(instances, { withFileTypes: true }); }
    catch (error) { warn(instances, error); continue; }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name.startsWith('.')) continue;
      if (entry.isDirectory() || entry.isSymbolicLink()) add(path.join(instances, entry.name), `CCS:${entry.name}`);
    }
  }
  return { directories: [...directories.values()], warnings };
}

export function discoverClaudeDataDirs(kind, env = process.env) {
  if (!['sessions', 'projects'].includes(kind)) throw new Error('Unsupported Claude data directory');
  const result = discoverClaudeConfigDirs(env);
  const directories = new Map();
  for (const config of result.directories) {
    const candidate = path.join(config.path, kind);
    try {
      const canonical = fs.realpathSync.native(candidate);
      if (!fs.statSync(canonical).isDirectory()) continue;
      const row = directories.get(canonical) ?? { path: canonical, configDirs: [], sources: [] };
      row.configDirs.push(config.path);
      row.sources = [...new Set([...row.sources, ...config.sources])];
      directories.set(canonical, row);
    } catch (error) {
      if (!['ENOENT', 'ENOTDIR'].includes(error.code)) result.warnings.push({ path: candidate, code: error.code ?? 'UNREADABLE' });
    }
  }
  return { directories: [...directories.values()], warnings: result.warnings };
}
