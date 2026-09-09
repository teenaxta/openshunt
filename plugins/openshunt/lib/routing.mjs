import { open } from 'node:fs/promises';
import path from 'node:path';

// Deliberately a small shell recognizer, not an interpreter. Ambiguity passes through.
export function shellFiles(command) {
  if (typeof command !== 'string') return [];
  const words = []; let word = ''; let quote = null; let active = false;
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (quote) {
      if (c === quote) { quote = null; continue; }
      if (quote === '"' && (c === '$' || c === '`')) return [];
      if (c === '\\' && quote === '"') {
        const next = command[++i]; if (next === undefined) return [];
        if ('\\"$`'.includes(next)) word += next; else word += '\\' + next;
      } else word += c;
      continue;
    }
    if (c === "'" || c === '"') { quote = c; active = true; continue; }
    if (c === '\\') { if (++i >= command.length) return []; word += command[i]; active = true; continue; }
    if ('|><;&()`$*?[]{}~#\n\r'.includes(c)) return [];
    if (/\s/.test(c)) { if (active) words.push(word); word = ''; active = false; }
    else { word += c; active = true; }
  }
  if (quote) return [];
  if (active) words.push(word);
  const cmd = path.basename(words.shift() || '');
  if (!['cat', 'head', 'tail', 'less', 'more'].includes(cmd)) return [];
  // All option-bearing commands pass through, as in the reference's targeted-read exception.
  if (words.some(w => w.startsWith('-') || w.startsWith('+'))) return [];
  return words;
}
export async function largeTextFile(file, threshold) {
  let handle;
  try {
    handle = await open(file, 'r');
    if (!(await handle.stat()).isFile()) return false;
    let lines = 0; let bytes = 0; let last = 10;
    for await (const chunk of handle.createReadStream()) {
      if (chunk.includes(0)) return false;
      bytes += chunk.length; last = chunk[chunk.length - 1];
      for (const byte of chunk) if (byte === 10) lines++;
      if (lines > threshold) return true;
    }
    return lines + (bytes && last !== 10 ? 1 : 0) > threshold;
  } catch { return false; } finally { await handle?.close().catch(() => {}); }
}
export async function route(event, config) {
  if (!config.enabled) return null;
  const input = event?.tool_input || {};
  let files = [];
  if (event.tool_name === 'Read') {
    if (input.offset != null || input.limit != null) return null;
    if (typeof input.file_path === 'string') files = [input.file_path];
  } else if (['Bash', 'exec_command', 'shell_command', 'shell'].includes(event.tool_name)) {
    files = shellFiles(input.command ?? input.cmd);
  }
  const cwd = input.workdir || input.cwd || event.cwd || process.cwd();
  for (const file of files) {
    if (await largeTextFile(path.resolve(cwd, file), config.minLines)) {
      return `OpenShunt: this full-file read exceeds ${config.minLines} lines. Use the openshunt bulk-reader skill with a specific question and these paths. For editing/debugging, read a targeted section instead. Explicit bypass: OPENSHUNT_ENABLED=0. Worker failures do not disable this guard.`;
    }
  }
  return null;
}
