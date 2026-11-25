// Runs the API (with reload) and the Angular dev server together; Ctrl+C stops both.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const children = [];
let stopping = false;

function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill();
  process.exitCode = code;
}

function run(folder, args) {
  const child = spawn(process.execPath, args, { cwd: path.join(root, folder), stdio: 'inherit' });
  child.on('exit', (code) => stop(code ?? 0));
  children.push(child);
}

run('server', ['--watch', 'src/main.ts']);
run('client', [path.join('node_modules', '@angular', 'cli', 'bin', 'ng.js'), 'serve']);

process.on('SIGINT', () => stop());
process.on('SIGTERM', () => stop());
