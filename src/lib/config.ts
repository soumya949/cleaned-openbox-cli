import fs from 'node:fs/promises';
import path from 'node:path';

import envPaths from 'env-paths';

export type OpenBoxConfig = {
  token?: string;
  baseUrl?: string;
};

const paths = envPaths('openbox-cli');
const configFilePath = path.join(paths.config, 'config.json');

async function ensureConfigDir(): Promise<void> {
  await fs.mkdir(paths.config, { recursive: true });
}

export async function readConfig(): Promise<OpenBoxConfig> {
  try {
    const raw = await fs.readFile(configFilePath, 'utf8');
    return JSON.parse(raw) as OpenBoxConfig;
  } catch {
    return {};
  }
}

export async function writeConfig(cfg: OpenBoxConfig): Promise<void> {
  await ensureConfigDir();
  await fs.writeFile(configFilePath, `${JSON.stringify(cfg, null, 2)}\n`, 'utf8');
}

export async function updateConfig(patch: Partial<OpenBoxConfig>): Promise<OpenBoxConfig> {
  const current = await readConfig();
  const next = { ...current, ...patch };
  await writeConfig(next);
  return next;
}

export function resolveBaseUrl(cfg: OpenBoxConfig): string {
  return (process.env.OPENBOX_BASE_URL ?? cfg.baseUrl ?? 'https://openbox-api.node.lat').replace(/\/$/, '');
}
