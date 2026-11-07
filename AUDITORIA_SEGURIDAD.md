# Auditoría de seguridad y resistencia del flujo — DepositoAPP v10

Revisión del código, de la base de datos (Supabase) y de los flujos de la aplicación. Se ejecuta de forma automática con `node scripts/check.mjs`.

## Lo que ya estaba bien
- **Base de datos cerrada por defecto**: ninguna tabla se puede modificar desde la app; solo se lee con políticas RLS y todo cambio pasa por funciones del servidor que validan quién es la persona y qué permiso tiene.
- Las 51 funciones públicas revisadas validan identidad o permiso (la única excepción, `bootstrap_principal`, está bloqueada para usuarios y solo se ejecuta desde el SQL Editor).
- Las funciones internas (`_audit`, `_set_status`, `_notify`…) no son invocables por los usuarios.
- Toda función `SECURITY DEFINER` fija `search_path`.
- La app solo usa la clave pública; no hay claves privadas en el código. Todo texto de usuarios se escapa antes de mostrarlo (sin XSS); no hay `eval`.
- Las escrituras no se reintentan solas (evita duplicar pedidos o cobros); los pedidos son idempotentes.

## Hallazgos corregidos en esta versión
| # | Hallazgo | Riesgo | Corrección |
|---|----------|--------|-----------|
| 1 | Los respaldos completos (costos, usuarios, auditoría, cuentas corrientes) podía pedirlos por la API cualquier administrador, incluso un secundario sin esos permisos | Alto | `12_seguridad_respaldos.sql`: solo el administrador principal (o el programador interno) |
| 2 | La app no tenía política de seguridad del navegador (CSP) | Medio | Se agrega CSP al compilar: solo scripts propios o de las CDN fijas, conexión solo a tu Supabase, sin plugins, sin formularios externos |
| 3 | Manejadores `onload`/`onerror` en línea (impedían una CSP estricta) | Medio | Reemplazados por escuchas de eventos; el chequeo automático ahora prohíbe volver a ponerlos |
| 4 | Al crear un producto, si fallaba el costo o el stock quedaba un producto a medias | Bajo | Se deshace automáticamente |
| 5 | Si fallaba el guardado, la foto subida quedaba huérfana; al reemplazar una foto, la anterior quedaba para siempre | Bajo | Se borran |
| 6 | PNG con fondo transparente quedaban con fondo negro al comprimir; fotos de celular podían salir giradas | Bajo | Fondo blanco y orientación EXIF corregida |
| 7 | Con dos ventanas abiertas, Esc cerraba ambas | Bajo | Esc cierra solo la de arriba |
| 8 | Lector físico de códigos (termina con Enter) guardaba el producto a medias | Bajo | Enter pasa al campo siguiente |

## Pendiente / límites conocidos (decisión tuya)
- **Contraseñas**: Supabase exige 8 caracteres. Para más seguridad, en Supabase › Authentication › Policies subí el mínimo y activá la protección contra contraseñas filtradas.
- **Acceso biométrico**: protege el uso de la sesión abierta en ese dispositivo (se verifica firma, desafío, sitio y verificación del usuario). Funciona sobre la sesión guardada en el dispositivo: «Cerrar sesión» la bloquea y se vuelve a entrar con huella o rostro; «Usar otra cuenta o contraseña» la cierra por completo. La primera vez, y cada vez que la sesión venza, se entra con contraseña. Para biometría como único método de ingreso desde cero haría falta un servidor propio de verificación.
- **CDN de la librería de Supabase**: la app la descarga de jsDelivr/esm.sh/unpkg con versión fija. Para eliminar esa dependencia externa se puede copiar la librería dentro del proyecto.
- **Límite de intentos de contraseña**: lo aplica Supabase Auth (activalo y ajustalo en Authentication › Rate limits).

## Resistencia del flujo (revisado)
- Doble toque: todos los botones de guardado se bloquean mientras trabajan.
- Sin conexión: las lecturas se reintentan; las escrituras muestran «La operación NO se realizó».
- Sesión vencida: vuelve al login limpio.
- Restaurar respaldo: una sola transacción; si falla, no queda nada a medias.
- Eliminar productos/clientes: se rechaza si tienen historial (pedidos o cuenta corriente), para no romper la contabilidad.
