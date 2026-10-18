#!/usr/bin/env node
// Builds the installer package that the website serves under /pkg/ (used by `curl .../pkg/get_v2.sh | bash`).
//
//   node scripts/build-pkg.mjs                    -> apps/web/public/pkg/
//   node scripts/build-pkg.mjs --out DIR --base https://my-site.vercel.app/pkg
//
// The package copies files from ../../hermes (the plugin, the bridge, the 8 skills, the installer) and writes
// SHA256SUMS next to them. get_v2.sh checks every downloaded file against SHA256SUMS before it runs anything.
// The default --base is https://$VERCEL_PROJECT_PRODUCTION_URL/pkg on Vercel; locally it stays unset and
// get_v2.sh then needs HERMES_PLATFORM_BASE.
import { createHash } from 'node:crypto';
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../../..');
const hermes = join(repo, 'hermes');

export function buildPkg({ out, base }) {
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });

  const files = [
    ['install/install_v2.sh', 'install/install_v2.sh'],
    ['install/edit_config.py', 'install/edit_config.py'],
    ['plugin/hermes-platform/__init__.py', 'plugin/hermes-platform/__init__.py'],
    ['plugin/hermes-platform/plugin.yaml', 'plugin/hermes-platform/plugin.yaml'],
    ['bridge/platform_bridge.py', 'bridge/platform_bridge.py'],
  ];
  const skillsDir = join(hermes, 'skills');
  for (const d of readdirSync(skillsDir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort()) {
    if (existsSync(join(skillsDir, d, 'SKILL.md'))) files.push([`skills/${d}/SKILL.md`, `skills/${d}/SKILL.md`]);
  }
  if (files.filter(([f]) => f.startsWith('skills/')).length !== 8) throw new Error('expected exactly 8 skills in hermes/skills');

  for (const [from, to] of files) {
    const dest = join(out, to);
    mkdirSync(dirname(dest), { recursive: true });
    cpSync(join(hermes, from), dest);
  }
  // the entry script: same file, with the download address filled in
  const get = readFileSync(join(hermes, 'install/get_v2.sh'), 'utf8');
  const entry = base ? get.replace('@@BASE@@', base.replace(/\/$/, '')) : get;
  writeFileSync(join(out, 'get_v2.sh'), entry);

  const sums = files
    .map(([, to]) => `${createHash('sha256').update(readFileSync(join(out, to))).digest('hex')}  ${to}`)
    .join('\n');
  writeFileSync(join(out, 'SHA256SUMS'), sums + '\n');
  for (const f of ['get_v2.sh', 'install/install_v2.sh']) chmodSync(join(out, f), 0o755);
  return { out, files: files.map(([, to]) => to).concat(['get_v2.sh', 'SHA256SUMS']) };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const opt = (name) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const out = resolve(opt('--out') ?? join(repo, 'apps/web/public/pkg'));
  const base = opt('--base') ?? process.env.HERMES_PLATFORM_PKG_BASE ?? (process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}/pkg` : '');
  const r = buildPkg({ out, base });
  console.log(`pkg: wrote ${r.files.length} files to ${relative(process.cwd(), r.out) || '.'}${base ? ` (download base ${base})` : ' (no download base set: use HERMES_PLATFORM_BASE)'}`);
}
