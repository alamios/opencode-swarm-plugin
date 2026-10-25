# Configuración de swarm — referencia

Los archivos de esta carpeta se cargan **juntos como una unidad**: si algún candidato es
inválido, se retiene la configuración vigente y el fallo se registra en el log (nada se
bifurca). Los cambios válidos se aplican **en vivo**, sin reiniciar el servidor
(debounce `reload.debounceMs`).

## swarm.json

Todos los valores numéricos son enteros en **milisegundos** salvo que se indique lo
contrario. El rango es el que acepta la validación; el *valor actual* es el de este
repositorio.

### Raíz

| Campo | Valor actual | Qué hace |
| --- | --- | --- |
| `version` | `1` | Versión del contrato. Solo se acepta `1`; cualquier otro valor rechaza todo el config. |
| `enabled` | `true` | Interruptor general. Con `false`: se cancelan las esperas pendientes (la herramienta devuelve `timeout` con detalle `swarm stopped before a reply arrived`), se retiran las entradas de instrucciones y dejan de publicarse peers. Los datos (identidades, mensajes) se conservan. |
| `namesFile` | `./names.json` | Ruta del archivo de nombres, relativa a `swarm.json`. |
| `promptFile` | `./swarm-prompt.md` | Ruta del texto de instrucciones renderizado dentro del bloque `<swarm>` (elemento `<instructions>`). |
| `toolDescriptionFile` | `./tool-description.md` | Ruta de la descripción de la herramienta `swarm`. |

### `presence` — quién es visible para quién

| Campo | Rango | Valor actual | Qué hace |
| --- | --- | --- | --- |
| `idleGraceMs` | 0 – 604 800 000 (7 d) | `3 600 000` (1 h) | Gracia para sesiones inactivas: una sesión que deja de estar activa sigue publicándose en el elemento `<peers>` del bloque `<swarm>` durante este tiempo (y siempre mientras tenga una espera viva). Bajarlo hace que las sesiones idle desaparezcan antes del listado de peers; subirlo las mantiene disponibles más tiempo. |
| `reconcileEveryMs` | 1 000 – 60 000 | `5 000` | Período del bucle de reconciliación: descubre sesiones activas nuevas, les asigna identidad, actualiza presencia (activa/idle/suspendida), limpia las archivadas y re-sincroniza las entradas de instrucciones. También fija el lease de propiedad por scope (`max(3 × este valor, 10 s)`): cuánto tarda otra instancia en «heredar» un scope si la propietaria muere. |
| `publishDebounceMs` | 0 – 10 000 | `500` | Debounce entre republicaciones consecutivas de la entrada `swarm` cuando cambia el conjunto disponible (evita ráfagas cuando varias sesiones arrancan o mueren a la vez). |
| `includeSubagents` | booleano | `false` | Con `true`, las sesiones de subagentes también reciben identidad y aparecen en el elemento `<peers>` del bloque `<swarm>`. Con `false` (defecto) no participan en el swarm. |

### `wait` — esperas de respuesta (`wait_for_reply`)

| Campo | Rango | Valor actual | Qué hace |
| --- | --- | --- | --- |
| `timeoutMs` | 1 000 – 86 400 000 (24 h) | `1 200 000` (**20 min**) | Plazo por defecto de `wait_for_reply`: si el peer no responde antes de que se agote, la herramienta resuelve con `status: timeout` (el mensaje queda enviado; una respuesta tardía llega después como mensaje normal). |
| `cyclePolicy` | solo `"send_async"` | `"send_async"` | Política al detectar que esperar cerraría un ciclo (A espera a B y B espera a A): el mensaje se envía igualmente, sin esperar, y el resultado lleva `reason: cycle_detected`. Es el único valor permitido. |
| `pollEveryMs` | 100 – 5 000 | `250` | Período del sondeo de cada espera viva: comprobar si llegó la respuesta correlacionada o si el plazo se agotó. Bajarlo reduce la latencia de la respuesta a costa de más lecturas de la base de datos. |

### `limits` — tamaños y tasas

| Campo | Rango | Valor actual | Qué hace |
| --- | --- | --- | --- |
| `messageMaxBytes` | 256 – 65 536 | `8 192` | Tamaño máximo en bytes del cuerpo `message`. Un mensaje mayor se rechaza con `INVALID_INPUT` sin enviarse. |
| `replyQuoteMaxChars` | 100 – 8 000 | `1 200` | Longitud máxima (en caracteres) de la cita del mensaje original que se adjunta a la respuesta correlacionada. Mantiene el contexto de la respuesta sin duplicar cuerpos enormes. |
| `sendsPerMinutePerSession` | 1 – 1 000 | `30` | Máximo de mensajes **enviados** (no respuestas) por sesión por minuto. Al superarlo, el envío falla con `RATE_LIMITED`. |
| `repliesPerMinutePerSession` | 1 – 1 000 | `60` | Ídem para mensajes **enviados como respuesta** (`reply` no vacío): tasa separada para que una sesión que contesta mucho no bloquee sus avisos. |

### `delivery` — entrega y confirmación

| Campo | Rango | Valor actual | Qué hace |
| --- | --- | --- | --- |
| `admissionTimeoutMs` | 1 000 – 120 000 | `15 000` | Tiempo máximo para confirmar que el servidor admitió el mensaje (entrega al receptor). Si la confirmación no llega a tiempo, el envío resuelve `delivery_unknown` y el plugin sigue reconciliando en segundo plano (mismo ID de mensaje, sin duplicados). Debe ser ≤ `retryWindowMs`. |
| `retryBaseMs` | 100 – 60 000 | `1 000` | Base del backoff exponencial de re-entrega de mensajes sin admitir: 1 s → 2 s → 4 s → 8 s… (duplicado por intento, con tope). |
| `retryMaxMs` | 1 000 – 120 000 | `30 000` | Tope del backoff (debe ser ≥ `retryBaseMs` y ≤ `retryWindowMs`). |
| `retryWindowMs` | 1 000 – 3 600 000 (1 h) | `300 000` (5 min) | Ventana durante la que el plugin sigue re-entregando un mensaje sin admitir. Al agotarla, el mensaje queda `unknown` en la base para inspección manual. |

### `reload` — recarga en vivo

| Campo | Rango | Valor actual | Qué hace |
| --- | --- | --- | --- |
| `enabled` | booleano | `true` | Activa el watcher de esta carpeta. Con `false`, editar archivos no recarga nada (hasta que se reactive). |
| `debounceMs` | 100 – 10 000 | `500` | Debounce entre ediciones de archivos y la recarga efectiva. |

Reglas de validación adicionales: la relación
`retryBaseMs ≤ retryMaxMs ≤ retryWindowMs` y `admissionTimeoutMs ≤ retryWindowMs`
se comprueba entre campos; el bloque `<swarm>` renderizado debe caber en 256 KiB
(límite de una entrada de instrucción nativa).

## names.json

Array JSON de nombres; el **orden del archivo no importa**: la asignación es aleatoria
(Fisher–Yates sobre la lista, dentro de una transacción atómica, con la restricción de
unicidad `(scope, nombre)`). Reglas:

- 2–32 caracteres, solo letras/dígitos ASCII minúsculos, empezando por letra.
- Sin duplicados.
- Cada nombre se asigna **como mucho una vez por scope** y queda reservado para siempre
  (tumba), incluso si la sesión se archiva: no se recicla.
- Al agotar la lista, se usan sufijos numéricos (`abeja-2`, `abeja-3`, …) en el mismo
  orden aleatorio.

Contenido actual: **154 nombres**.

## swarm-prompt.md

Texto de instrucciones renderizado dentro del bloque `<swarm>` (elemento `<instructions>`, en inglés). Se limita a identidad
y peers: la semántica de uso de la herramienta (parámetros, resultados, esperas,
comportamiento de respuesta) vive en la descripción de la herramienta.

- La única variable permitida: `{{self_name}}` (cualquier otra `{{…}}` invalida el
  candidato).
- El bloque `<swarm>` renderizado debe caber en 256 KiB.

## tool-description.md

Descripción de `swarm` (en inglés) que ve el modelo junto a la herramienta:
parámetros, estados de resultado, esperas y normas de cortesía. Puede tener varias
líneas; solo se exige que no quede vacía tras recortar espacios.
