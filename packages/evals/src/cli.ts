import { loadEnvFile } from 'node:process';

import { runOrderAgentEvaluations } from './runner.js';

try {
  loadEnvFile('../../.env');
} catch {
  /* environment may already be configured */
}

if (!process.env.OPENAI_API_KEY) {
  console.error('Set OPENAI_API_KEY in .env before running the live evals.');
  process.exitCode = 1;
} else {
  const model = process.env.OPENAI_MODEL || 'gpt-5.6';
  console.log(`Evaluating Order Agent with ${model}\n`);
  const results = await runOrderAgentEvaluations(model, (result) => {
    console.log(`${result.status === 'passed' ? '✓' : '✗'} ${result.name}`);
  });
  const passed = results.filter((result) => result.status === 'passed').length;
  const failed = results.length - passed;
  for (const result of results.filter((result) => result.status === 'failed')) {
    console.log(
      `\n${result.name}\n\nExpected:\n  ${result.expected}\n\nActual:\n  ${result.actual}`,
    );
  }
  console.log(`\n${passed} passed\n${failed} failed`);
  process.exitCode = failed === 0 ? 0 : 1;
}
