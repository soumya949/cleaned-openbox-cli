import type { Command } from 'commander';

import { readConfig, resolveBaseUrl } from '../lib/config';
import { OpenBoxClient } from '../lib/openboxClient';

export function registerWhoamiCommand(program: Command): void {
  program
    .command('whoami')
    .description('Show the current authenticated user')
    .action(async () => {
      const cfg = await readConfig();
      const baseUrl = resolveBaseUrl(cfg);
      const token = process.env.OPENBOX_TOKEN ?? cfg.token;

      const client = new OpenBoxClient({ baseUrl, token });
      const identity = await client.getIdentity();
      process.stdout.write(`${identity}\n`);
    });
}
