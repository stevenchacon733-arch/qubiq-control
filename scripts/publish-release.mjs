import { createReadStream, readFileSync, existsSync, statSync } from 'node:fs';
import { request } from 'node:https';
import { resolve } from 'node:path';
import { execSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

// Publica el release de GitHub que lee electron-updater.
//
// Es atómico para los clientes: el release se arma como BORRADOR (invisible para el feed), se suben y verifican
// los tres archivos, y recién ahí se publica. Si la conexión se corta a mitad de camino (pasó con 1.0.3 y 1.0.5),
// el feed sigue sirviendo la versión anterior en vez de un release vacío que da 404.
//
// Se puede correr de nuevo sin miedo: retoma el release del mismo tag, sube solo lo que falte o esté incompleto,
// y reintenta cada subida si hay errores de red.

const root = resolve(new URL('..', import.meta.url).pathname.replace(/^\/(.:)/, '$1'));
const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
const { owner, repo } = pkg.build.publish;
const version = pkg.version;
const tag = `v${version}`;
const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
const ATTEMPTS = 6;
// Sin datos por este tiempo se da la subida por muerta. Mientras el archivo sube el socket no está inactivo;
// esto cubre la espera a que GitHub procese un instalador grande, que con conexiones lentas pasa de 5 minutos.
const UPLOAD_IDLE_TIMEOUT_MS = 15 * 60 * 1000;

if (!token) {
  console.error('Falta la variable de entorno GH_TOKEN (o GITHUB_TOKEN) con permiso "repo".');
  process.exit(1);
}

const releaseDir = resolve(root, 'release');
// latest.yml va último: el feed nunca anuncia un instalador que todavía no terminó de subir.
const assets = [
  { path: resolve(releaseDir, 'Qubiq Control Setup.exe'), name: 'Qubiq-Control-Setup.exe', contentType: 'application/octet-stream' },
  { path: resolve(releaseDir, 'Qubiq Control Setup.exe.blockmap'), name: 'Qubiq-Control-Setup.exe.blockmap', contentType: 'application/octet-stream' },
  { path: resolve(releaseDir, 'latest.yml'), name: 'latest.yml', contentType: 'application/x-yaml' }
];

for (const asset of assets) {
  if (!existsSync(asset.path)) {
    console.error(`Falta ${asset.path}. Corré "npm run build:win" primero (sin --publish).`);
    process.exit(1);
  }
  asset.size = statSync(asset.path).size;
}

const builtVersion = /^version:\s*(\S+)/m.exec(readFileSync(resolve(releaseDir, 'latest.yml'), 'utf8'))?.[1];
if (builtVersion !== version) {
  console.error(`release/latest.yml es de la versión ${builtVersion}, pero package.json dice ${version}. Corré "npm run build:win" de nuevo.`);
  process.exit(1);
}

class GitHubError extends Error {
  constructor(status, path, body) {
    super(`GitHub API ${status} en ${path}: ${body}`);
    this.status = status;
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
  if (!response.ok) throw new GitHubError(response.status, path.split('?')[0], await response.text());
  return response.status === 204 ? null : response.json();
}

// Errores de red (ECONNRESET, timeouts) y fallas del lado de GitHub valen la pena reintentarlos; un 401 o 404 no.
const retryable = (error) => !(error instanceof GitHubError) || error.status >= 500 || error.status === 429;

async function withRetry(label, fn) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await fn(attempt);
    } catch (error) {
      if (attempt >= ATTEMPTS || !retryable(error)) throw error;
      const wait = 3000 * 2 ** (attempt - 1);
      const reason = error.cause?.code || error.code || error.message;
      console.log(`  ${label}: falló (${reason}). Reintento ${attempt}/${ATTEMPTS - 1} en ${wait / 1000} s...`);
      await sleep(wait);
    }
  }
}

function ensureTagPushed() {
  const tags = execSync('git tag --list', { cwd: root, encoding: 'utf8' }).split('\n').map(t => t.trim());
  if (!tags.includes(tag)) throw new Error(`No existe el tag local ${tag}. Corré "npm version patch" (o minor/major) primero.`);
  execSync(`git push origin ${tag}`, { cwd: root, stdio: 'inherit' });
  execSync('git push origin HEAD', { cwd: root, stdio: 'inherit' });
}

// El endpoint /releases/tags/{tag} no devuelve borradores, así que se busca en la lista.
async function findRelease() {
  const releases = await withRetry('buscar release', () => api(`/repos/${owner}/${repo}/releases?per_page=100`));
  return releases.find(release => release.tag_name === tag) || null;
}

const getRelease = (id) => withRetry('leer release', () => api(`/repos/${owner}/${repo}/releases/${id}`));

const updateRelease = (id, changes) => withRetry('actualizar release', () => api(`/repos/${owner}/${repo}/releases/${id}`, {
  method: 'PATCH',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(changes)
}));

async function prepareDraft() {
  const existing = await findRelease();
  if (!existing) {
    const created = await withRetry('crear release', () => api(`/repos/${owner}/${repo}/releases`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tag_name: tag, name: version, draft: true, prerelease: false })
    }));
    console.log(`Borrador creado (id ${created.id}).`);
    return created;
  }
  if (existing.draft) {
    console.log(`Retomo el borrador existente de ${tag} (id ${existing.id}).`);
    return existing;
  }
  // Un release ya publicado pero incompleto rompe el feed: se vuelve borrador mientras se completa,
  // así los clientes vuelven a ver la versión anterior.
  console.log(`El release ${tag} ya estaba publicado (id ${existing.id}); lo paso a borrador mientras lo completo.`);
  return updateRelease(existing.id, { draft: true });
}

async function removeAsset(asset) {
  await withRetry(`borrar ${asset.name} incompleto`, () => api(`/repos/${owner}/${repo}/releases/assets/${asset.id}`, { method: 'DELETE' }));
}

// fetch (undici) corta a los 300 s sin respuesta, y con subida lenta un instalador de 113 MB tarda más:
// GitHub terminaba de recibirlo pero el script creía que había fallado. node:https sube en streaming y sin ese límite.
function uploadFile(url, asset) {
  return new Promise((resolveUpload, reject) => {
    const req = request(url, {
      method: 'POST',
      timeout: UPLOAD_IDLE_TIMEOUT_MS,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'qubiq-release',
        'Content-Type': asset.contentType,
        'Content-Length': asset.size
      }
    }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        if (res.statusCode >= 400) reject(new GitHubError(res.statusCode, url.split('?')[0], body));
        else resolveUpload(body ? JSON.parse(body) : null);
      });
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(Object.assign(new Error('GitHub no respondió'), { code: 'UPLOAD_TIMEOUT' })));
    req.on('error', reject);
    createReadStream(asset.path).on('error', reject).pipe(req);
  });
}

const findAsset = async (release, name) => (await getRelease(release.id)).assets.find(item => item.name === name) || null;
const isComplete = (remote, asset) => remote?.state === 'uploaded' && remote.size === asset.size;

async function uploadAsset(release, asset) {
  const current = await findAsset(release, asset.name);
  if (isComplete(current, asset)) {
    console.log(`  ya estaba: ${asset.name}`);
    return;
  }
  if (current) await removeAsset(current);

  const uploadUrl = release.upload_url.replace(/\{.*\}/, '') + `?name=${encodeURIComponent(asset.name)}`;
  let confirmedLate = false;
  await withRetry(`subir ${asset.name}`, async (attempt) => {
    if (attempt > 1) {
      // Si el intento anterior se cortó esperando la respuesta, puede que GitHub sí lo haya recibido entero.
      const previous = await findAsset(release, asset.name);
      if (isComplete(previous, asset)) { confirmedLate = true; return; }
      // Si quedó a medias, GitHub no deja subir otro con el mismo nombre: hay que sacarlo primero.
      if (previous) await removeAsset(previous);
    }
    try {
      await uploadFile(uploadUrl, asset);
    } catch (error) {
      if (!(error instanceof GitHubError) || error.status !== 422) throw error;
      const existing = await findAsset(release, asset.name);
      if (isComplete(existing, asset)) { confirmedLate = true; return; }
      if (existing) await removeAsset(existing);
      throw new Error('había un archivo incompleto con ese nombre; lo borré para reintentar');
    }
  });
  const size = `${(asset.size / 1048576).toFixed(1)} MB`;
  console.log(confirmedLate ? `  subido: ${asset.name} (${size}, confirmado después del corte)` : `  subido: ${asset.name} (${size})`);
}

async function verifyAssets(release) {
  const fresh = await getRelease(release.id);
  for (const asset of assets) {
    const remote = fresh.assets.find(item => item.name === asset.name);
    if (remote?.state !== 'uploaded' || remote.size !== asset.size) {
      throw new Error(`${asset.name} no quedó completo en GitHub (${remote ? `${remote.size} de ${asset.size} bytes, ${remote.state}` : 'no está'}). Corré "npm run release" de nuevo: retoma donde quedó.`);
    }
  }
}

console.log(`Publicando ${repo}@${version} (tag ${tag})...`);
ensureTagPushed();
const release = await prepareDraft();
console.log('Subiendo archivos...');
for (const asset of assets) await uploadAsset(release, asset);
await verifyAssets(release);
await updateRelease(release.id, { draft: false, make_latest: 'true' });
console.log(`Listo, publicado: https://github.com/${owner}/${repo}/releases/tag/${tag}`);
