#!/usr/bin/env node
import { handlePreTool } from '../lib/hooks.mjs';
let raw = '';
try {
  for await (const chunk of process.stdin) { raw += chunk; if (raw.length > 1048576) throw new Error('oversized hook input'); }
  const output = await handlePreTool(JSON.parse(raw));
  if (output) console.log(JSON.stringify(output));
} catch {
  process.stderr.write('OpenShunt hook skipped: invalid event/configuration; run openshunt doctor.\n');
}
