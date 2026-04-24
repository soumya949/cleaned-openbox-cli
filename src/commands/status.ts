import type { Command } from 'commander';

import { readConfig, resolveBaseUrl } from '../lib/config';

export function registerStatusCommand(program: Command): void {
  program
    .command('status')
    .description('Show current CLI status')
    .action(async () => {
      const cfg = await readConfig();
      const baseUrl = resolveBaseUrl(cfg);
      const token = process.env.OPENBOX_TOKEN ?? cfg.token;

      process.stdout.write(`Base URL: ${baseUrl}\n`);
      process.stdout.write(`Logged in: ${token ? 'yes' : 'no'}\n`);
    });
}
