import type { Command } from 'commander';

import { readConfig, resolveBaseUrl } from '../lib/config';
import { refreshSpec } from '../lib/openapi';

export function registerSpecCommands(program: Command): void {
  const spec = program.command('spec').description('OpenAPI spec utilities');

  spec
    .command('refresh')
    .description('Fetch and cache the OpenAPI spec from the configured base URL')
    .action(async () => {
      const cfg = await readConfig();
      const baseUrl = resolveBaseUrl(cfg);
      await refreshSpec(baseUrl);
      process.stdout.write('Refreshed OpenAPI spec cache.\n');
    });
}
