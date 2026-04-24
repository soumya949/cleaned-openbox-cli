import type { Command } from 'commander';

import { readConfig, resolveBaseUrl } from '../lib/config';
import { OpenBoxClient } from '../lib/openboxClient';
import { printResult, type OutputFormat } from '../lib/output';

export function registerHealthCommand(program: Command): void {
  program
    .command('health')
    .description('Check API health')
    .option('--json', 'Output raw JSON')
    .action(async (opts: { json?: boolean }) => {
      const cfg = await readConfig();
      const baseUrl = resolveBaseUrl(cfg);
      const token = process.env.OPENBOX_TOKEN ?? cfg.token;

      const client = new OpenBoxClient({ baseUrl, token });
      const res = await client.request('GET', '/health');
      const format: OutputFormat = opts.json ? 'json' : 'pretty';
      printResult(res.data, { format });
    });
}
