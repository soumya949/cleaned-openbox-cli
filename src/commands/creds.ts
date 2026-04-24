import type { Command } from 'commander';

import { prompt } from '../lib/prompt';
import { readConfig, updateConfig, writeConfig } from '../lib/config';

export function registerCredsCommands(program: Command): void {
  const creds = program.command('creds').description('Manage stored credentials (bearer token)');

  creds
    .command('set-token')
    .description('Store a bearer token locally (uses env OPENBOX_TOKEN if set)')
    .option('-t, --token <token>', 'Bearer token')
    .action(async (opts: { token?: string }) => {
      const token = opts.token?.trim() ?? (await prompt('Bearer token: ')).trim();
      if (!token) {
        throw new Error('Token is required.');
      }

      await updateConfig({ token });
      process.stdout.write('Saved token.\n');
    });

  creds
    .command('clear')
    .description('Remove locally stored token')
    .action(async () => {
      const cfg = await readConfig();
      const { token: _t, ...rest } = cfg;
      await writeConfig(rest);
      process.stdout.write('Cleared credentials.\n');
    });
}
