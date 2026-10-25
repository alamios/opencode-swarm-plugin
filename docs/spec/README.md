# Especificación de diseño — paquete original

Versión del diseño: 1.0 · 24 de octubre de 2026.

Esta carpeta conserva la especificación normativa original desde la que se implementó el
plugin: requisitos funcionales y técnicos, criterios de aceptación, contrato de
configuración, fuentes verificadas y el contrato de entrada de la herramienta. La
implementación vigente vive en la raíz del repositorio (`server.ts`, `src/`) y la
configuración editable en vivo, en `config/` (referencia completa en `config/README.md`).

## Contenido

| Archivo | Uso |
| --- | --- |
| `SPEC.md` | Arquitectura, comportamiento, contratos y algoritmos. |
| `ACCEPTANCE.md` | Casos de aceptación, concurrencia, recuperación y demostración final. |
| `CONFIGURATION.md` | Qué puede editar el usuario y cómo se aplica. |
| `SOURCES.md` | Fuentes oficiales, capacidades verificadas y validaciones pendientes. |
| `contracts/swarm.input.schema.json` | Contrato de entrada de la herramienta (espejo de `INPUT_SCHEMA` en `server.ts`). |

La configuración de ejemplo del paquete original (48 nombres, gracia de 30 min) fue
sustituida por la configuración vigente del repositorio; no se conserva copia duplicada.
