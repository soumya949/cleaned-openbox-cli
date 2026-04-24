import fs from 'node:fs/promises';
import path from 'node:path';

import envPaths from 'env-paths';

export type OpenApiSpec = {
  openapi?: string;
  info?: unknown;
  paths: Record<string, Record<string, unknown>>;
};

const paths = envPaths('openbox-cli');
const specCachePath = path.join(paths.cache, 'openapi.json');

async function ensureCacheDir(): Promise<void> {
  await fs.mkdir(paths.cache, { recursive: true });
}

export async function readCachedSpec(): Promise<OpenApiSpec | null> {
  try {
    const raw = await fs.readFile(specCachePath, 'utf8');
    return JSON.parse(raw) as OpenApiSpec;
  } catch {
    return null;
  }
}

export async function refreshSpec(baseUrl: string): Promise<OpenApiSpec> {
  const url = new URL('/api/docs-json', baseUrl);
  const resp = await fetch(url);
  if (!resp.ok) {
    throw new Error(`Failed to fetch OpenAPI spec (${resp.status})`);
  }

  const spec = (await resp.json()) as OpenApiSpec;
  await ensureCacheDir();
  await fs.writeFile(specCachePath, `${JSON.stringify(spec)}\n`, 'utf8');
  return spec;
}

export async function getSpec(baseUrl: string): Promise<OpenApiSpec> {
  const cached = await readCachedSpec();
  if (cached) {
    return cached;
  }
  return refreshSpec(baseUrl);
}
