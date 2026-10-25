# Informe de validación — plugin `swarm` (OpenCode v2)

Ejecutado el **sábado 24 de octubre de 2026** sobre un servidor real de largo plazo
(`opencode serve --service`, Linux x86_64). Las horas son CEST (UTC+2); los valores de
`created_at`/`resolved_at` citados son epoch en milisegundos. La especificación normativa está
en `docs/spec/` (SPEC.md, ACCEPTANCE.md, CONFIGURATION.md). El proyecto es autónomo:
implementación (`server.ts`, `src/`, `test/`), configuración editable en vivo (`config/`) y
documentación (`docs/`). Los IDs de sesión/mensaje/instancia se abrevian para su publicación;
los caminos citados son por defecto del plugin o rutas temporales de la instalación de prueba.

## 1. Entorno y versiones exactas

| Componente | Versión / detalle |
| --- | --- |
| OpenCode | **v2.1.3** (CLI compilado con Bun; proceso del servidor `opencode.exe`) |
| Servidor | `opencode serve --service` sobre `127.0.0.1:<puerto dinámico>`, registro en `~/.local/state/opencode/service.json` (url/pid/password; el password nunca se registra en logs ni archivos) |
| SDK | `@opencode/plugin` **2.1.3** (peer dependency), API promise v2 |
| Modo de carga | En proceso, una instancia del plugin por *location* activa; recarga en vivo al editar el fuente (fuente de plugin configurada, debounce ~100 ms) y al editar la config (watcher propio, debounce 500 ms) |
| Sistema operativo | Linux x86_64 |
| Driver SQLite | `bun:sqlite` en el host; `node:sqlite` en tests (SQL idéntico, transacciones `BEGIN IMMEDIATE`) |
| Modelo de la demo | Modelo local servido por un contenedor llama.cpp vía API OpenAI-compatible en `localhost` |
| Base de datos | `~/.local/state/opencode-swarm/swarm.db` (fuera del repositorio; valor por defecto del plugin) |
| Proyectos de demo | Dos checkouts desechables fuera del repositorio: `repoA` (subdirectorios `alpha` y `beta`) y `repoC` |

## 2. Sesiones y ámbito

| Rol | Sesión | Directorio | Nombre |
| --- | --- | --- | --- |
| A | `ses_A` | `repoA/alpha` | `alce` |
| B | `ses_B` | `repoA/beta` | `alpaca` |
| C | `ses_C` | `repoC` | `abeja` |

Las primeras A/B (`ses_A0` = `abeja`, `ses_B0` = `aguila`) se archivaron ~23:05 tras un
«envenenamiento» de historia (el modelo afirmó que la herramienta no existía y lo repitió). Sus
nombres quedaron **reservados por tumba** en la tabla `identities` (`tombstone=1`), tal como
exige la spec: un nombre asignado no se recicla. Las nuevas A/B recibieron `alce`/`alpaca`.

## 3. Tests deterministas

`npm test` en la raíz del proyecto: **30/30 en verde**, más `npm run typecheck` limpio. Cubren:
validación de config (campos, archivos referenciados, nombres duplicados, prompt con variable
desconocida), canonicalización de átomos de ámbito, render/citas, y las carreras atómicas del
almacén: W05 (reply vs timeout, ganador único en ambos órdenes), W07 (dos envíos cruzados
simultáneos, una sola espera sobrevive a `commitSend`), W02 (respuesta rápida antes del retorno
de admisión), W14 (fallo de admisión no deja reserva fantasma), G07 (cosecha de esperas huérfanas
solo de propietarios muertos), M12 (cupos de envíos y respuestas separados).

## 4. Casos de aceptación en integración real

Estado: **APROBADO** = demostrado en vivo con la evidencia citada; **UNIT** = cubierto solo por
test determinista; **NO EJECUTADO** = no se ejecutó. Los nombres de herramienta y de entrada se
citan como estaban el día de la validación; su evolución hasta el estado actual está en §9.

### Gates previos (G01–G08)

| ID | Caso | Estado | Evidencia |
| --- | --- | --- | --- |
| G01 | Herramienta registrada una vez, identidad real del invocante | APROBADO | El cuerpo HTTP de la petición al modelo incluye `swarm_send` exactamente una vez (nombre de la herramienta en ese momento; captura de la sonda `http.request` a un archivo temporal de trabajo, no incluido en el repositorio). El remitente sale de `toolCtx.sessionID`, nunca de argumentos: los 14 mensajes tienen `from_name` correcto; el autoenvío se rechaza (`SELF_SEND`) por diseño. |
| G02 | Dos subdirectorios del mismo checkout coinciden; otro proyecto no | APROBADO | `alpha` y `beta` comparten el scope canónico `…\0<repoA>` (misma clave en `identities`); `repoC` tiene scope distinto (proyecto + directorio distintos). Worktree secundario: NO EJECUTADO (no había segundo worktree). |
| G03 | Entradas incrementales visibles por el modelo | APROBADO | A leyó su identidad (`alce`) y sus peers (`alpaca`) del contexto renderizado (pregunta Q2: «Mi nombre de colaboración es alce»). La recarga de `swarm-prompt.md` re-sincronizó la entrada **en vivo** (ver §5): el propio operador vio la entrada re-inyectada con la marca y sin marca. Tras compactación (M05) la entrada persiste. |
| G04 | Admisión repetida con el mismo ID | UNIT | La entrega reintenta con el mismo `msg_…` (backoff 1s→30s, ventana 5 min) y la admisión se deduplica por ID en el almacén; no hubo fallo de admisión en vivo que exigirlo. |
| G05 | Espera larga >60 s con plazo 20 min | APROBADO | Espera `w_…`: creada 1792876842770 (23:20:42), resuelta `replied` a 1792876934143 (23:22:14) → **91 373 ms viva**; `deadline_at` = creada + 1 200 000 ms (default de 20 min intacto). B ejecutó el trabajo real de 60 s (12 × `sleep 5`, `report.txt` con 12 líneas) y respondió correlacionado. |
| G06 | Cancelación interrumpe la espera | UNIT | El camino `abort` del waiter cancela la espera y resuelve la promesa; no se interrumpió una herramienta en vivo. |
| G07 | Varias instancias, una sola autoridad | APROBADO (parcial) | Coexistieron 5-6 instancias vivas simultáneas (los checkouts de demo y otros checkouts activos de la máquina) sobre una sola DB, sin suscripciones duplicadas con efectos (prefiltro de eventos por raíz de checkout + reconciliación con lease). La decisión atómica de ciclo/concurrencia está UNIT. |
| G08 | Persistencia del resultado de herramienta | LIMITACIÓN | No existe en v2.1.3 una señal que confirme la persistencia del resultado de herramienta; si el host muere tras `commitSend` pero antes de persistir el resultado, la reinvocación con la misma clave de invocación se reconcilia (mismo ID, estado del mensaje), con ventana de duplicación identificable (ver §7). |

### Identidad y presencia (P)

| ID | Estado | Evidencia |
| --- | --- | --- |
| P01 | APROBADO | `alce` (1792875744633) y `alpaca` (1792875751886): nombres distintos, estables, asignados sin herramienta de registro (reconciliación 5 s). |
| P02 | APROBADO | C (`abeja`, scope repoC) nunca aparece en `swarm.peers` de A ni de B; los peers de A/B son mutuamente solo. C ve `{"peers":[]}`. |
| P12 | APROBADO | Subdirectorios de un mismo checkout → misma identidad canónica (ver G02). |
| P03, P04, P05, P06, P07, P08, P09, P10, P11, P13, P14, P15, P16, P17, P18, P19, P20 | NO EJECUTADO en vivo | P15 se cumplió implícitamente (hashes estables de `instruction_state` durante todo el demo: sin re-publicaciones sin cambio). P08 se cumplió implícitamente (B, idle desde 23:22, siguió disponible a las 23:46, dentro de la gracia). El resto queda para una ronda posterior. |

### Envíos y respuestas (M)

| ID | Estado | Evidencia |
| --- | --- | --- |
| M01 | APROBADO | Aviso `msg_A1` (23:03:36) sin espera: `accepted` inmediato, estado `admitted`, A no aguardó. |
| M02 | APROBADO | B vio remitente, ID y cuerpo en el sintético (sin metadatos ocultos); 14/14 mensajes entregados así. |
| M03 | APROBADO | Q1: espera `w_A1` resuelta `replied` (15 949 ms); la herramienta de A devolvió `{status:"replied", response:{id:"msg_B1", from:"alpaca", reply, message:"> Pregunta (Q1)…"}}` con cita real. |
| M04 | UNIT | `INVALID_REPLY` verificado en tests (reply inventado / destinatario distinto). |
| M05 | APROBADO | `POST /api/session/:id/compact` sobre A; la entrada swarm persiste y las respuestas posteriores (Q3/Q4) llegaron con cita comprensible. |
| M06 | UNIT | Clave de invocación (sesión+mensaje+id de llamada): mismo ID y resultado reconciliado. |
| M07, M08, M09, M10, M11 | NO EJECUTADO en vivo | M10 (nombre inválido/autoenvío) cubierto por validación de entrada en `handleSend`. M08/M09 se aproximaron con el reply tardío de Q5 (autor en ámbito, no suspendido → entregado). |
| M12 | UNIT | Cupos por separado (30 envíos/min, 60 respuestas/min). |

### Esperas (W)

| ID | Estado | Evidencia |
| --- | --- | --- |
| W01 | APROBADO | Ver M03: una única respuesta como resultado de herramienta, sin copia sintética adicional al autor. |
| W02 | UNIT | La reserva captura la respuesta antes de que la admisión retorne. |
| W03 | APROBADO | Aviso `msg_A2` con espera bajo plazo 30 s: espera `w_A2` `timed_out` a 1792877028145 (30 152 ms desde 1792876997993; `deadline_at` = creada + 30 000). Resultado de herramienta: `{"status":"timeout","accepted":true,…,"detail":"no reply within 30s; the message stays sent and a late reply will arrive as a message"}`. El mensaje quedó `admitted`; B no respondió. |
| W04 | APROBADO (vía Q5) | El reply tardío `msg_B3` (tras `cancelled` de la espera) se entregó a A como mensaje asíncrono con el mismo reply y cita (ver §6). |
| W05, W07 | UNIT | Carreras atómicas en el almacén (tests citados en §3). |
| W06 | APROBADO | Contrapregunta de B con espera mientras A esperaba a B: **no** se creó arista; herramienta de B devolvió `{"status":"accepted",…,"reason":"cycle_detected","detail":"waiting would close a wait cycle (ses_A -> ses_B); sent without waiting"}`; el mensaje sí se envió (`msg_B2`). |
| W08, W09, W10, W11, W12, W13, W14 | UNIT (W14 incluido) | Cubiertos por tests atómicos; no se orquestaron en vivo. |
| W15 | APROBADO (parcial) | «Próxima llamada usa el nuevo valor»: la espera W03 usó 30 000 ms tras cambiar `wait.timeoutMs` a 30000 (las anteriores usaban 1 200 000 ms). «Deadline original intacto» durante una espera viva: NO EJECUTADO. |
| W16 | LIMITACIÓN | Los deadlines son de **reloj de pared** (`Date.now()`) por requisito de persistencia; no monotónicos. Documentado, no reproducible sin cambiar el diseño. |
| W17 | UNIT | La detección de ciclo corre dentro de `BEGIN IMMEDIATE` en `commitSend`: decisión serializable en una sola autoridad. |

### §5 Caídas y recarga

| Caso | Estado | Evidencia |
| --- | --- | --- |
| Recarga de config inválida retiene la anterior | UNIT | `attempt()` del watcher: candidato inválido → log y se conserva la config vigente. |
| Reinicio con entrega pendiente | APROBADO | Ver §6 (Q5): espera cancelada limpiamente, IDs conservados, reply tardío entregado, sin duplicados. |
| Resto (fallo justo antes/después de cada transición) | NO EJECUTADO | La cosecha de huérfanos (G07) está UNIT; un crash real del host no se inyectó (la demo corre sobre ese servidor). |

### §6 Demostración final — completada

Aviso (M01), pregunta con espera (W01/M03), respuesta con cita (M03), contrapregunta degradada
por ciclo (W06), compactación (M05), recarga de prompt y timeout desde archivos (§5),
reinicio con entrega pendiente (§7), espera larga (G05), timeout (W03) y C aislada durante todo
el flujo (§8).

## 5. Recarga de configuración en vivo (dos ensayos)

**Ensayo 1 (timeout):** `wait.timeoutMs` 1 200 000 → 30 000 editado en `config/swarm.json`;
sin reinicio de servidor. La espera siguiente (W03) expiró con `deadline_at` = creada + 30 000 ms.

**Ensayo 2 (prompt + descripción + restauración):** se añadieron marcas visibles
(`MARCA-RELOAD-7a3f` en `swarm-prompt.md`, `MARCA-TOOL-9c21` en `tool-description.md`) y se
restauró `timeoutMs` a 1 200 000. Evidencia, por niveles:

1. **DB:** `instruction_state.desired_json` de las entradas de todos los scopes activos
   (sesiones de demo A/B, sesión del operador y otros locations activos) pasó a incluir la marca
   con `confirmed_hash` actualizado (reconciliación con lease, ≤1 tick de 5 s).
2. **Contexto en vivo:** la propia sesión del operador recibió la entrada re-inyectada con la
   marca (y sin ella al restaurar), sin reinicio.
3. **Cable:** el cuerpo HTTP real hacia el proveedor pasó a incluir la marca en la descripción
   de la herramienta (captura de la sonda: 21:36:38 UTC descripción vieja → 21:36:58 UTC nueva,
   sesión del operador; 21:39:03 UTC sesión A).

Al restaurar ambos archivos a sus valores por defecto, las entradas convergieron de nuevo
(marca ausente, `confirmed`), cerrando el ensayo con la config en su estado original
(`timeoutMs: 1200000`).

## 6. Reinicio del plugin con entrega pendiente (Q5)

Sección completa de la prueba, con el plugin en vivo:

1. 23:46:24 (1792878384199): A envía `msg_A3` con `wait_for_reply=true`;
   espera `w_A3` en estado `waiting` (plazo 20 min, propietario: instancia previa).
2. 23:46:25 (1792878385676): se edita `server.ts` → el servidor recarga el plugin.
3. 23:46:25 (1792878385788): el `stop()` limpio de la instancia anterior cancela la espera
   (`cancelled`, 1 589 ms desde su creación). La llamada de herramienta **en vuelo** resolvió con
   `{"status":"timeout","accepted":true,"id":"msg_A3","name":"alpaca","waiting":false,"detail":"swarm stopped before a reply arrived"}` — la sesión no quedó colgada.
4. Nuevas instancias creadas ~1792878385792 (`i_…` para los 4 locations activos) —
   registro en `owners` como prueba de recarga.
5. 23:47:00 (1792878420514): B (que ya había recibido la pregunta por el sintético) responde
   `msg_B3` (`reply_to` correcto). La espera estaba ya cancelada → la respuesta no se
   reclama por espera; la instancia nueva la entrega por el canal asíncrono y A la recibe como
   mensaje (verificado en el contexto de A). Sin duplicados: una sola fila por mensaje.

Resultado: sin pérdida de mensajes, IDs estables, herramienta siempre resuelta. La variante
«crash» (propietario muerto sin `stop()` limpio) queda cubierta por la cosecha de huérfanos
(G07, UNIT) y por el diseño (`abandoned`).

## 7. Aislamiento de C (repoC)

- `swarm.peers` de C: `{"peers":[]}` (confirmada en `instruction_state`).
- Cero mensajes entrantes o salientes en el scope repoC (los 14 mensajes del demo pertenecen
  todos a repoA); el contexto de C no contiene ningún sintético swarm.
- **Hallazgo de v2.1.3 (documentado, no defecto del plugin):** el servicio de un location inactivo
  se **expulsa** por `LocationActivity` (TTL por defecto 60 min; configurable con
  `experimental.location_idle_timeout`). C quedó inactivo a las 22:30:08 y su instancia se
  detuvo limpiamente a las 23:30:45 (`owners` → `dead`), 60 min 37 s después. Al volver a
  actividad (prompt trivial a las 23:48) el location se re-materializó y una nueva instancia
  (`i_…`, 23:48:48) re-descubrió la sesión, re-sincronizó las entradas y restauró el
  peers vacío. Mientras un scope está expulsado, los envíos a sus peers fallan con
  `PEER_UNAVAILABLE` («not currently available») hasta la re-materialización; el estado en SQLite
  persiste y converge.

## 8. Bloqueos y limitaciones concretas contra v2.1.3

1. **`codemode: false` es obligatorio** para que `swarm` exista como herramienta directa.
   Sin ella, v2.1.3 pliega la herramienta en la herramienta CodeMode `execute`
   (`core/src/tool.ts`); como la config de prueba deniega `execute`, la herramienta era
   completamente invisible. Con `options: { codemode: false }` se registra una definición
   directa. Verificado en tres niveles: `ctx.tool.list()` del plugin, hook de contexto y cuerpo
   HTTP real.
2. **No hay `session.status`/eventos de idle en el core v2.1.3** (lo que existe no cubre el
   «idle con gracia»): la presencia se mantiene con un bucle de reconciliación (5 s) sobre
   `GET /api/session/active` + eventos duraderos; no es push.
3. **Expulsión de locations inactivos** (ver §7): el plugin vive y muere con su location.
4. **Resultados de herramienta no confirmados** (G08): sin señal de persistencia; la
   idempotencia por clave de invocación limita pero no elimina la ventana de duplicación en
   reinicio.
5. **Reloj de pared** en deadlines (W16).
6. **Nombres no reciclables** (spec, línea 19): la tumba reserva el nombre para siempre; el
   crecimiento del pool se mitiga con sufijos (`-2`, `-3`…).
7. **Peligro operacional (no de v2.1.3):** un modelo que afirma «la herramienta no existe» lo
   repite por anclaje a su propia historia aunque la herramienta sí esté en la petición (probado
   por bisección con cuerpos capturados: historial limpio → llama a la herramienta; historial
   envenenado → se niega). Mitigación: archivar la sesión y crear una nueva.
8. **Reinicio total del servidor no reproducible**: la demo corre sobre el propio servidor; se
   probó la recarga limpia del plugin (Q5) y la cosecha de huérfanos (UNIT).
9. Trastorno cosmético observado: tras recargas de herramientas, el servidor inyecta mensajes de
   sistema sobre Code Mode en el historial de la sesión (sin efecto en la disponibilidad de
   `swarm`; el reply posterior a la recarga de Q5 funcionó).
10. **Tags escapados en actualizaciones de instrucciones** (25-10, investigado sobre el fuente
    del core): el texto *guardado* del mensaje de actualización incluye la envoltura
    `<context key="…">` sin escapar; el escape aparece al montar la petición del modelo. En rutas
    sin rol `system` nativo (OpenAI Chat, la de llama.cpp), el core convierte las actualizaciones
    cronológicas `Message.system(…)` en mensajes de usuario envueltos en `<system-update>` y las
    **escapa en XML por diseño** (`packages/ai/src/protocols/shared.ts` →
    `escapeSystemUpdateText`/`wrapSystemUpdate`), para que el contenido no pueda cerrar la
    envoltura. El baseline `initial` (system prompt) no se escapa. No es corregible desde el
    plugin; el contenido JSON se lee igual. Documentado en `README.md` (§ Entrega de la entrada).
11. **El `id` del registro de servicio es inestable** (25-10, investigado sobre el fuente
    del core): `packages/cli/src/server-process.ts` genera `instanceID = randomUUID()` en cada
    arranque y lo escribe como `id` en `service.json`. Cualquier scope derivado de ese `id`
    cambiaría en cada reinicio (re-asignación de identidades y nombres huérfanos en el scope
    muerto). El plugin usa como discriminador de servicio la **ruta canónica del registro**
    (estable en reinicios) en su lugar; ver §9.3.
12. **Recarga de plugin: solo la entrada se re-evalúa en Bun** (25-10, investigado sobre el
    fuente del core y observado en vivo): `PluginModule.load` usa `import(entrypoint)`
    (`packages/util/src/runtime/import.bun.ts`) y el cache-bust de
    `packages/plugin/src/source.bun.ts` solo borra `require.cache` (CJS). La entrada
    (`server.ts`) se re-evalúa en cada recarga, pero las **dependencias** (`src/*.ts`) se
    sirven de la caché ESM de Bun por URL → editar un `src/*.ts` no se refleja hasta un
    **reinicio del servidor** (intento observado en vivo: `SyntaxError: Export named
    'canonicalServiceRef' not found` tras editar `scope.ts` en caliente; la instancia vieja
    sigue corriendo, el fallo no rompe el servidor). Consecuencia práctica: los cambios de
    hoy (y cualquiera futuro sobre `src/`) se despliegan reiniciando el servidor, no tocando
    `server.ts`.

## 9. Comandos reproducibles

```bash
# Ayudantes de demo (leen service.json; nunca imprimen el password)
cd <directorio temporal de trabajo>
python3 h.py identity          # identidades activas
python3 h.py waits             # tabla de esperas
python3 h.py messages          # tabla de mensajes
python3 h.py instr             # instruction_state
python3 h.py ctx <sessionID>   # contexto de una sesión
python3 h.py prompt <sessionID> "texto"
python3 h.py waitpoll <sessionID>

# Consultas directas a la DB (read-only)
node --no-warnings -e "const {DatabaseSync}=require('node:sqlite');const d=new DatabaseSync('<stateDirectory>/swarm.db',{readOnly:true});console.log(JSON.stringify(d.prepare('SELECT * FROM waits').all(),null,1))"

# Recarga de config: editar config/{swarm.json,names.json,swarm-prompt.md,tool-description.md}
# (debounce 500 ms; candidato inválido retiene la config vigente)

# Recarga del plugin: tocar/editar server.ts (el servidor lo detecta en ~1-2 s;
# prueba: nuevas filas en 'owners' con ID i_<hex>_<uuid> y 'loading plugin' en el log)

# Tests del plugin
npm test && npm run typecheck
```

## 9.1 Consolidación del proyecto (25-10) y comportamiento del supervisor

El 25-10 el proyecto se consolidó como unidad autónoma:

- Implementación (`server.ts`, `src/`, `test/`), configuración editable en vivo (`config/`) y
  especificación de diseño original (`docs/spec/`); este informe, en `docs/`.
- `opencode.jsonc`: `package` → ruta absoluta del proyecto, `configPath` →
  `<proyecto>/config/swarm.json` (`stateDirectory` sin cambios).
- El directorio de auto-descubrimiento `plugins/` quedó restaurado vacío (`.keep`): sin
  plugins cargados sin opciones. `.gitignore` añade `node_modules/`; el ZIP
  `swarm-2.1.3.zip` se eliminó (todo su contenido está ya en el árbol).

**Generación de instancias del supervisor (v2.1.3, investigado sobre el fuente del core):**
el `PluginSupervisor` de cada location re-deriva las fuentes del plugin (`activate()`) solo ante
eventos de cambio bajo `{configroot}/plugins/**`, watches directos del target configurado (se
registran a primera vista, nunca se re-registran solas), cambios del grafo de módulos, o el timer
de 24 h / reinicio del servidor. Tras mover el directorio del plugin, el watch del target viejo
muere (los archivos desaparecen) y el nuevo target no se registra hasta una re-derivación
(circular) → **los locations ya activos conservan la instancia en memoria previa**: mismo código
y misma config (envíos, esperas y entradas funcionan igual; se pierden la recarga en vivo de
config y del plugin). Los locations nuevos cargan limpiamente desde la ruta nueva (evidencia:
`loading plugin` del target nuevo a las 22:34:36Z en el log del servidor e instancias `i_…`
para los locations activos). No quedó disparador in-proceso disponible (se probaron touch del
nuevo `server.ts` y creación/edición de archivos bajo `plugins/`: sin efecto; el
watcher del root global no emite eventos a través de enlaces simbólicos). El cambio de los
locations viejos a la nueva ruta se completa en el próximo **reinicio del servidor** (o al
expulsarse el location por inactividad y re-materializarse).

Además, un error del core (no del plugin) aparece en el log desde el 24-10 ~20:28Z, antes del
demo y de la reorganización: `unhandled rejection … Error: SQLite query expected 5 values,
received 4` cada ~100 s; el servidor funcionó correctamente durante todo el periodo.

## 9.2 Mejoras del 25-10 (post-validación)

- `wait.timeoutMs` fijado en `1 200 000` ms (**20 min**) en `config/swarm.json` (confirmado;
  ya era el valor vigente tras restaurar el ensayo de recarga).
- **Asignación de nombres aleatoria:** `acquireIdentity` baraja la lista (Fisher–Yates con
  `Math.random`, inyectable en tests) antes de probar candidatos; los sufijos al agotar la
  lista siguen el mismo orden aleatorio. Tests deterministas de asignación actualizados con
  fuentes inyectables; SPEC.md actualizada (párrafo de asignación de nombres).
- `names.json` crece de 30 a **154** nombres (validados: patrón, sin duplicados).
- `swarm-prompt.md` y `tool-description.md` traducidos al inglés; el prompt se limita a
  identidad y peers (3 párrafos) y la semántica de parámetros, resultados y normas de
  respuesta pasa a la descripción de la herramienta.
- Nueva referencia completa de la configuración: `config/README.md` (cada campo, rango,
  valor actual y efecto de cambiarlo).

Estos cambios aplican al recargarse el plugin (nueva instancia) o en el próximo reinicio del
servidor; el estado persistido (identidades, mensajes) no se ve afectado.

## 9.3 Correcciones del 25-10 (turno 1, escape y scope estable)

Tres problemas reportados y sus causas (todas verificadas sobre el fuente de v2.1.3):

1. **Schema de la herramienta en español:** `INPUT_SCHEMA` de `server.ts` (descripción de
   `reply` en español) traducido al inglés, con descripciones cortas en inglés para los cuatro
   parámetros. El contrato `docs/spec/contracts/swarm.input.schema.json` se actualizó al mismo
   texto (la spec sigue en español; solo el contrato de la herramienta pasa a inglés).
2. **Primer turno sin peers / sin contexto:** las entradas solo se publicaban en el tick de
   reconciliación (5 s, gated por lease), tras montar el primer prompt → el turno 1 salía sin
   baseline y las entradas llegaban a mitad de sesión como «cambio». Causa y arreglo:
   - Nueva casuística `session.created` en `coordinator.ts` (el evento trae `projectID`,
     `location` y `parentID`; sin consulta HTTP): asigna identidad y publica las entradas de
     esa sesión **de inmediato**, antes de que se monte el primer prompt.
   - `session.execution.started` (red de seguridad para sesiones creadas antes de la instancia
     o con entradas perdidas) también dispara ahora un sync inmediato.
   - Refactor: `syncInstructions()` (tick) y el nuevo `syncSessionInstructions()` (puntual)
     comparten `publishSessionEntries()`; el sync puntual omite el debounce de peers (el
     valor publicado es la snapshot vigente, no una snapshot intermedia).
   - Consecuencia: el baseline (`initial`) entra en el system prompt desde el turno 1; solo
     los cambios posteriores llegan como actualización cronológica.
3. **Escape de `<context key=…>`:** comportamiento deliberado del core en rutas sin rol
   `system` nativo (ver §8.10). No se modifica nada en el plugin; se documenta.

**Scope estable en reinicios (hallazgo colateral):** el campo `id` de `service.json` es un
UUID nuevo en cada arranque (§8.11); el scope incluía ese `id`, así que cada reinicio
re-asignaba identidades a todas las sesiones (p. ej. la sesión de este informe pasó de
`abeja` a `lagarto` al reiniciarse el servidor ~02:16 CEST el 25-10, con la fila vieja
huérfana en el scope muerto). Cambio: el discriminador de servicio es ahora la **ruta canónica
del registro** (`scope.ts` → `canonicalServiceRef`; `server.ts` deja de usar `info.id`).
Efecto: un único cambio de scope más (las filas de los scopes con UUID quedan reservadas y
huérfanas); a partir de entonces las identidades sobreviven reinicios.

Validación: `npm test` 32/32, `npm run typecheck` limpio, y un harness desechable en un
directorio temporal (6 checks: identidad + puts inmediatos en `session.created`,
subdirectorio mismo scope, fuera de scope ignorado, subagente excluido, sin puts duplicados en
`execution.started` con valores invariados, hot-swap de config reflejado) pasa.
**Despliegue:** por la limitación de la caché ESM de Bun (§8.12), los
cambios de `src/` requieren **reinicio del servidor** (tocar `server.ts` no basta; los
intentos en caliente fallan con `SyntaxError` y la instancia vieja sigue corriendo). La
observación en vivo (turno 1 con peers en el system, sin escape; nombres estables en
reinicio) se verifica tras ese reinicio.

## 9.4 Ajustes del 25-10 (turno 2: bloque `<swarm>`, tool `swarm`, JSON)

Cambios pedidos por el usuario sobre el resultado del turno 1 (código completado; pendiente de
despliegue):

1. **Bloque `<swarm>`:** en lugar de dos entradas JSON (`swarm.identity`, `swarm.peers`), hay
   una única entrada `swarm` cuyo valor es una **cadena** con el bloque
   `<swarm>` → `<identity>nombre</identity>` / `<peers>n1, n2</peers>` /
   `<instructions>…prompt…</instructions>`. Verificado en el fuente de v2.1.3
   (`packages/core/src/session/instruction-entry.ts`): `renderValue` renderiza cadenas tal cual
   (los objetos los pasa por `JSON.stringify`) y `renderBlock` siempre envuelve en
   `<context key="…">` — esa envoltura exterior es del core y no se puede quitar; queda un
   solo wrapper fino (`<context key="swarm">`) en vez de dos.
2. **Tool `swarm`:** renombrada desde `swarm_send`; nombre simple sin namespace,
   `options: { codemode: false }` (mismo requisito que antes).
3. **`reply` → `reply_to`:** argumento de la tool, campo del sobre JSON visible y
   `response.reply_to` del resultado `replied`.
4. **Sin campo `accepted`:** eliminada la redundancia `"status": "accepted", "accepted": true`
   en todos los resultados.
5. **Sobre JSON:** el texto visible del mensaje recibido es un único objeto JSON
   (`from`, `to`, `id`, `message`; en respuestas, `reply_to` más `original` acotada por
   `replyQuoteMaxChars`), en vez del texto plano «Swarm message from …». Los campos fijos se
   construyen antes del cuerpo, así un peer no puede suplantarlos.
6. **Schema más fino:** sin `$schema` ni `title`; contrato renombrado a
   `docs/spec/contracts/swarm.input.schema.json`.
7. **Prompt y descripción** reescritos al nuevo formato (referencian `<swarm>`, `<peers>` y
   `reply_to`); aplicados en vivo por recarga de config antes del reinicio.

Validación: `npm test` **33/33** (tests de render reescritos: sobre JSON, bloque `<swarm>`,
hostile body no suple campos fijos), `npm run typecheck` limpio. **Despliegue:** por la
limitación de la caché ESM de Bun (§8.12) estos cambios de `src/` y de `server.ts` requieren
**reinicio del servidor**; como el scope ya es estable (§9.3), los nombres se conservan sin
re-asignación.

## 10. Resumen de estados

- **Aprobados en vivo:** G01, G02, G03, G05, G07 (parcial), P01, P02, P12, M01, M02, M03, M05,
  W01, W03, W04 (vía Q5), W06, W15 (parcial), §5 recarga (2 ensayos), §5 reinicio con entrega
  pendiente (Q5), §6 demo completa, aislamiento de C.
- **Aprobados en unit:** G04, G06, M04, M06, M12, W02, W05, W07, W14, W17 (+ config/scope/render).
- **Limitaciones documentadas:** G08, W16 (reloj de pared).
- **No ejecutados en vivo:** P03–P11, P13–P20 (salvo P01/P02/P12/P15/P08 implícitos),
  M07–M11 (salvo M08/M09 aproximados), W08–W13, W15 (deadline intacto en espera viva).
