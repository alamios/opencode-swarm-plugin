# Configuración editable de Swarm

Los archivos de este directorio son ejemplos del contrato que debe implementar el plugin. No activan ninguna función hasta que el plugin esté construido e instalado. JSON y Markdown son suficientes: no se necesita evaluar `config.js` ni recompilar para editar los valores.

## Ubicación y carga

Mantener una configuración autoritativa por servidor, fuera del repositorio. Ubicación sugerida en Linux: `~/.config/opencode/swarm/`. Contiene `swarm.json`, `swarm.schema.json`, `names.json`, `swarm-prompt.md` y `tool-description.md`.

Las rutas `namesFile`, `promptFile` y `toolDescriptionFile` se resuelven respecto al archivo `swarm.json`, nunca respecto al cwd de una sesión. El instalador debe convertir rutas de bootstrap a absolutas para evitar ambigüedad con `~`.

Bootstrap propuesto en el archivo de configuración de OpenCode, adaptado por el implementador a la instalación real:

```json
{
  "plugins": [
    {
      "package": "/ruta/absoluta/al/plugin/swarm",
      "options": {
        "configPath": "/ruta/absoluta/config/swarm/swarm.json",
        "stateDirectory": "/ruta/absoluta/estado/swarm-servidor-local"
      }
    }
  ]
}
```

`configPath` y `stateDirectory` son opciones del plugin a implementar. La forma de registrar paquetes y opciones es la documentada para plugins v2; confirmar el formato en la versión instalada. Integrar esta entrada sin reemplazar otros plugins ni opciones existentes.

Todas las instancias de un servidor deben apuntar a los mismos archivos y almacén. El directorio de estado es un namespace persistente del servidor: no incluir PID ni puerto efímero en él. No compartirlo entre dos servidores OpenCode independientes. Rechazar intentos de mezclar configuraciones incompatibles en una misma autoridad de coordinación. No dejar que una configuración local de proyecto cambie silenciosamente el almacén compartido.

## Cambios habituales

**Esperar hasta 40 minutos:** cambiar `wait.timeoutMs` a `2400000`.

**Mantener compañeros disponibles una hora después de terminar:** cambiar `presence.idleGraceMs` a `3600000`.

**Cambiar el comportamiento explicado a los agentes:** editar `swarm-prompt.md`. Mantener la variable `{{self_name}}` si se quiere mostrar el nombre en el texto. El plugin también conserva `self_name` como campo estructurado, por lo que quitar la variable no elimina la identidad.

**Añadir animales:** editar el array de `config/names.json` del repositorio. Los nombres deben ser únicos, en minúsculas ASCII, sin espacios, de 2 a 32 letras. Los sufijos numéricos los administra el plugin.

**Modificar la descripción de la herramienta:** editar `tool-description.md`. Se aplica a las próximas instantáneas del catálogo; puede cambiar el prefijo de herramientas porque se ha editado deliberadamente una descripción, no por actividad de peers.

## Parámetros

| Parámetro | Valor inicial | Comportamiento |
| --- | --- | --- |
| `version` | `1` | Versión del contrato de configuración. |
| `enabled` | `true` | Habilita/deshabilita Swarm con la semántica de parada descrita en SPEC. |
| `namesFile` | `./names.json` | Lista de nombres editable. |
| `promptFile` | `./swarm-prompt.md` | Instrucciones de identidad y colaboración. |
| `toolDescriptionFile` | `./tool-description.md` | Descripción de `swarm`. |
| `presence.idleGraceMs` | `1800000` | 30 minutos de presencia tras idle; `0` permite mostrar solo activos/esperas vivas. |
| `presence.reconcileEveryMs` | `5000` | Reconciliación cada 5 segundos como respaldo a eventos. |
| `presence.publishDebounceMs` | `500` | Agrupa cambios rápidos antes de actualizar peers. |
| `presence.includeSubagents` | `false` | Sesiones raíz por defecto. |
| `wait.timeoutMs` | `1200000` | 20 minutos desde admisión confirmada. Acepta entre 1 segundo y 24 horas. |
| `wait.cyclePolicy` | `send_async` | Única política de v1: enviar sin esperar si se cierra un ciclo. |
| `wait.pollEveryMs` | `250` | Intervalo de comprobación interna de resultados si se necesita entre instancias. No son llamadas al modelo. |
| `limits.messageMaxBytes` | `8192` | Máximo del texto del usuario de la herramienta en UTF-8. |
| `limits.replyQuoteMaxChars` | `1200` | Máximo de puntos de código Unicode en la cita del original. |
| `limits.sendsPerMinutePerSession` | `30` | Cupo móvil de envíos nuevos por sesión. |
| `limits.repliesPerMinutePerSession` | `60` | Cupo independiente de respuestas correlacionadas. |
| `delivery.admissionTimeoutMs` | `15000` | Plazo para confirmar admisión, separado del timeout de respuesta. |
| `delivery.retryBaseMs` | `1000` | Base del backoff de reconciliación/admisión idempotente. |
| `delivery.retryMaxMs` | `30000` | Límite del backoff. |
| `delivery.retryWindowMs` | `300000` | Ventana inicial de recuperación automática de una admisión incierta. |
| `reload.enabled` | `true` | Observa los archivos para recargar sin recompilar. |
| `reload.debounceMs` | `500` | Espera breve tras cambios de archivos para evitar leer una escritura parcial. |

`retryWindowMs` limita intentos automáticos, no elimina mensajes que pueden haber sido admitidos. Al agotarse, conservar el estado incierto y la identidad para reconciliación posterior o diagnóstico. Nunca crear un ID nuevo para intentar de nuevo la misma invocación.

El límite superior aceptado por el schema no prueba que el runtime soporte esa espera. La validación de compatibilidad debe rechazar o explicar un timeout que supere un límite duro comprobado de la instalación. No acortarlo silenciosamente.

## Validación y recarga

1. Leer config y todos sus archivos referenciados como un candidato completo.
2. Validar con `swarm.schema.json`, las reglas de nombres, el formato del prompt y relaciones entre parámetros.
3. Validar que `retryBaseMs <= retryMaxMs <= retryWindowMs` y que `admissionTimeoutMs <= retryWindowMs`.
4. Permitir únicamente `{{self_name}}` como variable de plantilla; no ejecutar JavaScript ni expresiones. Rechazar variables desconocidas. Texto de nombres se escapa al renderizar.
5. Conservar los límites nativos de tamaño de entradas de instrucciones. Si el prompt no cabe, rechazar claramente o dividir de forma determinista en claves estables documentadas; nunca truncarlo en silencio.
6. Si todo es válido, intercambiar la configuración completa de forma atómica y actualizar watchers y publicaciones afectadas.
7. Si falla, conservar la última configuración válida y mostrar ruta/campo y motivo en logs administrativos, sin bloquear las sesiones ya funcionando.

En primer arranque no existe configuración anterior: fallar la activación de Swarm con diagnóstico accionable; no degradar todo OpenCode ni elegir defaults distintos en cada instancia. Los archivos incluidos son un ejemplo completo, no una colección de overrides parciales.

Las esperas capturan su timeout al comenzar; editarlo no amplía ni acorta deadlines existentes. El prompt recargado usa entradas incrementales en el siguiente límite. Cambiar el orden/lista de animales solo afecta a nuevas asignaciones; las anteriores y sus reservas persisten. Los cambios de límites aplican a nuevas admisiones. Desactivar requiere terminar las esperas y retirar entradas propias de forma controlada.

Si `reload.enabled=false`, aplicar cambios al reiniciar/recargar el plugin según la instalación. Documentar cómo hacerlo sin asumir un comando no verificado. El directorio de estado es una opción de bootstrap y cambiarlo requiere una migración/reinicio explícitos, no recarga en caliente.
