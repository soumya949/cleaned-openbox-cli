import type { Command } from 'commander';

import fs from 'node:fs/promises';
import path from 'node:path';

export function registerInitCommand(program: Command): void {
  program
    .command('init')
    .description('Initialize an OpenBox project in the current directory')
    .option('-f, --force', 'Overwrite if config already exists')
    .action(async (opts: { force?: boolean }) => {
      const filePath = path.join(process.cwd(), 'openbox.json');

      if (!opts.force) {
        const exists = await fs
          .stat(filePath)
          .then(() => true)
          .catch(() => false);

        if (exists) {
          throw new Error('openbox.json already exists. Use --force to overwrite.');
        }
      }

      const payload = {
        schemaVersion: 1,
        createdAt: new Date().toISOString(),
      };

      await fs.writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
      process.stdout.write('Created openbox.json\n');
    });
}
