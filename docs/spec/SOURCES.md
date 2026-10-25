# Fuentes y límites de verificación

Consultadas el 24 de octubre de 2026. Las páginas y la rama `dev` pueden cambiar. Registrar la versión/commit instalado y sus tipos antes de implementar. Los contratos `swarm_*` de este paquete son decisiones del diseño, no API nativa de OpenCode.

## Capacidades documentadas

1. [Plugins v2](https://dev.opencode.ai/v2/docs/build/plugins): `Plugin.define` de `@opencode/plugin`; herramientas mediante transforms; contexto del invocante; suscripción pública a eventos; hook `context` sobre peticiones ensambladas. La ubicación de la instancia del plugin no identifica necesariamente la ubicación actual de todas las sesiones. El hook modifica la petición, no el historial persistido.
2. [API v2](https://dev.opencode.ai/v2/docs/api): listado paginado de sesiones, actividad del proceso, consulta de una sesión, entradas de instrucciones por sesión y admisión de mensajes sintéticos. La admisión sintética acepta ID, texto, metadatos, `delivery` y `resume`, y devuelve una entrada con ID. Las entradas de instrucciones se actualizan en un límite de paso.
3. [Contrato de sesiones v2](https://github.com/anomalyco/opencode/blob/dev/specs/v2/session.md): separación de admisión y ejecución; idempotencia de entradas por ID; entrega `steer`/`queue`; valores de instrucciones con hashes, base de época y actualizaciones cronológicas. La compactación establece una nueva base.
4. [Instrucciones v2](https://dev.opencode.ai/v2/docs/instructions/): actualizaciones de instrucciones ambientales antes de la siguiente petición, incluidas instrucciones administradas mediante API. Los AGENTS anidados descubiertos durante lecturas tienen reglas distintas; no basar el plugin en modificar esos archivos.

## Endpoints que debe comprobar el adaptador

| Operación | Ruta documentada |
| --- | --- |
| Listar sesiones | `GET /api/session` |
| Consultar actividad | `GET /api/session/active` |
| Obtener sesión | `GET /api/session/{sessionID}` |
| Admitir mensaje sintético | `POST /api/session/{sessionID}/synthetic` |
| Añadir/reemplazar instrucciones | `PUT /api/experimental/session/{sessionID}/instructions/entries/{key}` |
| Quitar instrucciones | `DELETE /api/experimental/session/{sessionID}/instructions/entries/{key}` |

No fijar una firma TypeScript de `instructions.entry.put` sin consultar los tipos de la versión instalada. La ruta HTTP es el punto de referencia si el cliente del plugin no expone un wrapper compatible. Respetar autenticación y dirección del servidor suministradas por OpenCode; no asumir puerto ni leer secretos ajenos a esa conexión.

## No verificado en una ejecución real aquí

- Versión concreta, runtime y proceso/aislamiento de las instancias del plugin del usuario.
- Señales exactas del ciclo de vida que identifican actividad, parada, movimientos y resultados de herramientas.
- Orden de sincronización de instrucciones, hooks y admisión de mensajes.
- Render de un valor JSON de instrucciones y límites por entrada.
- Garantía de que una herramienta puede permanecer pendiente 20 minutos sin un timeout menor del runtime.
- Acceso a persistencia transaccional y coordinación compartida entre instancias.
- Disponibilidad de una señal o lectura que confirme que un resultado de herramienta fue persistido.
- Normalización real de project/workspace/worktree y comportamiento de directorios sin VCS.
- Caché efectiva del proveedor. Preservar prefijos facilita la reutilización, pero no demuestra por sí solo un cache hit ni coste cero.

La detección de ciclos, los nombres, la presencia y la espera de respuestas son responsabilidades del nuevo plugin. No son garantías atribuidas a OpenCode.
