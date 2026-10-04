# Qubiq Control multisucursal

Plan para que un empleado marque con su huella en cualquier sucursal y todas las marcaciones lleguen a un solo
Qubiq Control. Se construye por fases sobre lo que ya funciona; este documento se actualiza al cerrar cada fase.

## Estado

| Fase | Qué | Estado |
| --- | --- | --- |
| 1 | Sucursales (`branches`) | **Hecha** |
| 2 | Lectores asociados a una sucursal | **Hecha** |
| 3 | `branch_id`, `device_id` y `event_uuid` en las marcaciones | **Hecha** |
| 4 | La central recibe marcaciones de otras sucursales | **Hecha** |
| 5 | El lector de una sucursal envía sus marcaciones a la central | **Hecha** |
| 6 | Modo sucursal y cola sin internet | **Hecha** |
| 7 a 9 | Piloto: dos sucursales y un empleado marcando en ambas | Pendiente: falta elegir cómo se publica la central y probar con los equipos reales |
| 10 | Resto de sucursales | Pendiente |

## Cómo está construido hoy

- **Una sola computadora lo es todo.** Qubiq Control es una app de escritorio (Electron) que adentro levanta un
  servidor Express en el puerto 3220 y guarda todo en un archivo SQLite dentro de `%APPDATA%\Qubiq Control\data`.
  No existe un servidor central ni una base compartida: es la pieza más grande que falta.
- **El panel solo abre desde esa misma computadora** (`LAN_SURFACE` e `isLocalRequest` en `src/server.js`). Hay una
  contraseña de Administrador y otra de Recepción; no hay usuarios ni roles por persona.
- **Marcaciones.** Las tres formas de marcar (QR, computadora, huella) terminan en `registerAttendance`
  (`src/services/attendance.js`), que guarda en la tabla `attendance` como mucho una `ENTRY` y una `EXIT` por
  empleado y por día (`UNIQUE(employee_id, work_date, event_type)`), calculando la tardanza en ese momento.
- **Empleados.** Se identifican por `employees.id` y `employee_code`. El ID que usa cada lector se vincula en
  `employee_biometric_map`, que hoy es **por lector**.
- **Lector ZKTeco.** `src/services/biometric/`: cliente propio del protocolo TCP 4370, un agente dentro del mismo
  proceso que lo consulta cada 30 s, y `biometric_events`, que guarda cada marcación cruda una sola vez.
- **Licencia y actualizaciones.** Licencia por computadora contra un servidor externo; actualización automática
  desde GitHub Releases.

## Qué se reutiliza

- `biometric_devices` ya es la tabla de dispositivos: se le agrega sucursal y número de serie, no se crea otra.
- `biometric_events` ya es la bitácora idempotente de marcaciones crudas: ahí van `event_uuid`, sucursal y origen.
- El cliente ZKTeco y el agente de sondeo pasan a ser el corazón del Qubiq Agent, sin reescribirlos.
- El mismo backend puede correr sin ventana (`npm run server`), que es la base para el servidor central.

## Cambios de base de datos previstos

Todos son agregados; nada se borra ni se renombra.

- **Fase 1 (hecha):** `branches(id, name, code, active, created_at, updated_at)`. La sucursal que ya estaba escrita
  en "Identidad del negocio" se convierte sola en la primera.
- **Fase 2 (hecha):** `biometric_devices` + `branch_id`, `serial_number`. Ver "Lectores y sucursales" más abajo.
- **Fase 3 (hecha):** `biometric_events` + `event_uuid` único, `branch_id`, `source`. `attendance` + `branch_id`,
  `device_id` (cada fila es una entrada o una salida, así que entrada y salida pueden ser de sucursales
  distintas). Lo que ya existía queda solo en la primera sucursal. Ver "Marcaciones" más abajo.
- **Fases 4 a 6 (hechas):** `branch_agents` (una fila por computadora de sucursal autorizada; de la clave solo se
  guarda el hash), `biometric_devices.agent_id` (lector que está en otra sucursal) y, en cada sucursal,
  `pending_events` con estados `pending / syncing / synced / error`.

`event_uuid` se calcula a partir del serial del lector, el ID del usuario y la hora de la marcación, no al azar
(`eventUuid` en `src/services/biometric/index.js`): así, si un agente se reinstala y vuelve a leer el lector,
genera los mismos UUID y el central no duplica.

## Lectores y sucursales (fase 2)

- **Cada lector pertenece a una sucursal.** Se elige al agregarlo o en *Configurar*. Los lectores que ya existían
  quedan solos en la primera sucursal. Una sucursal con lectores activos no se puede desactivar.
- **Un lector se reconoce por su número de serie, no por la IP.** El serial lo entrega el propio aparato y se
  guarda la primera vez que responde. Desde ahí, en cada conexión se compara:
  - si en esa IP contesta **otro** aparato, no se le leen marcaciones (sus IDs podrían ser de otras personas) y el
    lector queda en error hasta que el administrador marque *Se cambió el aparato* en Configurar;
  - el **mismo** aparato no se puede registrar dos veces aunque se le ponga otra IP o puerto.
- **El ID biométrico es de la persona, no del lector.** Un empleado usa el mismo ID en todos los lectores y un ID
  nunca es de dos personas; el sistema lo exige al vincular. Al asignar huella en un segundo lector se propone
  solo el ID que la persona ya tiene. Esta regla es la que permite que el central reconozca a la misma persona
  marque donde marque.
- **Nombre sugerido** para un lector nuevo: `ZK-<código de sucursal>-<número>`, por ejemplo `ZK-AGZ-01`.

Con esto, dos lectores conectados a la **misma** computadora ya funcionan como dos sucursales. Lo que falta para
lectores en locales distintos es que cada local le mande sus marcaciones al central (fases 4 a 6).

## Marcaciones (fase 3)

- **Cada marcación guarda su sucursal y su lector.** Las de huella, los del lector que las tomó; las del QR y la
  computadora del negocio, la sucursal de la instalación (la primera). Entrada y salida de un mismo día pueden
  ser de sucursales distintas.
- **Dónde se ve.** Con más de una sucursal activa, "Hoy" y Pre-planilla muestran el código de sucursal junto a
  cada hora y "Hoy" permite filtrar por sucursal (muestra a quienes marcaron entrada o salida ahí). El CSV agrega
  *Sucursal entrada* y *Sucursal salida*. Con una sola sucursal la pantalla queda igual que antes.
- **Marcaciones que llegan tarde.** Si una sucursal estuvo sin conexión y sus marcas llegan después de otras que
  ya se registraron, la jornada de esa persona se reordena sola (`registerLate`): se vuelven a pasar por el motor
  todas sus marcas posteriores en orden de hora, y queda igual que si todo hubiera llegado a tiempo. Ejemplo: la
  salida llega primero y se ve como una entrada; al llegar la entrada verdadera, pasa a ser la salida.
  - Si la marca atrasada no se puede registrar (por ejemplo, es un doble toque), todo queda exactamente como estaba.
  - Una jornada que el administrador ya corrigió a mano no se reordena.
  - Con más de 7 días de atraso no se reordena sola: puede caer en una planilla ya cerrada.
  - Cada reordenamiento queda en la bitácora (`REORDER`).
- **Regla del motor que conviene conocer.** Por día se toma la primera marca como entrada y la segunda como salida;
  una tercera se rechaza. Si alguien marca al llegar a una segunda sucursal a medio día, esa marca es su salida.

## Central y sucursales (fases 4 a 6)

Es el mismo programa en todas las computadoras. Cada instalación cumple uno de tres papeles, que se elige en
*Configuración → Conexión entre sucursales*:

- **Sola:** como siempre. No abre ningún puerto nuevo.
- **Central:** tiene los empleados, los horarios y la planilla, y recibe las marcaciones de las demás.
- **Sucursal:** solo maneja su lector. No registra asistencia por su cuenta: le pasa cada marcación a la central.

Una computadora es central o es sucursal, nunca las dos.

### La central

- **Una clave por computadora de sucursal** (`src/services/central.js`). Se crea eligiendo la sucursal; se muestra
  **una sola vez** y en la base queda solo su hash (SHA-256), así que no se puede recuperar: si se pierde, se genera
  otra con *Clave nueva* y la anterior deja de servir en el acto. Ese es también el camino cuando se cambia la
  computadora de una sucursal: misma fila, clave nueva, y sus lectores siguen siendo suyos.
- **Puerto de recepción aparte** (`src/agentApi.js`, puerto 3221). Solo se abre mientras hay alguna sucursal
  conectada activa. Por ahí no se sirve el panel ni ningún archivo, y todo pedido tiene que traer una clave válida.
  **Es el único puerto que se publica hacia afuera; el 3220 del panel nunca.**
- **`POST /api/attendance/events`** recibe hasta 500 marcaciones de un lector. Antes de registrar valida:
  - la clave, que la sucursal esté activa y que su sucursal no esté desactivada;
  - el lector, por número de serie: tiene que ser de esa sucursal y estar activo en la central;
  - cada marcación: fecha y hora reales, ID de usuario, y que el `event_uuid` sea exactamente el que corresponde
    a ese lector, esa persona y esa hora (se vuelve a calcular; no se confía en el que llega);
  - la licencia de la central, igual que para el QR y el lector local.
- **Respuesta por marcación:** `registered` (se guardó ahora), `already_registered` (ya estaba: no se duplica) o
  `rejected` (dato inválido). Junto va qué pasó con ella: entrada, salida, sin empleado vinculado, ignorada.
- **Mismo motor.** Una marcación remota entra por `ingestRemoteEvents`, que usa el mismo `decide` que el lector
  local: mismas reglas, mismo reordenamiento si llega tarde.

### Lectores de otras sucursales

- La central los **registra sola** la primera vez que la sucursal los reporta, en la sucursal de esa clave. Se ven
  en *Lector de Huella* con la etiqueta *otra sucursal*. Desde la central solo se les cambia el nombre, el tiempo
  de doble toque, o se los desactiva; probar la conexión y registrar huellas se hace allá.
- Un lector queda atado a la computadora que lo reportó. Otra sucursal no puede enviar marcaciones en su nombre.
  Para **mudar un lector** de sucursal (o conectarlo directo a la central), se lo desactiva en la central: recién
  ahí suelta su número de serie y el nuevo dueño lo registra solo.
- Cada sucursal puede registrar hasta 10 lectores.
- Acepta marcaciones desde que la sucursal activó el lector, pero nunca anteriores al día en que se creó la clave.
- El estado (conectado o no) es el que informa la sucursal en su latido, una vez por minuto. Si la computadora de
  la sucursal deja de reportarse 3 minutos, sus lectores figuran desconectados.

### La sucursal

- Se conecta con dos datos que se piden en la central: **dirección** y **clave**. La clave se guarda cifrada
  (`integrations.enc`), igual que la contraseña del correo. La dirección tiene que ser `https://`; solo se acepta
  `http://` hacia una dirección de red local o privada.
- **No necesita licencia propia para enviar:** la que cuenta es la de la central, que es la que registra.
- **Cola en disco** (`pending_events`, `src/services/branchLink.js`). Cada marcación del lector se guarda ahí
  primero y sale después:
  - `pending` → `syncing` (se está enviando) → `synced` (la central la confirmó) o `error` (la central la rechazó
    por inválida; se puede reintentar a mano);
  - **nada pasa a `synced` sin la respuesta de la central** para esa marcación en particular;
  - si se corta la luz a mitad de un envío, al arrancar lo que estaba en `syncing` vuelve a `pending`;
  - sin conexión, reintenta sola con espera creciente (de 5 segundos a 5 minutos) y apenas la central contesta un
    latido vuelve a enviar;
  - si la central rechaza a **un** lector (desactivado allá, registrado en otra sucursal), ese espera y los demás
    lectores de la sucursal siguen saliendo.
- **Arranque con Windows:** ya venía (la app se abre sola en segundo plano al iniciar sesión), así que el lector y
  la cola siguen trabajando sin que nadie abra nada.
- **Empleados y huellas:** la sucursal no tiene empleados propios. La lista (nombre, código e ID biométrico; nunca
  PIN ni cédula) se consulta a la central, y al registrar una huella el vínculo se guarda en la central. Se usa el
  mismo ID que la persona ya tiene.
- **QR y marcación en computadora quedan apagados** en una sucursal conectada: esas marcas quedarían solo ahí y
  nunca llegarían a la planilla.
- En la pantalla se ve el estado: un aviso arriba (conectada, o sin comunicación y cuántas hay guardadas), y en
  *Lector de Huella* cada marcación como *En cola*, *Enviada* o *Rechazada*.

### Cómo se publica la central (se define en el piloto)

La central es una computadora del negocio, así que necesita una dirección a la que las otras sucursales puedan
llegar por internet. Las dos formas previstas:

- **Túnel con dirección pública** (por ejemplo Cloudflare Tunnel) apuntando **solo** al puerto 3221. Da `https://`.
- **Red privada entre las computadoras** (por ejemplo Tailscale): cada sucursal ve a la central como una dirección
  privada y el tráfico ya viaja cifrado.

En cualquiera de las dos, lo que se expone es únicamente el puerto de recepción. Si un túnel se apunta por error
al 3220, el panel igual no responde: se niega a todo pedido que traiga cabeceras de proxy o que venga dirigido a
un nombre que no sea el de la propia computadora.

Si la computadora central se apaga o se queda sin internet, las sucursales siguen marcando y guardan todo en su
cola; cuando vuelve, entra solo y en orden.

## Riesgos detectados

1. **La central es una computadora del negocio.** Resuelto en las fases 4 a 6 con la cola de cada sucursal: si la
   central se apaga, nada se pierde, pero tampoco se ve en la planilla hasta que vuelva. Conviene que esté siempre
   encendida y con respaldo automático.
2. **Marcaciones que llegan tarde o desordenadas.** Resuelto en la fase 3: la jornada se reordena sola (ver
   "Marcaciones"). Queda la regla de "tercera marca del día rechazada", que puede molestar a quien se mueve entre
   sucursales en un mismo día.
3. **Olvido de salida.** Resuelto en la versión 1.0.8: la marca del día siguiente abre una jornada nueva, la
   anterior queda "Sin salida" y el administrador la corrige con el botón Corregir.
4. **Reloj de cada lector.** La hora de la marcación la pone el lector. Un lector desconfigurado produce marcas
   inválidas; conviene que el agente lo ponga en hora solo.
5. **Huellas no sincronizadas.** Hasta la última etapa, cada empleado se registra en cada lector donde vaya a
   marcar, **con el mismo ID en todos**.
6. **Abrir el panel a internet.** No se abre: lo único que se publica es el puerto de recepción. El panel sigue
   respondiendo solo en la propia computadora, y ahora con una lista cerrada de lo poco que se atiende desde la red
   local (la página del QR). Ver el panel desde otra sucursal queda para cuando existan usuarios y roles.
7. **Licencia.** Hoy es por computadora y la central es la que la necesita. Las sucursales envían sin licencia
   propia. Si eso cambia (una licencia por sucursal), se exige en `connectToCentral`.
8. **Una clave de sucursal robada** permite enviar marcaciones como si fueran de los lectores de esa sucursal y
   vincular empleados a esos lectores. No da acceso al panel, a la planilla ni a los datos de otras sucursales. Si
   se sospecha, *Clave nueva* la anula en el acto.
9. **La cola de la sucursal no se depura.** Guarda también lo ya enviado, que es lo que evita reenviar; con el
   volumen de una sucursal (decenas de marcas por día) no llega a pesar.

## Roles (preparado, sin implementar)

`super_admin` ve todo y administra sucursales y usuarios; `admin` ve todas las sucursales; `branch_manager` ve
solo la suya. Hoy existen dos accesos por contraseña (Administrador y Recepción). Cuando el panel salga de la
computadora local se reemplazan por usuarios con rol y, para `branch_manager`, una sucursal asignada.

## Sincronización de huellas (no se toca todavía)

Lo que se sabe del lector, comprobado con el equipo real:

- **Cada marcación trae:** ID de usuario (texto, hasta 24 caracteres), fecha y hora locales del lector con
  precisión de segundos y sin zona horaria, el tipo de verificación y el estado de entrada/salida del propio
  lector. Qubiq ignora ese último dato: entrada o salida lo decide el motor.
- **Sí devuelve el ID de usuario**, que es el que se escribe al crear al empleado en el lector.
- **Usuarios en el lector:** cada uno ocupa una posición interna (`uid`), distinta de su ID, y tiene nombre,
  privilegio, contraseña y tarjeta. Las huellas se guardan aparte, hasta diez por usuario, como plantillas.
- **Qubiq hoy** crea al usuario (ID y nombre) y le pide al lector que capture la huella. La plantilla nunca sale
  del lector.

Para sincronizar después habría que leer las plantillas de un lector y escribirlas en los demás. Eso significa
que por primera vez los datos biométricos pasarían por Qubiq, así que requiere: transporte cifrado, no guardarlas
en el central más allá del traslado, lectores con la misma versión del algoritmo de huella, y probarlo en un
lector de prueba antes de tocar uno en producción. La alternativa sin riesgo es registrar a cada empleado en cada
lector con el mismo ID.
