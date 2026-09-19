import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { execSync } from 'node:child_process';

const root = resolve(new URL('..', import.meta.url).pathname.replace(/^\/(.:)/, '$1'));
const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
const { owner, repo } = pkg.build.publish;
const version = pkg.version;
const tag = `v${version}`;
const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;

if (!token) {
  console.error('Falta la variable de entorno GH_TOKEN (o GITHUB_TOKEN) con permiso "repo".');
  process.exitCode = 1;
  process.exit();
}

const releaseDir = resolve(root, 'release');
const assets = [
  { path: resolve(releaseDir, 'Qubiq Control Setup.exe'), name: 'Qubiq-Control-Setup.exe', contentType: 'application/octet-stream' },
  { path: resolve(releaseDir, 'Qubiq Control Setup.exe.blockmap'), name: 'Qubiq-Control-Setup.exe.blockmap', contentType: 'application/octet-stream' },
  { path: resolve(releaseDir, 'latest.yml'), name: 'latest.yml', contentType: 'application/x-yaml' }
];

for (const asset of assets) {
  if (!existsSync(asset.path)) {
    console.error(`Falta ${asset.path}. Corré "npm run build:win" primero (sin --publish).`);
    process.exitCode = 1;
    process.exit();
  }
}

async function api(path, options = {}) {
  const url = path.startsWith('http') ? path : `https://api.github.com${path}`;
  const response = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      ...(options.headers || {})
    }
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`GitHub API ${response.status} en ${path}: ${body}`);
  }
  return response.status === 204 ? null : response.json();
}

async function ensureTagPushed() {
  const tags = execSync('git tag --list', { cwd: root, encoding: 'utf8' }).split('\n').map(t => t.trim());
  if (!tags.includes(tag)) throw new Error(`No existe el tag local ${tag}. Corré "npm version patch" (o minor/major) primero.`);
  execSync(`git push origin ${tag}`, { cwd: root, stdio: 'inherit' });
  execSync('git push origin HEAD', { cwd: root, stdio: 'inherit' });
}

async function findExistingRelease() {
  try { return await api(`/repos/${owner}/${repo}/releases/tags/${tag}`); }
  catch { return null; }
}

async function deleteRelease(id) {
  await api(`/repos/${owner}/${repo}/releases/${id}`, { method: 'DELETE' });
}

async function createRelease() {
  return api(`/repos/${owner}/${repo}/releases`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tag_name: tag, name: version, draft: false, prerelease: false })
  });
}

async function uploadAsset(uploadUrlTemplate, asset) {
  const uploadUrl = uploadUrlTemplate.replace(/\{.*\}/, '') + `?name=${encodeURIComponent(asset.name)}`;
  const data = readFileSync(asset.path);
  await api(uploadUrl, {
    method: 'POST',
    headers: { 'Content-Type': asset.contentType, 'Content-Length': String(data.length) },
    body: data
  });
  console.log(`  subido: ${asset.name}`);
}

console.log(`Publicando ${repo}@${version} (tag ${tag})...`);
await ensureTagPushed();

const existing = await findExistingRelease();
if (existing) {
  console.log(`Ya existía un release para ${tag}, lo reemplazo...`);
  await deleteRelease(existing.id);
}

const release = await createRelease();
console.log(`Release creado (id ${release.id}). Subiendo archivos...`);
for (const asset of assets) await uploadAsset(release.upload_url, asset);

console.log(`Listo: https://github.com/${owner}/${repo}/releases/tag/${tag}`);
