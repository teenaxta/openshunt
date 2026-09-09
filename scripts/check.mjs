import { readFile, access } from 'node:fs/promises';
import assert from 'node:assert/strict';
const root = new URL('../plugins/openshunt/', import.meta.url);
for (const host of ['codex','claude']) {
  const manifest=JSON.parse(await readFile(new URL(`.${host}-plugin/plugin.json`,root),'utf8'));
  assert.equal(manifest.name,'openshunt'); assert.match(manifest.version,/^0\.3\.0(?:[+-].*)?$/);
}
const hooks=JSON.parse(await readFile(new URL('hooks/hooks.json',root),'utf8'));
assert.equal(hooks.hooks.PreToolUse[0].matcher,'Read|Bash|Agent|Task|spawn_agent|Write|Edit|apply_patch');
await access(new URL('hooks/pre-tool-use.mjs',root));
for (const mode of ['bulk-reader', 'code-writer']) {
  await access(new URL(`agents/${mode}.md`, root));
  await access(new URL(`native/codex/openshunt_${mode.replaceAll('-', '_')}.toml`, root));
}
for(const name of ['bulk-reader','code-writer','setup','savings']) {
  const text=await readFile(new URL(`skills/${name}/SKILL.md`,root),'utf8');
  assert.ok(text.startsWith('---\n')); assert.ok(text.includes(`name: ${name}`));
}
for(const file of ['../.agents/plugins/marketplace.json','../.claude-plugin/marketplace.json']) {
  const manifest=JSON.parse(await readFile(new URL(file,import.meta.url),'utf8')); assert.equal(manifest.plugins[0].name,'openshunt');
}
console.log('Plugin manifests, hook registration, skills and marketplaces validated.');
