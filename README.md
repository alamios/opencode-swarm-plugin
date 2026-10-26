# swarm — plugin de colaboración entre sesiones de OpenCode v2

Una sola herramienta, `swarm`, que permite a sesiones pares del mismo checkout colaborar
por nombres de animal: descubrimiento automático, instrucciones incrementales, respuestas
correlacionadas por ID exacto y esperas opcionales con detección atómica de ciclos. La
especificación normativa está en la subcarpeta `docs/spec/` (SPEC.md, ACCEPTANCE.md,
CONFIGURATION.md) y la evidencia de validación en `docs/VALIDATION.md`.

## Requisitos

- OpenCode **v2.1.3** (probado con esa versión exacta; CLI compilado con Bun).
- Servidor con registro de servicio (`opencode serve --service`), que genera
  `~/.local/state/opencode/service.json`. El plugin lee el registro para hablar con el propio
  servidor (misma instancia, `pid` verificado).
- Directorio de estado escribible (por defecto `~/.local/state/opencode-swarm/`).
- No hay paso de build: el runtime Bun del CLI importa el TypeScript directamente.
  `npm test` / `npm run typecheck` solo requieren `npm install` (dev dependencies).

## Estructura

El proyecto es autónomo y debe vivir **fuera** de `~/.config/opencode/plugins/` (esa ruta es
la de auto-descubrimiento del servidor y carga sin opciones; este plugin requiere opciones):

```
<raíz del proyecto>          (p. ej. ~/projects/opencode-swarm)
  server.ts, tui.ts, src/, test/  implementación (sin paso de build; `tui.ts` es la
                                  entrada del panel de la TUI)
  config/                    archivos editables en vivo (swarm.json, names.json,
                             swarm-prompt.md, tool-description.md, swarm.schema.json)
  docs/spec/                 especificación normativa original (SPEC.md, ACCEPTANCE.md,
                             CONFIGURATION.md, SOURCES.md, contracts/)
  docs/VALIDATION.md         evidencia de validación sobre el servidor real
  README.md                  este archivo
```

## Instalación

1. Clonar o copiar el proyecto a un sitio estable fuera de `~/.config/opencode`
   (p. ej. `~/projects/opencode-swarm`).
2. Registrar el plugin en `opencode.jsonc` con la ruta absoluta del proyecto y de su `config/`:

   ```jsonc
   "plugins": [
     {
       "package": "/ruta/absoluta/opencode-swarm",
       "options": {
         "configPath": "/ruta/absoluta/opencode-swarm/config/swarm.json"
       }
     }
   ]
   ```

   Opciones opcionales: `stateDirectory` (por defecto `~/.local/state/opencode-swarm`)
   para mover el estado SQLite, y `serviceRegistration` (por defecto
   `~/.local/state/opencode/service.json`) para apuntar a un registro distinto.
3. `npm install` dentro del proyecto (para tests/typecheck, y para que la TUI resuelva
   `@opentui/core` al cargar el panel `tui.ts`) y reiniciar o esperar la recarga del servidor.

### Requisito crítico (v2.1.3): `codemode: false`

La herramienta se registra con nombre simple `swarm` y `options: { codemode: false }`
(sin namespace; ver `server.ts`). Sin `codemode: false`, v2.1.3 pliega la herramienta dentro
de la herramienta CodeMode `execute`; si además la config del usuario deniega `execute`,
`swarm` queda **invisible** para los modelos. No omitir esa opción al portar el plugin.

## Configuración editable (sin recompilar)

Archivos en `config/`:

| Archivo | Contenido |
| --- | --- |
| `swarm.json` | Activación, presencia, esperas, límites, entrega, recarga (ver `swarm.schema.json`) |
| `names.json` | Lista de nombres de animal (asignación aleatoria; el orden del archivo no importa; admite acentos y ñ) |
| `swarm-prompt.md` | Texto del elemento `<instructions>` del bloque `<swarm>` (inglés): identidad y peers, con la variable `{{self_name}}` |
| `tool-description.md` | Descripción de `swarm` (inglés): parámetros, resultados y normas de uso |

Referencia completa de cada campo (qué hace, rango y efecto de cambiarlo):
[`config/README.md`](config/README.md).

Valores vigentes en `config/swarm.json`: `presence.idleGraceMs` 1 h (una sesión idle sigue
siendo destinatario válido), `presence.reconcileEveryMs` 5 s, `wait.timeoutMs` 20 min,
`wait.cyclePolicy` `send_async`, límites 30 envíos/min y 60 respuestas/min por sesión,
ventana de reintentos de admisión 5 min.

**Recarga en vivo:** editar cualquiera de los cuatro archivos aplica el cambio con debounce de
500 ms sin reiniciar el servidor (descripción de herramienta y entradas de instrucciones se
re-sincronizan; un candidato inválido retiene la config vigente y se registra en el log).
**Recarga del plugin:** editar `server.ts` dispara una recarga, pero el cache ESM de Bun solo
re-evalúa la entrada: los módulos de `src/` quedan en caché desde el arranque del proceso, así
que **los cambios de código requieren reiniciar el servidor** (detalle en `docs/VALIDATION.md`
§8.12). Al detenerse la instancia, las esperas pendientes pasan a `cancelled` y su herramienta
devuelve `status: timeout` con detalle `swarm stopped before a reply arrived`; la instancia
nueva re-descubre sesiones y re-sincroniza.

## TUI: panel de la barra lateral

La entrada `tui.ts` registra una sección **Swarm** en el panel derecho de la TUI (slot
`sidebar.content`, junto a Context/MCP/Todo). Muestra dos líneas bajo el encabezado:

- la identidad de la sesión visible (o `—` si no tiene nombre asignado), y
- los peers actualmente disponibles en el mismo scope (o `—` si no hay).

Los datos se leen del mismo estado SQLite del plugin (lectura exclusiva; la TUI no escribe)
y se refrescan cada 5 s. La TUI recarga `tui.ts` en vivo al guardarlo y lo carga siempre en
un arranque nuevo; no hay que reiniciar nada para ver el panel. Evidencia del mecanismo en
`docs/VALIDATION.md` §9.5.

## Semántica de la herramienta

`swarm({ name, message, reply_to?, wait_for_reply? })`:

- `name`: nombre del peer (letras latinas minúsculas con acentos —á é í ó ú ü ñ— y dígitos;
  patrón `^[a-zà-öø-ÿ][a-zà-öø-ÿ0-9]*(?:-[1-9][0-9]*)?$`).
- `reply_to`: ID exacto del mensaje recibido al que se responde (se adjunta la cita real del
  original, acotada).
- `wait_for_reply` (default `false`): espera la primera respuesta correlacionada hasta
  `wait.timeoutMs`.

Estados de resultado: `accepted` (enviado y admitido), `replied` (con `response` de la
respuesta: `id`, `from`, `reply_to`, `message`), `timeout` (el mensaje sigue enviado; una
respuesta tardía llega como mensaje),
`delivery_unknown` (la admisión no se pudo confirmar en la ventana; el plugin sigue
reconciliando) y `error` con códigos (`PEER_UNAVAILABLE`, `INVALID_REPLY`, `SELF_SEND`,
`OUT_OF_SCOPE`, `RATE_LIMITED`, `IDEMPOTENCY_CONFLICT`…). La cadena de estados del mensaje es
`pending | admitted | failed | unknown`; `admitted` es el éxito terminal.

Comportamientos clave:

- **Identidades:** se asignan automáticamente al crearse la sesión (evento
  `session.created`) y, como red de seguridad, en la reconciliación de sesiones activas; la
  asignación es en **orden aleatorio** (barajado Fisher–Yates de la lista, dentro de la
  transacción atómica; el orden de `names.json` no importa). Al asignar, las entradas se
  publican de inmediato para que el primer prompt ya las lleve (ver abajo); si la sesión se
  archiva/borra, el nombre queda reservado para siempre (tumba); al agotar la lista se usan
  sufijos `-2`, `-3`…
- **Ámbito (scope):** servicio + proyecto + directorio canónico del checkout. «Servicio» es la
  ruta canónica del registro de servicio (`~/.local/state/opencode/service.json`): estable en
  reinicios (el campo `id` del registro es un UUID nuevo en cada arranque y no se usa) y
  separa registros distintos (canales) de la misma máquina. Subdirectorios del mismo checkout
  comparten scope; otros worktree/proyectos no.
- **Esperas y ciclos:** una espera es una arista en un grafo por scope; si esperar cerraría un
  ciclo, el mensaje se envía igual pero sin esperar (`reason: cycle_detected`). La decisión es
  atómica (`BEGIN IMMEDIATE`), así que exactamente una de dos esperas concurrentes sobrevive.
- **Entrega:** sintético `steer` con `resume` (despierta al receptor); reintentos con backoff
  1 s→30 s dentro de la ventana; el mismo ID se reenvía (sin duplicados). El texto visible es
  un único objeto JSON: `from`, `to`, `id`, `message`, y — en respuestas — `reply_to` más una
  `original` acotada. Los campos fijos nunca se derivan del contenido del peer.
- **Presencia:** reconciliación cada 5 s contra `GET /api/session/active`; gracia de 1 h
  para sesiones idle; no hay `session.status` en el core v2.1.3 (limitación documentada).

### Entrega de la entrada (`swarm`)

Hay una única *instruction entry* por sesión (API experimental del core), con clave `swarm` y
valor en **texto plano**: el bloque

```
<swarm>
<identity>garza</identity>
<peers>nutria, zorro</peers>
<instructions>
…swarm-prompt.md renderizado…
</instructions>
</swarm>
```

El core renderiza los valores cadena tal cual (los objetos los pasaría por `JSON.stringify`)
y los envuelve siempre en su propio `<context key="swarm">` — esa envoltura es del core, no
del plugin. El core la renderiza de dos formas:

- **Baseline (`initial`):** se inyecta en el *system prompt* de cada petición al modelo, con
  la envoltura `<context key="…">…</context>`, sin escapes. Solo aparece si la entrada existe
  cuando se monta el prompt — por eso el plugin publica las entradas al crearse la sesión y de
  inmediato en `session.execution.started`.
- **Actualizaciones cronológicas:** cada cambio se apila en el historial como mensaje de
  sistema narrando el cambio. En rutas sin rol `system` nativo (OpenAI Chat — la que usa
  llama.cpp), el core las degrada a texto de usuario envuelto en `<system-update>` y **las
  escapa en XML** (`&lt;`, `&gt;`, `&amp;`) para que el contenido no pueda cerrar la envoltura
  (diseño deliberado de v2.1.3, `packages/ai/src/protocols/shared.ts` → `wrapSystemUpdate`).
  Es decir: ver `&lt;context key="swarm"&gt;` y `&lt;swarm&gt;…&lt;/swarm&gt;` en una
  actualización es comportamiento esperado del core, no un bug del plugin; el contenido se
  lee igual.

## Ciclo de vida del location (v2.1.3)

El plugin vive por *location*: una instancia por location activo. El servidor expulsa el
servicio de un location inactivo (TTL 60 min por defecto;
`experimental.location_idle_timeout` lo configura o desactiva). Al expulsarse, la instancia se
detiene limpiamente (`owners` → `dead`); al volver la actividad, una instancia nueva re-descubre
sesiones y re-sincroniza entradas. El estado (identidades, mensajes, esperas) persiste en
SQLite y converge; mientras un scope está expulsado, los envíos a sus peers fallan con
`PEER_UNAVAILABLE` hasta la re-materialización.

## Estado y privacidad

- `~/.local/state/opencode-swarm/swarm.db`: la única autoridad (identidades, presence,
  mensajes, esperas, instruction_state, owners). Fuera del repositorio.
- `~/.local/state/opencode/service.json`: registro del servidor (url/pid/password). El
  password solo se usa por argumento/entorno; nunca en logs ni archivos.
- Los nombres de sesión, títulos y rutas aparecen en el estado; el contexto inyectado
  (entrada `swarm`) solo contiene nombre propio, lista de nombres y el texto configurado.

## Actualización y desactivación

- **Actualizar:** sustituir los archivos del plugin; el servidor recarga en ~1-2 s (o
  reiniciar). Los cambios de esquema de config van por `swarm.json` (campo `version`); un
  config incompatible se rechaza y se retiene el vigente (no se bifurca el estado).
- **Desactivar sin quitar:** `"enabled": false` en `swarm.json` → las esperas pendientes se
  cancelan y las entradas de instrucciones se retiran; la reactivación no duplica
  suscripciones.
- **Quitar:** eliminar la entrada de `plugins` en `opencode.jsonc`; el estado queda en
  `~/.local/state/opencode-swarm/` (borrar ese directorio para limpiarlo por completo).

## Desarrollo y tests

```bash
npm install        # solo para desarrollo
npm test           # tests deterministas (config, scope, almacén atómico, render)
npm run typecheck
```

La validación integrada completa (gates G/P/M/W sobre sesiones reales) está documentada en
[`docs/VALIDATION.md`](docs/VALIDATION.md).

## Documentación

| Documento | Contenido |
| --- | --- |
| [`config/README.md`](config/README.md) | Referencia completa de `swarm.json`: cada campo, rango y efecto de cambiarlo. |
| [`docs/spec/SPEC.md`](docs/spec/SPEC.md) | Especificación funcional y técnica normativa. |
| [`docs/spec/ACCEPTANCE.md`](docs/spec/ACCEPTANCE.md) | Casos de aceptación, concurrencia, recuperación y demo final. |
| [`docs/spec/CONFIGURATION.md`](docs/spec/CONFIGURATION.md) | Contrato de configuración: qué puede editar el usuario y cómo se aplica. |
| [`docs/spec/SOURCES.md`](docs/spec/SOURCES.md) | Fuentes oficiales y capacidades verificadas. |
| [`docs/VALIDATION.md`](docs/VALIDATION.md) | Informe de validación sobre el servidor real (octubre de 2026). |
