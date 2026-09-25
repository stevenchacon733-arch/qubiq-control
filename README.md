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

### Dónde viven los instaladores y por qué este repo es público

Los releases se publican en **este mismo repo** (`stevenchacon733-arch/qubiq-control`), que es **público**.

Tiene que ser público: `electron-updater` en la máquina del cliente no tiene ningún token, así que solo puede leer
un feed público. Si el repo vuelve a privado, `releases.atom` y `releases/download/...` responden **404** y la
revisión de actualizaciones falla en silencio — ningún cliente se entera de que hay versión nueva. Así pasó con
1.0.2 y 1.0.3 mientras el repo era privado.

Por eso `build.publish` en [package.json](package.json) **no** lleva `private: true`: con esa opción el updater busca
un `GH_TOKEN` en la máquina del cliente (ver `node_modules/electron-updater/out/providerFactory.js`). Nunca metas un
token dentro de la app: se extrae del instalador.

### Nada secreto en este repo

Como el código es público, **ningún secreto puede entrar al repo**. Hoy no hay ninguno: la clave que firma las
sesiones (`app.secret`) se genera al azar en cada instalación dentro de `data/`, y las credenciales de correo,
Google y licencia se guardan cifradas en `data/` de cada cliente.

El [.gitignore](.gitignore) bloquea `data/`, `.env*`, `*.secret`, `*.enc` y las credenciales de Google. Ojo con
`build/google-oauth-client.json`: la app lo empaqueta en el instalador, así que va en `build/`, pero **está
ignorado a propósito** — nunca lo agregues con `git add -f`. Solo `build/google-oauth-client.example.json`
(con valores de ejemplo) se versiona.

### Comandos

```bash
npm version patch
npm run build:win
npm run release
```

Esto:

1. Sube la versión en `package.json` y crea el commit + tag `vX.Y.Z` (patch/minor/major según corresponda).
2. Compila el instalador de Windows (sin publicar todavía).
3. `npm run release` empuja el tag y el commit, crea el GitHub Release y sube el instalador, el `.blockmap` y
   `latest.yml`.

Requiere la variable de entorno `GH_TOKEN` con un token de GitHub (scope `repo`) con permiso de escritura sobre el
repositorio. Ese token es solo para publicar desde tu computadora; los clientes no lo necesitan.

### Verificar que el feed quedó accesible

Después de publicar, comprobá que un cliente sin token puede leerlo (debe dar `200`, no `404`):

```bash
curl -sL -o /dev/null -w "%{http_code}\n" https://github.com/stevenchacon733-arch/qubiq-control/releases/latest/download/latest.yml
```

**Importante:** usá `npm run release`, no `electron-builder --win nsis --publish always`. Ese flag nativo de electron-builder duplicó el release (dos releases idénticos) en este proyecto — `scripts/publish-release.mjs` hace lo mismo de forma confiable: si ya existe un release para ese tag lo reemplaza en vez de duplicarlo.

Los clientes con la app empaquetada (`app.isPackaged`) consultan ese feed al iniciar y se actualizan automáticamente.

Las instalaciones de 1.0.2 a 1.0.4 traen `private: true` en su `app-update.yml`. Igual se actualizan solas: sin
`GH_TOKEN` en la máquina, `electron-updater` usa el lector público, que funciona mientras este repo siga público.
