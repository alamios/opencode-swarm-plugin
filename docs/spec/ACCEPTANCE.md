# Validación y criterios de aceptación

Ejecutar tests deterministas del dominio y una demostración integrada. Un mock que reproduzca solo nuestras suposiciones no prueba la compatibilidad con OpenCode. Reportar versión exacta, sistema operativo, runtime, SDK y modo de carga de plugins.

## 1. Gates previos de integración

| ID | Comprobación | Evidencia necesaria |
| --- | --- | --- |
| G01 | Plugin v2 y contexto de invocación | Herramienta registrada una vez; identidad real del invocante disponible. |
| G02 | Ámbitos | Dos subdirectorios del mismo checkout coinciden; otro worktree no coincide. |
| G03 | Entradas incrementales | Captura de solicitudes antes/después de cambiar la lista de peers (entrada `swarm`): prefijo anterior estable y actualización cronológica. |
| G04 | IDs de admisión | Repetir admisión con mismo ID no genera dos mensajes; ID visible y acuse coinciden. |
| G05 | Espera larga | Una herramienta de prueba supera 60 segundos y permanece viva hasta el plazo configurable comprobado; ensayo de 20 minutos para el default. |
| G06 | Cancelación | Interrumpir herramienta termina espera y limpia arista; detener sesión no se revierte por Swarm. |
| G07 | Instancias múltiples | Dos instancias comparten autoridad, nombres, grafo y entrega; no hay dos suscripciones con efectos duplicados. |
| G08 | Persistencia de resultados | Identificar la señal/lectura que confirma un resultado de herramienta o documentar recuperación con posible duplicación identificable. |

Para G03 usar un proveedor de prueba que capture peticiones sin imprimir secretos. Variaciones ajenas a Swarm (fecha, herramientas o modelo) deben controlarse. Medir caché real cuando el proveedor exponga métricas, pero no hacer depender la prueba estructural de que la caché externa esté caliente. La inyección tiene que reaparecer correctamente tras compactar.

Para G05 combinar test del timeout con reloj simulado y una prueba real del ciclo de vida de herramienta. Acelerar un reloj no sustituye la comprobación del límite real del runtime. Si existe un límite menor, encontrar una integración soportada o declarar el requisito bloqueado; no llamar «20 minutos» a una espera truncada a dos minutos.

## 2. Identidad, presencia y contexto

| ID | Caso | Resultado esperado |
| --- | --- | --- |
| P01 | A y B empiezan en el mismo checkout | Nombres diferentes y estables sin herramientas de registro. |
| P02 | C trabaja en otro proyecto | Ni A ni B ven su nombre. |
| P03 | D es una sesión histórica | No aparece por el mero listado ni recibe nuevos mensajes. |
| P04 | 50 altas simultáneas con 48 animales | Sin colisiones; aparecen sufijos al agotar lista. |
| P05 | Reinicio/compactación/cambio de modelo | Conserva nombre y no reasigna un nombre ocupado. |
| P06 | Se elimina o reordena un animal en config | Las identidades existentes no cambian. |
| P07 | Dos herramientas largas de A y B | No desaparecen por falta de generación de texto. |
| P08 | B acaba su turno | Sigue presente durante gracia; no se publica busy/idle en cada transición. |
| P09 | Vence gracia de B | Peers actualizado; una nueva pregunta a B falla de forma explícita. |
| P10 | Falla consulta de actividad | No se anuncia una salida masiva ni se inventa idle. |
| P11 | B cambia de workspace | Sale del anterior; registro nuevo correcto y revalidación de envíos. |
| P12 | Ruta por enlace simbólico/subdirectorio | Misma identidad canónica cuando procede. |
| P13 | Siguiente worktree del mismo repo | Aislamiento por defecto. |
| P14 | Nombre de proyecto comparte prefijo de ruta | No se mezcla por startsWith. |
| P15 | Se repite publicación sin cambios | No se escribe otra actualización ni cambia el prompt. |
| P16 | Cambia título de una sesión | Ningún título aparece en contexto, mensaje, descripción de herramienta ni logs de descubrimiento. |
| P17 | Se compacta después de retirar a B | Identidad propia y lista vigente, sin resucitar peers retirados. |
| P18 | Fork de A | Nueva identidad; no usa la identidad heredada de A. |
| P19 | Llegan eventos duplicados/desordenados | Reconciliación estable, sin renovaciones de presencia por publicaciones propias. |
| P20 | Recarga con sesiones ya ejecutándose | Las descubre y publica en el siguiente límite disponible. |

## 3. Envíos y replies

| ID | Caso | Resultado esperado |
| --- | --- | --- |
| M01 | A envía sin espera | Obtiene ID; no aguarda a B. |
| M02 | B recibe | Ve un objeto JSON con `from`, `id` y `message`, sin necesitar acceso a metadatos ocultos. |
| M03 | B responde con `reply_to` correcto | A recibe correlación y cita real del original. |
| M04 | B inventa `reply_to` o destinatario distinto | `INVALID_REPLY`, no se envía. |
| M05 | A compacta antes de la respuesta | La cita permite entender el mensaje original. |
| M06 | Misma invocación reintentada | Mismo ID y resultado reconciliado; no otra entrega. |
| M07 | Dos invocaciones nuevas con texto idéntico | Dos mensajes distintos; no deduplicar por texto. |
| M08 | Respuesta tardía tras gracia | Se permite la correlacionada si el autor sigue en el ámbito y no está suspendido/archivado. |
| M09 | Respuesta a sesión movida o detenida | No se despierta ni cruza ámbito; se informa o retiene según estado. |
| M10 | Nombre inválido o autoenvío | Error estructurado; no resolver a un destinatario parecido. |
| M11 | Unicode y delimitadores en mensaje | Respeta bytes y render seguro; no crea encabezados falsos. |
| M12 | Cupo de preguntas agotado | Una respuesta válida usa su cupo separado. |

## 4. Esperas y concurrencia

| ID | Caso | Resultado esperado |
| --- | --- | --- |
| W01 | A espera y B responde | Una única respuesta como resultado de la herramienta de A, sin copia sintética normal. |
| W02 | Respuesta antes del retorno de admisión | La reserva la captura; no se pierde. |
| W03 | No hay respuesta | Timeout configurable; pregunta sigue admitida y arista desaparece. |
| W04 | La respuesta llega después del timeout | Entrega asíncrona con el mismo `reply_to` y cita. |
| W05 | Reply y timeout simultáneos | Una única transición/ruta ganadora; nunca ambas ni ninguna. |
| W06 | A espera a B; B pregunta a A con espera | B envía asíncrono con `cycle_detected`; A no queda en un ciclo. |
| W07 | A→B y B→A simultáneos | Como máximo una de las dos esperas se registra. |
| W08 | A→B, B→C, C→A | La última arista se rechaza; el mensaje sí se envía. |
| W09 | A→B y C→B | Ambas esperas son válidas; no confundir compartir destinatario con ciclo. |
| W10 | Dos waits A→B y uno termina | La otra arista lógica sigue existiendo. |
| W11 | Se contesta y se pide respuesta a la vez | Se resuelve la dependencia satisfecha antes de evaluar la nueva. |
| W12 | Dos respuestas al mismo mensaje | La primera satisface wait; la siguiente llega asíncrona. |
| W13 | Cancelación durante espera | Limpieza del waiter/arista; no borrar pregunta admitida. |
| W14 | Error definitivo de admisión | No deja reserva fantasma. |
| W15 | Config cambia timeout durante wait | Deadline original intacto; próxima llamada usa nuevo valor. |
| W16 | Reloj de pared cambia | Espera viva usa tiempo monotónico; persistencia/deadline se reconcilian sin ciclo infinito. |
| W17 | Dos instancias detectan ciclo a la vez | Decisión serializable en una misma autoridad transaccional. |
| W18 | Emisor está ocupado en una herramienta Swarm | Su respuesta resuelve por coordinador, sin esperar a que procese otro prompt. |

Repetir W05 y W07 con barreras controladas y muchos interleavings, no con sleeps aleatorios como única evidencia. Verificar el grafo después de cada transición terminal.

## 5. Caídas y recarga

Inyectar fallos justo después de persistir intención, después de admisión remota pero antes de guardar acuse, después de persistir reply, después de resolver promesa pero antes de persistir resultado de herramienta y al vencer timeout. Reiniciar/reconciliar y comprobar que se conservan IDs y mensajes. Documentar la ventana de duplicación si falta confirmación de persistencia de herramienta.

Probar también: config inválida retiene anterior; nombre duplicado invalida recarga; prompt con variable desconocida se rechaza; cambio de archivos referenciados actualiza watchers; deshabilitar limpia entradas y waits; reactivar no duplica suscripciones; una segunda instancia viva no elimina waits de la primera como si fueran huérfanos; estado en disco permanece fuera del repositorio.

## 6. Demostración final

Usar sesiones de prueba A y B en un checkout temporal y C en otro. Sin registrar peers manualmente, demostrar nombres y descubrimiento. Enviar aviso, pregunta con espera, respuesta con cita y pregunta cruzada que degrade por ciclo. Compactar A y demostrar que una respuesta posterior sigue siendo comprensible. Recargar el prompt y timeout desde archivos. Reiniciar con una entrega pendiente y explicar el resultado. Mostrar que C permanece aislada durante todo el flujo.

## 7. Informe de entrega

Entregar `VALIDATION.md` con versión exacta probada, casos aprobados/fallidos/no ejecutados, comandos reproducibles, tiempos relevantes y limitaciones concretas. Distinguir tests simulados de integración real. No marcar un caso aprobado solo por inspección del código. Adjuntar guía de instalación/actualización/desactivación y ZIP de la implementación, además de los archivos editables.
