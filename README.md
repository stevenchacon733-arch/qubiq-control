# Qubiq Control

Control inteligente de asistencia, personal y automatización con QR.

## Publicar una nueva versión (auto-actualización)

Las versiones publicadas se sirven desde GitHub Releases del repositorio configurado en `build.publish` en [package.json](package.json) (`stevenchacon733-arch/qubiq-control`, privado).

```bash
npm version patch
npm run build:win
npm run release
```

Esto:

1. Sube la versión en `package.json` y crea el commit + tag `vX.Y.Z` (patch/minor/major según corresponda).
2. Compila el instalador de Windows (sin publicar todavía).
3. `npm run release` empuja el tag, crea el GitHub Release y sube el instalador, el `.blockmap` y `latest.yml`.

Requiere la variable de entorno `GH_TOKEN` con un token de GitHub (scope `repo`) con permiso de escritura sobre el repositorio.

**Importante:** usá `npm run release`, no `electron-builder --win nsis --publish always`. Ese flag nativo de electron-builder duplicó el release (dos releases idénticos) en este proyecto — `scripts/publish-release.mjs` hace lo mismo de forma confiable: si ya existe un release para ese tag lo reemplaza en vez de duplicarlo.

Los clientes con la app empaquetada (`app.isPackaged`) consultan ese feed al iniciar y se actualizan automáticamente.
