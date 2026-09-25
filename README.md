# Qubiq Control

Control inteligente de asistencia, personal y automatización con QR.

## Planilla en Excel

En **Pre-planilla → Descargar Excel** la app genera un libro `.xlsx` (sin depender de Excel ni de Google) con:

- Una hoja **Tarifas**: una fila por empleado activo (cédula, código, nombre, puesto) con el
  **salario por hora** y la **jornada ordinaria**. El salario por hora viene del campo *Salario por hora*
  de la ficha del empleado, así que el libro sale ya lleno; las celdas amarillas se pueden ajustar a mano
  para esa quincena sin tocar la ficha. Ahí mismo está el porcentaje de **deducción de ley (CCSS)**.
- Una hoja por empleado con el formato del comprobante de pago: encabezado del negocio,
  `COMPROBANTE DE PAGO-CONTROL DE HORAS LABORADAS`, datos del trabajador, tabla
  `FECHA / Hora Entrada / Hora Salida / Horas Laboradas / Horas Ordinarias / Horas Extras / Horas Dobles`,
  `TOTAL POR QUINCENA`, `Total`, `Total Devengado`, deducción, `Monto a Pagar` y la línea de firma.

Cada comprobante toma su tarifa de la hoja Tarifas con `VLOOKUP` **por cédula**, así que al escribir el salario
por hora se recalculan solos los totales, las horas extra y el monto a pagar.

Las entradas y salidas se escriben como hora redondeada (igual que la sincronización con Google Sheets) y las horas
laboradas se calculan con fórmula, incluso en turnos que cruzan la medianoche. Los días marcados como descanso
salen como `DESCANSO` y los días sin marcar quedan en blanco para que se noten.

El generador vive en [src/services/payrollWorkbook.js](src/services/payrollWorkbook.js) sobre un escritor
`.xlsx` propio ([src/services/xlsxWriter.js](src/services/xlsxWriter.js)), sin dependencias nuevas.

## Nombres de mes en Google Drive

Los meses se escriben **Setiembre** (uso de Costa Rica), pero las plantillas viejas quedaron guardadas como
*Septiembre*. La búsqueda de archivos y carpetas en Drive pasa por `normalizeName()` de
[src/services/textMatch.js](src/services/textMatch.js), que trata las dos formas como el mismo nombre; así la
sincronización encuentra la plantilla sin importar cómo esté escrita y no crea carpetas duplicadas.

## Publicar una nueva versión (auto-actualización)

### Dónde viven los instaladores y por qué

Hay **dos repositorios**:

| Repositorio | Visibilidad | Qué contiene |
| --- | --- | --- |
| `stevenchacon733-arch/qubiq-control` | privado | el código fuente (este repo) |
| `stevenchacon733-arch/qubiq-control-releases` | **público** | solo los instaladores publicados |

El código queda privado y los instaladores públicos. Esto **no es opcional**: `electron-updater` en la máquina del
cliente no tiene ningún token, así que solo puede leer un feed público. Si los releases viven en un repo privado,
`releases.atom` y `releases/download/...` responden **404** y la revisión de actualizaciones falla en silencio —
el cliente nunca se entera de que hay versión nueva.

Por eso `build.publish` en [package.json](package.json) apunta al repo **público** y **no** lleva `private: true`.
Con `private: true` el updater buscaría un `GH_TOKEN` en la máquina del cliente (ver
`node_modules/electron-updater/out/providerFactory.js`), no lo encontraría y caería al lector público contra un repo
privado. Nunca metas un token dentro de la app: se extrae del instalador.

Los instaladores son públicos, pero para instalar hace falta una licencia válida, así que descargarlos no sirve de nada
sin clave.

### Comandos

```bash
npm version patch
npm run build:win
npm run release
```

Esto:

1. Sube la versión en `package.json` y crea el commit + tag `vX.Y.Z` (patch/minor/major según corresponda).
2. Compila el instalador de Windows (sin publicar todavía).
3. `npm run release` empuja el tag y el commit a **este** repo (el privado), y crea el GitHub Release con el
   instalador, el `.blockmap` y `latest.yml` en el repo **público** de releases.

Requiere la variable de entorno `GH_TOKEN` con un token de GitHub (scope `repo`) con permiso de escritura sobre
**ambos** repositorios.

### Verificar que el feed quedó accesible

Después de publicar, comprobá que un cliente sin token puede leerlo (debe dar `200`, no `404`):

```bash
curl -sL -o /dev/null -w "%{http_code}\n" https://github.com/stevenchacon733-arch/qubiq-control-releases/releases/latest/download/latest.yml
```

**Importante:** usá `npm run release`, no `electron-builder --win nsis --publish always`. Ese flag nativo de electron-builder duplicó el release (dos releases idénticos) en este proyecto — `scripts/publish-release.mjs` hace lo mismo de forma confiable: si ya existe un release para ese tag lo reemplaza en vez de duplicarlo.

Los clientes con la app empaquetada (`app.isPackaged`) consultan ese feed al iniciar y se actualizan automáticamente.

**Clientes instalados antes de 1.0.5:** su `app-update.yml` apunta al repo privado, que les da 404. Hay que
actualizarlos **a mano una última vez** con el instalador de 1.0.5 o posterior; a partir de ahí el auto-update
funciona solo.
