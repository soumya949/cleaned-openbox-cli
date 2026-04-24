import type { Command } from 'commander';

import { readConfig, updateConfig } from '../lib/config';

export function registerConfigCommands(program: Command): void {
  const cfg = program.command('config').description('Manage CLI configuration');

  cfg
    .command('get')
    .description('Print current configuration')
    .action(async () => {
      const current = await readConfig();
      process.stdout.write(`${JSON.stringify(current, null, 2)}\n`);
    });

  cfg
    .command('set-base-url')
    .description('Set the OpenBox base URL (alias of "config set base-url")')
    .argument('<baseUrl>', 'Base URL (e.g. https://api.openbox.ai)')
    .action(async (baseUrl: string) => {
      await updateConfig({ baseUrl });
      process.stdout.write(`Updated baseUrl to ${baseUrl}\n`);
    });

  const cfgSet = cfg.command('set').description('Set a configuration value');

  cfgSet
    .command('base-url')
    .description('Point CLI at self-hosted or staging instance')
    .argument('<baseUrl>', 'Base URL (e.g. https://api.openbox.ai)')
    .action(async (baseUrl: string) => {
      await updateConfig({ baseUrl });
      process.stdout.write(`Updated baseUrl to ${baseUrl}\n`);
    });
}
