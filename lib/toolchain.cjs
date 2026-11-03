'use strict';
const cp = require('node:child_process');

// Explicit overrides name an executable, not a shell command. Otherwise use
// PATH, including whichever virtual environment the user has activated.
function pythonCommand(env = process.env) { return env.PYTHON || 'python3'; }
function zigCommand(env = process.env) { return env.ZIG || 'zig'; }

function probe(executable, args, hint) {
 const result = cp.spawnSync(executable, args, {encoding: 'utf8', env: process.env});
 if (result.error || result.status !== 0) {
  const reason = result.error?.message || result.stderr?.trim() || `exit status ${result.status}`;
  throw Error(`${hint}\nExecutable: ${executable}\n${reason}`);
 }
 return result.stdout.trim();
}
function checkPythonDependencies() {
 return probe(pythonCommand(), ['-c', 'import capstone, unicorn; print("Python dependencies available")'],
  'Python dependencies are missing. Activate your virtual environment and run python3 -m pip install -r requirements.txt, or set PYTHON to that environment\'s Python executable.');
}
function checkNativeTools() {
 const zig = probe(zigCommand(), ['version'], 'Install Zig on PATH or set ZIG to its executable.');
 probe('readelf', ['--version'], 'Install readelf (GNU binutils) on PATH.');
 return {zig};
}
module.exports = {pythonCommand, zigCommand, checkPythonDependencies, checkNativeTools};
