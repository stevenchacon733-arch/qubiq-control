# Qubiq Control

Control inteligente de asistencia, personal y automatización con QR.

## Publicar una nueva versión (auto-actualización)

Las versiones publicadas se sirven desde GitHub Releases. Antes de publicar, completá `build.publish.owner` y `build.publish.repo` en [package.json](package.json) con el usuario/organización y el repositorio reales.

```bash
npm version patch && npm run build:win -- --publish always
```

Esto:

1. Sube la versión en `package.json` (patch/minor/major según corresponda).
2. Compila el instalador de Windows.
3. Publica los artefactos como un GitHub Release y actualiza el feed de auto-actualización.

Requiere la variable de entorno `GH_TOKEN` con un token de GitHub que tenga permiso de escritura sobre el repositorio configurado.

Los clientes con la app empaquetada (`app.isPackaged`) consultan ese feed al iniciar y se actualizan automáticamente.
