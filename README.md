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
