// Guards two invariants the research browser relies on:
//  1. The webview2-com and windows versions this app compiles against are the ones
//     tauri-runtime-wry uses, so COM types from Webview::with_webview unify with our code.
//  2. Capabilities are scoped to the "main" webview only, never by window (a window-matched
//     capability applies to every child webview in it) and never to remote URLs.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const failures = [];

const packages = readFileSync(join(root, 'src-tauri', 'Cargo.lock'), 'utf8')
  .split(/\r?\n\[\[package\]\]\r?\n/)
  .map(block => ({
    name: /^name = "([^"]+)"/m.exec(block)?.[1],
    version: /^version = "([^"]+)"/m.exec(block)?.[1],
    dependencies: [...block.matchAll(/^ "([^"]+)"/gm)].map(match => match[1]),
  }))
  .filter(entry => entry.name);

// Cargo.lock names a dependency "name" when one version exists and "name version" otherwise.
function resolved(owner, dependency) {
  const reference = owner.dependencies.find(dep => dep === dependency || dep.startsWith(`${dependency} `));
  if (!reference) return null;
  const pinned = reference.split(' ')[1];
  if (pinned) return pinned;
  const versions = packages.filter(entry => entry.name === dependency).map(entry => entry.version);
  return versions.length === 1 ? versions[0] : `ambiguous(${versions.join(',')})`;
}

const runtime = packages.find(entry => entry.name === 'tauri-runtime-wry');
const app = packages.find(entry => entry.name === 'local-evidence-desk');
if (!runtime || !app) failures.push('tauri-runtime-wry or local-evidence-desk missing from Cargo.lock');
const versions = {};
for (const name of ['webview2-com', 'windows']) {
  const theirs = runtime && resolved(runtime, name);
  const ours = app && resolved(app, name);
  versions[name] = ours;
  if (!theirs) failures.push(`tauri-runtime-wry does not depend on ${name}`);
  if (!ours) failures.push(`the app does not depend on ${name} (enable the research feature dependencies)`);
  if (theirs && ours && theirs !== ours) failures.push(`${name}: tauri-runtime-wry uses ${theirs}, the app uses ${ours}`);
}

function capabilityFiles(directory) {
  return readdirSync(directory).flatMap(name => {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) return capabilityFiles(path);
    return /\.(json|json5|toml)$/.test(name) ? [path] : [];
  });
}

const check = (label, capability) => {
  if ('windows' in capability) failures.push(`${label}: capabilities must be scoped with "webviews", not "windows"`);
  const webviews = capability.webviews ?? [];
  if (webviews.some(webview => webview !== 'main')) failures.push(`${label}: only the "main" webview may hold a capability (found ${webviews.join(', ')})`);
  if (capability.remote) failures.push(`${label}: remote capabilities are not allowed`);
};

for (const path of capabilityFiles(join(root, 'src-tauri', 'capabilities'))) {
  const label = relative(root, path);
  if (!path.endsWith('.json')) {
    failures.push(`${label}: only JSON capabilities are checked; convert or extend this checker`);
    continue;
  }
  check(label, JSON.parse(readFileSync(path, 'utf8')));
}
const config = JSON.parse(readFileSync(join(root, 'src-tauri', 'tauri.conf.json'), 'utf8'));
for (const [index, capability] of (config.app?.security?.capabilities ?? []).entries()) {
  if (typeof capability === 'object') check(`tauri.conf.json capability ${index}`, capability);
}

if (failures.length) {
  console.error(failures.join('\n'));
  process.exit(1);
}
console.log(`webview2-com ${versions['webview2-com']}, windows ${versions.windows} match tauri-runtime-wry; capabilities scoped to the main webview`);
