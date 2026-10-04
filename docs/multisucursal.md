# Qubiq Control multisucursal

Plan para que un empleado marque con su huella en cualquier sucursal y todas las marcaciones lleguen a un solo
Qubiq Control. Se construye por fases sobre lo que ya funciona; este documento se actualiza al cerrar cada fase.

## Estado

| Fase | Qué | Estado |
| --- | --- | --- |
| 1 | Sucursales (`branches`) | **Hecha** |
| 2 | Lectores asociados a una sucursal | Pendiente |
| 3 | `branch_id`, `device_id` y `event_uuid` en las marcaciones | Pendiente |
| 4 | API central para recibir marcaciones | Pendiente: falta decidir dónde vive el servidor central |
| 5 | La integración ZKTeco envía los eventos al central | Pendiente |
| 6 | Qubiq Agent y cola sin internet | Pendiente |
| 7 a 9 | Piloto: dos sucursales y un empleado marcando en ambas | Pendiente |
| 10 | Resto de sucursales | Pendiente |

## Cómo está construido hoy

- **Una sola computadora lo es todo.** Qubiq Control es una app de escritorio (Electron) que adentro levanta un
  servidor Express en el puerto 3220 y guarda todo en un archivo SQLite dentro de `%APPDATA%\Qubiq Control\data`.
  No existe un servidor central ni una base compartida: es la pieza más grande que falta.
- **El panel solo abre desde esa misma computadora** (`isAdminSurface` en `src/server.js`). Hay una contraseña de
  Administrador y otra de Recepción; no hay usuarios ni roles por persona.
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
- **Fase 2:** `biometric_devices` + `branch_id`, `serial_number`. El serial lo entrega el propio lector; así un
  lector sigue siendo el mismo aunque le cambie la IP.
- **Fase 3:** `biometric_events` + `event_uuid` único, `branch_id`, `source`. `attendance` + `branch_id`,
  `device_id` (cada fila es una entrada o una salida, así que entrada y salida pueden ser de sucursales
  distintas). Lo que ya existe queda en la primera sucursal.
- **Fase 4 en adelante:** credencial por agente (solo se guarda su hash) y, en cada sucursal, `pending_events` con
  estados `pending / syncing / synced / error`.

`event_uuid` se va a calcular a partir del serial del lector, el ID del usuario y la hora de la marcación, no al
azar: así, si un agente se reinstala y vuelve a leer el lector, genera los mismos UUID y el central no duplica.

## Comunicación entre sucursales

Cada sucursal **llama hacia afuera** por HTTPS al central (`POST /api/attendance/events`), con una credencial
propia de ese agente. Ninguna sucursal abre puertos y el 4370 del lector nunca sale de la red local. El central
responde `registered` o `already_registered`; el agente no marca nada como enviado hasta recibir esa respuesta.

**Decisión pendiente: dónde vive el central.** Hoy no existe. Opciones:

- **Servidor en la nube** corriendo este mismo backend. Siempre encendido, con dirección fija y HTTPS. Implica
  costo mensual, mover ahí la base de datos y abrir el panel fuera de la computadora local con usuarios reales.
- **La computadora de una sucursal como central**, publicada con un túnel. Sin costo mensual, pero si esa
  computadora se apaga o se queda sin internet, las demás no sincronizan hasta que vuelva.

## Riesgos detectados

1. **No hay servidor central.** Ver la decisión de arriba; define las fases 4 a 6.
2. **Marcaciones que llegan tarde o desordenadas.** El motor actual decide entrada o salida en el momento en que
   llega cada marcación. Si una sucursal estuvo sin internet y manda sus marcas horas después, llegan "viejas"
   y hoy se rechazan por estar fuera de orden. Antes del piloto hay que hacer que la jornada de un empleado se
   recalcule con todas sus marcaciones del día ordenadas por hora.
3. **Olvido de salida.** Con la regla actual, la marca siguiente cierra la jornada anterior (si pasaron menos de
   20 h) o queda rechazada. Con seis sucursales va a pasar a diario; hace falta la corrección manual y una regla
   clara.
4. **Reloj de cada lector.** La hora de la marcación la pone el lector. Un lector desconfigurado produce marcas
   inválidas; conviene que el agente lo ponga en hora solo.
5. **Huellas no sincronizadas.** Hasta la última etapa, cada empleado se registra en cada lector donde vaya a
   marcar, **con el mismo ID en todos**.
6. **Abrir el panel a internet.** Hoy está protegido por abrir solo en la propia computadora. En un central
   accesible desde afuera hacen falta usuarios, contraseñas por persona, HTTPS y límites de intentos.
7. **Licencia.** Hoy es por computadora. Hay que definir cómo se licencian los agentes de cada sucursal.

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
