import { createInterface } from 'node:readline/promises';

export async function prompt(question: string): Promise<string> {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    return await rl.question(question);
  } finally {
    rl.close();
  }
}
