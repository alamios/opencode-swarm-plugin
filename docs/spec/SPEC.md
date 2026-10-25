# Swarm — especificación funcional y técnica

Versión 1.0 · 24 de octubre de 2026

Este documento define el plugin a implementar. Las capacidades documentadas se referencian en `SOURCES.md`; el resto son requisitos del producto y decisiones propuestas de ingeniería. La versión instalada de OpenCode debe verificarse antes de escribir la integración. La implementación vigente de este documento vive en la raíz del repositorio (`server.ts`, `src/`); la evidencia de validación está en `docs/VALIDATION.md`.

## 1. Resultado esperado

Varias sesiones independientes de un mismo servidor OpenCode colaboran en un checkout. Cada sesión conoce su nombre de animal y los nombres de sus compañeros. Puede enviar un mensaje, responder a otro y, opcionalmente, esperar una respuesta crítica. El usuario no ejecuta altas ni registros. La única herramienta expuesta al modelo es `swarm`.

Otros proyectos y otros checkouts del servidor quedan separados. No se envían títulos de sesiones, tareas, roles ni resúmenes. La lista de presencia no fluctúa por cada transición entre generar texto y usar herramientas. No se implementan broadcast, reservas de archivos, asignación de tareas, elección de un líder ni coordinación entre servidores.

## 2. Identidad y ámbito

La entidad de colaboración es una sesión, no un tipo de agente o un modelo. Obtener la sesión emisora del contexto real de la herramienta; ningún argumento permite suplantarla.

Definir `scopeKey` a partir de la identidad del servidor, el proyecto y el checkout/worktree. La identidad del servidor debe ser **estable entre reinicios**: el campo `id` del registro de servicio es un UUID nuevo en cada arranque y no sirve; usar la ruta canónica del registro de servicio. Resolver desde la sesión actual, no desde un `ctx.location` capturado al cargar el plugin. Usar los identificadores de OpenCode cuando se correspondan con este ámbito; para rutas, usar resolución absoluta y canónica del servidor. Los subdirectorios de un mismo checkout pertenecen al mismo ámbito; un worktree distinto no. Para directorios sin VCS, usar la raíz de workspace explícita de OpenCode, sin unir arbitrariamente por ancestros o prefijos de texto.

Asignar nombres desde `names.json` en orden aleatorio (barajado Fisher–Yates con fuente de aleatoriedad inyectable para tests; el orden del archivo no importa), con una operación atómica y restricción de unicidad `(scopeKey, name)`. La sesión conserva el nombre al reiniciar, cambiar de modelo o compactar. Al agotar la lista, usar sufijos numéricos (`abeja-2`, etc.). Un nombre asignado queda reservado y no se recicla para otra sesión, aunque la original se archive. Conservar un tombstone de asignación. No usar nombres como claves primarias de mensajes: persistir los IDs reales de emisor y receptor.

Si una sesión se mueve, invalidar su presencia en el ámbito anterior y asignar/reutilizar su identidad del ámbito nuevo. El nombre anterior continúa reservado. Volver al ámbito original restaura la asignación anterior. Revalidar el ámbito al admitir un envío y antes de despachar una entrega que haya permanecido pendiente. Un fork recibe una identidad propia, aunque herede historial o entradas de instrucciones: corregir las entradas heredadas antes de usar Swarm.

Por defecto solo participan sesiones raíz. `includeSubagents=true` permite inscribir también sesiones hijas; nunca incluir llamadas auxiliares para títulos o resúmenes como si fueran nuevos compañeros.

## 3. Presencia automática

Una sesión es descubrible si Swarm está habilitado para ella y cumple alguna condición:

- Está ejecutándose, incluyendo esperas de herramientas o interacciones que OpenCode clasifique como activas.
- Terminó su ejecución hace menos de `presence.idleGraceMs`.
- Tiene una espera Swarm viva, aunque una señal del runtime no la clasifique como activa.

La presencia comienza con actividad real. Cargar o listar una sesión guardada no la inscribe como disponible. En el arranque del plugin, reconciliar sesiones ya activas y registros recientes persistidos; no inscribir todo el historial ni todos los timestamps `updated`.

Usar eventos públicos como señales y una reconciliación periódica como reparación. Confirmar la forma real de los eventos en la instalación. Un único coordinador lógico publica cada ámbito; varias instancias del plugin no pueden producir registros divergentes. Paginar todas las lecturas. No crear runtimes de proyectos históricos únicamente para averiguar si están presentes.

Una consulta fallida deja el estado como desconocido; no elimina en masa compañeros. No renovar presencia por consultar, publicar instrucciones o recibir un evento generado por la propia publicación. Una herramienta larga no caduca por falta de actividad textual. Al observar idle, registrar el instante real o el mejor límite conservador disponible; a partir de ahí corre la gracia.

Archivar/eliminar o mover una sesión la quita del ámbito. Una interrupción explícita del usuario marca el destinatario como suspendido para evitar que un envío pendiente lo reactive contra esa intención. La siguiente reanudación explícita de su trabajo puede rehabilitarlo. Distinguir esta acción de una cancelación aislada de herramienta. Documentar qué señales permiten comprobarlo; no simular esta garantía si el runtime no las ofrece.

Los peers anunciados son disponibles, no necesariamente ocupados. Solo se publican nombres, en orden estable. La propia sesión queda excluida. El plugin revalida al enviar porque la instantánea puede haberse quedado obsoleta.

## 4. Instrucciones incrementales

Publicar una única entrada administrada por la API de instrucciones de sesión, con valor en texto plano (el core renderiza cadenas tal cual, dentro de su propio wrapper `<context key="swarm">`):

| Clave | Valor propuesto |
| --- | --- |
| `swarm` | Bloque `<swarm>` con `<identity>garza</identity>`, `<peers>nutria, zorro</peers>` (solo nombres, orden estable) y `<instructions>` con el Markdown renderizado. |

El plugin escribe valores completos; la sincronización incremental es responsabilidad de OpenCode. Persistir la última representación canónica/hash publicado. Escribir solo cuando cambia, agrupando ráfagas con `publishDebounceMs`. No publicar horas, lastSeen, contadores, títulos ni estados busy/idle. Publicar una lista vacía cuando no quedan compañeros.

Usar la API de entradas duraderas en lugar de reescribir el prefijo dinámico en `context`. Mantener el estado actualizado desde el coordinador. El hook `context` no debe convertirse en un segundo mecanismo de inserción. No asumir que un PUT efectuado en ese hook entra en la misma petición, porque la sincronización puede haber ocurrido antes.

En el primer prompt, registrar identidad y entradas mediante el punto de integración más temprano soportado. Para una sesión ya activa, aceptar que el primer refresco llegue al siguiente límite de paso. Antes de exponer una herramienta invocable, el emisor debe poder resolver su propia identidad de forma segura. Un nuevo compañero aparece como máximo después de reconciliación/debounce y el siguiente límite de ejecución disponible; no se garantiza modificación de una petición ya enviada al proveedor.

Después de compactar, verificar que los valores actuales siguen presentes y que los peers retirados no quedan como estado vigente. Después de revertir, reconciliar entradas. Después de fork, reemplazar la identidad heredada. Eliminar las entradas propias al deshabilitar Swarm. No tocar AGENTS.md ni instrucciones de otros plugins.

## 5. Herramienta única y salida

Nombre: `swarm`, una sola palabra como las herramientas integradas (sin namespace). Entrada exacta en `contracts/swarm.input.schema.json`:

```ts
type SendInput = {
  name: string
  message: string
  reply_to?: string
  wait_for_reply?: boolean // false
}
```

Validar texto no vacío tras comprobar espacios, bytes UTF-8, nombre y tipo. El SDK puede adaptar el dialecto JSON Schema necesario para el modelo, sin cambiar el contrato. No pedir al modelo IDs de sesión, proyecto, clave de idempotencia, timeout ni modo de entrega.

Resultados propuestos (objetos JSON serializados en el formato de contenido de herramienta que requiera el SDK):

```ts
type Result =
  | { status: "accepted"; id: string; name: string;
      waiting: false; reason?: "cycle_detected"; detail?: string }
  | { status: "replied"; id: string; name: string;
      waiting: false;
      response: { id: string; from: string; reply_to: string; message: string } }
  | { status: "timeout"; id: string; name: string;
      waiting: false; detail: string }
  | { status: "delivery_unknown"; id: string; name: string;
      waiting: false; detail: string }
  | { status: "error"; code: string; detail: string; peers?: string[] }
```

`status: "accepted"` confirma admisión por OpenCode, o persistencia confirmada en el canal de respuesta de una espera viva. No significa leído; no inventar un campo booleano redundante. Un error previo a admisión no crea silenciosamente un envío. Los errores ajenos al ámbito no deben revelar datos de otros proyectos.

Códigos mínimos: `INVALID_INPUT`, `PEER_UNAVAILABLE`, `OUT_OF_SCOPE`, `SELF_SEND`, `INVALID_REPLY`, `RATE_LIMITED`, `CONFIG_ERROR`, `UNSUPPORTED_RUNTIME`, `IDEMPOTENCY_CONFLICT`. Mantener aparte los errores/cancelaciones de permisos nativos que deban propagarse al runtime.

## 6. Mensaje, IDs y correlación

Generar un ID opaco compatible con `Session.Message.ID` antes de la admisión. Ese es el ID público lógico del mensaje: el mismo aparece en el acuse al emisor, el sobre visible al destinatario, `reply_to` y los registros. No utilizar un prefijo inventado si la versión no lo admite. Ejemplos `m1` y `m2` de esta documentación son ilustrativos, no IDs válidos del SDK.

Persistir un sobre:

```ts
type Envelope = {
  protocol: "swarm/v1"
  id: string
  scopeKey: string
  fromSessionID: string
  toSessionID: string
  fromName: string
  toName: string
  message: string
  reply?: string
  createdAt: string
}
```

En una entrega asíncrona, usar mensaje sintético con `delivery:"steer"`, `resume:true`, texto legible y metadatos de sobre. Conservar el texto del agente como contenido, sin transformarlo en instrucciones de sistema. El texto visible es un único objeto JSON con `from`, `to`, `id`, `message` y — en respuestas — `reply_to` más una cita del original limitada por `replyQuoteMaxChars`, marcada como truncada. Los campos fijos nunca se derivan del contenido del peer, así el cuerpo no puede suplantarlos.

El remitente conoce su ID por el resultado de `swarm`. El receptor lo conoce por el sobre visible. Una respuesta recibe su propio ID y apunta al original en `reply_to`. Validar en almacenamiento que el original fue dirigido a la sesión que responde, que `name` identifica al autor original y que ambos siguen en el ámbito autorizado. No correlacionar por parecido de texto ni por el último mensaje de un nombre.

Responder a una pregunta ya emitida puede ser válido aunque el emisor haya salido de la ventana normal de presencia: permitir una respuesta correlacionada a su identidad persistente si sigue en el mismo ámbito, no está archivado/eliminado/suspendido y Swarm sigue habilitado. Esto hace posibles respuestas tardías; no habilita nuevos mensajes arbitrarios a sesiones históricas. Los envíos nuevos sí requieren disponibilidad actual.

## 7. Espera opcional

Con `wait_for_reply:false`, esperar solo la admisión y devolver. Con `true`, esperar la primera respuesta explícitamente correlacionada. No interpretar texto ordinario de B, una finalización de su turno o `session.wait` como respuesta.

Registrar una reserva de espera antes de despachar el mensaje, para no perder una respuesta rápida. La reserva ya participa en el grafo de dependencias. Al confirmar admisión, comienza el timeout de respuesta usando el valor de configuración capturado para esa llamada. Si una respuesta llega durante la reserva, almacenarla y resolver cuando corresponda. Si fracasa definitivamente la admisión, retirar la reserva.

Separar el plazo corto de admisión (`admissionTimeoutMs`) del largo de respuesta (`wait.timeoutMs`, inicialmente 20 minutos). Si la admisión queda incierta y se devuelve `delivery_unknown`, abandonar la espera de herramienta, conservar la reconciliación del envío y entregar cualquier respuesta posterior de forma asíncrona.

Esperar sin bloquear el event loop ni mantener una transacción abierta. Usar una promesa/señal y, cuando sea necesario entre instancias, lectura acotada de estados duraderos. El polling interno no es una herramienta del modelo ni genera prompts. Integrar la señal de cancelación del runtime. No permitir que esperas canceladas sigan figurando como aristas.

Al recibir una respuesta a una espera viva, el coordinador la persiste y resuelve directamente el resultado de la herramienta de A. No depende de que A ejecute otra llamada al modelo. En funcionamiento normal, el mismo cuerpo no se entrega además como mensaje sintético en A.

Timeout y respuesta compiten en una transición atómica: solo uno gana. Si gana respuesta, devolver `replied`; si gana timeout, devolver `timeout` y enviar la respuesta por el canal asíncrono. En ningún caso el timeout retira la pregunta ya admitida. Respuestas adicionales al mismo original son asíncronas, con su correlación intacta.

Si una invocación que responde también solicita esperar, primero registrar/resolver la respuesta que satisfaga una espera anterior y después evaluar la nueva dependencia, dentro de una transición coherente. Evitar falsos ciclos debidos a una arista que ya quedó satisfecha.

## 8. Detección atómica de ciclos

El grafo es por ámbito. Nodos: IDs de sesión. Una arista `A → B` corresponde a una invocación viva de A que espera una respuesta de B, incluyendo reservas aún en admisión. Puede haber varias invocaciones entre los mismos nodos; al cerrar una, no borrar las demás.

Para añadir `A → B`, comprobar si ya existe un camino `B → ... → A`. Si existe, no añadir la arista y enviar asíncronamente. Devolver `accepted`, `waiting:false`, `reason:"cycle_detected"` y una explicación. La pregunta sí se envía. Para un ciclo largo, describir los nombres implicados si siguen en el ámbito.

```text
transacción / sección crítica compartida por todas las instancias:
  recuperar operaciones terminales y expiradas
  si esta invocación ya existe: devolver/reconectar su estado
  persistir la intención del mensaje con su ID estable
  si se pidió espera:
    si hay camino del receptor al emisor:
      marcar envío asíncrono por ciclo
    si no:
      insertar reserva de espera y arista
commit
despachar fuera de la transacción
```

Comprobación y alta deben tener una única autoridad transaccional. Dos mutex de instancias diferentes no sirven. La búsqueda abarca todos los waits del ámbito, no solo la sesión actual. No mantener el lock durante red ni espera. Al resolver, fallar, cancelar, agotar plazo, deshabilitar o perder al propietario de una invocación, retirar su arista.

Esto evita ciclos de espera entre llamadas Swarm. No garantiza que el receptor responda ni elimina bloqueos externos a Swarm. Mantener timeout y cancelación como salidas obligatorias.

## 9. Coordinación y persistencia

Separar el adaptador OpenCode de una biblioteca de dominio sin dependencia del modelo. Módulos recomendados: `plugin`, `adapter`, `scope`, `presence`, `instructions`, `identity`, `messages`, `waits`, `coordinator`, `config` y `store`.

Usar un almacén transaccional del plugin, fuera del repositorio y de las tablas internas de OpenCode. SQLite con transacciones cortas e índices únicos es la opción de referencia si el runtime lo permite. Verificar driver y filesystem disponibles. `ctx.storage.get/set` no puede asumirse transaccional ni compartido entre ubicaciones sin evidencia.

Debe existir una única base autoritativa para todas las instancias del mismo servidor. Si el runtime las aísla, sincronizar mediante la base y un coordinador con ownership/lease, o un mecanismo compartido soportado. No depender de un singleton de módulo o `globalThis` sin demostrar que todas las instancias comparten ese espacio. Rechazar una configuración incompatible en lugar de crear silenciosamente varios grafos independientes.

Datos mínimos y restricciones:

| Registro | Información y unicidad |
| --- | --- |
| `identities` | `(scopeKey,sessionID)`, nombre, tombstone; único `(scopeKey,name)`. |
| `presence` | ámbito actual, ejecución, instante idle, suspensión, última reconciliación válida. |
| `messages` | sobre inmutable, clave de invocación única, hash de entrada, estado, ID de entrega. |
| `waits` | ID de invocación, mensaje esperado, emisor/receptor, reserva/espera/terminal, deadline y respuesta elegida. |
| `delivery_outbox` | admisiones pendientes, reintentos, fallo y confirmación; no reemplaza el inbox de OpenCode. |
| `instruction_state` | versión deseada y última confirmada por sesión/clave para reintentar publicaciones. |
| `owners` | identidad y vigencia de ejecutores/coordinadores; distinguir recarga de una segunda instancia viva. |

Identificar un reintento de herramienta mediante la identidad real de sesión, mensaje del asistente e invocación. No deduplicar por texto. El mismo ID de invocación con distinta entrada es conflicto. Persistir el ID antes de llamar a OpenCode y reusar ese ID en cada reintento de admisión. El adaptador comprobará la idempotencia real del servidor.

Retener mensajes necesarios para citas y correlación, identidades y estados de reintento. La limpieza automática destructiva de este almacén no forma parte de v1; documentar ubicación y procedimiento manual de respaldo. Logs ordinarios solo con IDs, nombres, duraciones y códigos; los cuerpos permanecen en el almacén necesario para la función.

## 10. Reinicios, cancelaciones y garantías

Una promesa pendiente no sobrevive a la caída del proceso. Un reinicio no recrea una espera ficticia. Recuperar intenciones pendientes y retirar únicamente las aristas cuyo propietario ya no esté vivo. Una respuesta a una espera abandonada pasa al canal asíncrono cuando el destinatario permita reanudación. La identidad permanece.

Persistir la respuesta antes de despertar la promesa. Confirmar después, mediante señal/lectura del runtime, si el resultado de herramienta quedó duradero. Si el proceso cae entre ambos hechos, reconciliar la llamada concreta antes de enviar una entrega de recuperación. Nunca perder una respuesta por marcarla entregada solo porque se resolvió una promesa en memoria.

Si la versión no permite confirmar esa persistencia, elegir recuperación que priorice no perder la respuesta, con ID estable y posible duplicación visible identificable. Documentar esa ventana; no prometer exactly-once entre la base del plugin y la de OpenCode. En funcionamiento normal y carreras de timeout, sí se exige una única ruta de entrega. Una garantía más fuerte ante caídas requiere evidencia del adaptador.

Una cancelación termina la espera y elimina la arista. No retira una pregunta ya admitida. Si el usuario ha detenido explícitamente la sesión, guardar la respuesta para una futura reanudación autorizada, sin despertarla automáticamente. Deshabilitar Swarm termina esperas con resultado explicativo, despublica entradas y detiene nuevos envíos; conserva identidades y pendientes para inspección/recuperación. No abortar el trabajo ajeno.

Un movimiento concurrente puede ocurrir entre validación y admisión. Revalidar antes de despachar y usar guards nativos si existen. Sin una operación atómica de OpenCode que ligue ámbito y admisión no puede garantizarse aislamiento absoluto durante ese intervalo; comprobarlo y documentarlo. No presentar el plugin como frontera de seguridad frente a agentes con acceso general al servidor.

## 11. Configuración y permisos

El contrato completo está en `CONFIGURATION.md` y su schema. El usuario debe editar parámetros, nombres e instrucciones sin recompilar. Las recargas inválidas conservan íntegra la configuración anterior. Las esperas ya abiertas conservan su deadline; los cambios afectan a nuevas llamadas. Cambiar nombres no renombra asignaciones existentes.

El límite de tamaño se aplica al texto UTF-8, no al número de caracteres. Las citas se limitan por puntos de código Unicode, con un límite superior de bytes impuesto por el adaptador. Las respuestas tienen un cupo separado para que una ráfaga de preguntas no impida contestar a una espera.

Respetar las reglas de permisos de OpenCode y preparar una configuración de uso que permita esta colaboración dentro del ámbito. No sobrescribir políticas del usuario para forzarla. Solo las instrucciones configuradas por el usuario y los datos de identidad validados se tratan como instrucciones; el cuerpo de un peer no se introduce como entrada privilegiada.

## 12. Plan de implementación y entrega

1. Inspeccionar la instalación, registrar versiones y validar capacidades de `SOURCES.md`. Confirmar instrucciones incrementales y límite efectivo de espera de herramientas.
2. Implementar almacén, ámbito, nombres y configuración con tests del dominio.
3. Implementar presencia automática y entradas incrementales; probar A/B/C sin mensajes.
4. Implementar envío asíncrono, IDs y respuestas con cita; comprobar reintentos.
5. Implementar reserva de espera, grafo transaccional, resolución y timeout; probar concurrencia con reloj controlado.
6. Integrar cancelación, recarga, recuperación y límites. Probar instancia múltiple del plugin.
7. Ejecutar `ACCEPTANCE.md` con un proveedor simulado para casos deterministas y con sesiones reales de prueba para integración.
8. Entregar código, lockfile, guía, configuración editable, resultados y ZIP instalable. Explicar cualquier gate no satisfecho y su causa concreta.

No dar por completada la función por pasar tests de una implementación simulada: la evidencia debe cubrir también OpenCode real, especialmente la duración de herramientas y el orden de actualización de instrucciones.
