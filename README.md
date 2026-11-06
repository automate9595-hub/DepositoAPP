# Depósito · Gestión de stock y pedidos

PWA para Android (también PC) con **Supabase (PostgreSQL + Auth + Realtime + Storage)** y publicación gratuita en **GitHub Pages**.
Sin servidores propios. La seguridad vive en PostgreSQL (RLS + funciones transaccionales).

## Roles
| Rol | Qué hace |
|---|---|
| Administrador principal | Todo. Gestiona usuarios, productos, precios, inventario, pedidos, estadísticas y auditoría. |
| Segundo administrador | Mismo panel, con permisos configurables (pedidos, inventario, productos, usuarios, estadísticas, auditoría). |
| Proveedor | Ve catálogo, precios y stock disponible; arma carrito; envía y sigue sus pedidos. Solo ve los suyos. |
| Depósito | Ve pedidos aprobados, marca preparados, informa faltantes, finaliza y confirma entrega. |

## Puesta en marcha (una sola vez)

### 1) Supabase (gratis)
1. Cree un proyecto en <https://supabase.com> (plan Free).
2. **Authentication → Providers → Email**: desactive **"Confirm email"** (necesario para que el administrador cree usuarios con contraseña desde la app).
3. **SQL Editor**: ejecute, en este orden, el contenido de
   `supabase/01_esquema.sql` → `supabase/02_funciones.sql` → `supabase/03_seguridad.sql`.
4. **Authentication → Users → Add user → Create new user** (marque *Auto Confirm User*) con su correo y contraseña.
5. Edite `supabase/04_crear_administrador.sql` con ese correo y ejecútelo: queda como **Administrador principal**.
6. (Opcional, recomendado) Ejecute `supabase/tests/escenarios.sql`: corre el flujo completo con datos de prueba y termina en ROLLBACK (no deja nada). Debe mostrar *"TODAS LAS PRUEBAS PASARON"*.
7. **Project Settings → API**: copie la **URL** y la clave **anon public** (o *publishable*). **Nunca** use `service_role`/`secret`.

### 2) Publicar (Windows)
1. Instale [Git](https://git-scm.com/download/win) y [Node.js LTS](https://nodejs.org).
2. Cree el repositorio vacío en GitHub (ya indicado: `github.com/automate9595-hub/DepositoAPP`).
3. Doble clic en **`publicar.bat`**. Pide la URL y la clave pública, comprueba, compila y sube a GitHub.
   Si su cuenta de GitHub pide iniciar sesión, siga la ventana que abre Git Credential Manager.
4. En GitHub: **Settings → Pages → Build and deployment → Source: Deploy from a branch → Branch `main` / carpeta `/docs`**.
   (El BAT lo intenta automáticamente si tiene GitHub CLI.) La app queda en `https://automate9595-hub.github.io/DepositoAPP/`.
5. En Android abra esa dirección en Chrome → menú → **Instalar aplicación**.

### 3) Primer uso
Ingrese como administrador → **Usuarios → Nuevo** para crear proveedores, depósito y segundo administrador → **Productos → Nuevo** → **Inventario** para cargar stock.

## Cómo garantiza la integridad del inventario
* `disponible = físico − reservado` (columna calculada en PostgreSQL; checks impiden negativos y reservado > físico).
* **Aprobar** bloquea las filas de inventario (`FOR UPDATE`, en orden fijo) y reserva; si no alcanza, aborta todo el pedido.
* **Entrega** descuenta solo lo realmente preparado y libera el resto. **Cancelar** libera reservas. Todo en transacciones.
* Los proveedores **no tienen permiso de escritura** en ninguna tabla; solo llaman a funciones (`submit_order`, `cancel_order`).
* Precios y totales se calculan en el servidor; el pedido guarda una fotografía histórica de precio, código y nombre.
* `submit_order` es **idempotente** (`client_request_id` único): reintentos o doble toque no duplican pedidos.
* Estados con tabla de transiciones válidas + trigger de protección + historial con usuario y hora.
* Nada se borra: no hay política DELETE; los productos se desactivan.
* Auditoría de acciones críticas y cambios en productos/usuarios (solo lectura según permiso).

## Estabilidad en el teléfono
Indicador En línea / Reconectando / Sin conexión, reconexión y re-sincronización automática (Realtime + al volver a la app), reintentos solo en lecturas, carrito guardado en el dispositivo, sesión persistente, botones que se bloquean mientras se procesa, y **ninguna operación se muestra como exitosa hasta que la base de datos la confirma**. Si no hay Internet, la app abre desde caché pero no permite fingir operaciones.

## Notificaciones
Dentro de la app (campana + avisos guardados en la base, se recuperan al iniciar sesión) y avisos del sistema Android mientras la app está abierta o en segundo plano. El **push con la app totalmente cerrada** requiere un servidor de envío (clave VAPID + función Edge), que no es "esencial" ni está incluido para no depender de infraestructura propia.

## Desarrollo
```
npm run check    # sintaxis, imports, RLS en todas las tablas, secretos, pruebas unitarias
npm run build    # src/ → docs/  (necesita .env)
```
Sin dependencias npm: no hay `npm install` que pueda fallar. La librería de Supabase se carga desde jsDelivr (versión fija) y queda en caché del service worker.

## Límites del plan gratuito (a tener en cuenta)
Supabase Free pausa proyectos tras ~1 semana sin actividad (se reactiva desde el panel), 500 MB de base y 1 GB de archivos. Las fotos se reducen a ≤900 px antes de subirse.


## Publicación automática sin Node.js en Windows

La carpeta `docs/` ya contiene la versión web preparada. No ejecute `npm`, no instale Node.js y no use el antiguo `publicar.bat`.

1. Ejecute `SUBIR_A_GITHUB_SIN_NODE.bat` o abra el repositorio desde el navegador.
2. En GitHub, suba el contenido completo de esta carpeta del proyecto y confirme con **Commit changes** en la rama `main`.
3. La primera vez, entre en **Settings → Pages → Build and deployment → Source** y seleccione **GitHub Actions**.
4. Abra la pestaña **Actions**. El workflow `Publicar DepositoAPP en GitHub Pages` publicará automáticamente el contenido de `docs/`.
5. Cuando la ejecución termine correctamente, la aplicación estará en `https://automate9595-hub.github.io/DepositoAPP/`.

El workflow usa los archivos web ya preparados: no instala ni ejecuta Node.js en su computadora. La clave incluida en `docs/config.js` es la clave pública publishable de Supabase; nunca se incluye una clave secret/service_role.


## Novedades de esta versión (rediseño)

* **Tema claro y oscuro**: botón sol/luna en la barra superior (y en Cuenta: Automático / Claro / Oscuro). Se recuerda por dispositivo.
* **Sonido de avisos**: botón de altavoz en la barra superior o en Cuenta. Suena al llegar un pedido o cambiar su estado (sonidos distintos para pedido nuevo, listo y faltante/cancelado). El navegador solo permite audio después de tocar la pantalla una vez.
* **Administración prepara pedidos**: nueva pestaña **Preparación** (principal, o segundo administrador con permiso "Pedidos"). Mismo flujo que el depósito: comenzar, marcar *Preparado* o *Faltante*, finalizar (queda *Listo para entregar*) y confirmar entrega. En un pedido también puede asignárselo a sí mismo.
  **Importante:** si su base de Supabase ya estaba instalada, ejecute `supabase/06_clientes_costos.sql` (incluye lo de `05_admin_prepara.sql`). Instalaciones nuevas: ya viene incluido en `instalar_todo.sql`.
* **Actualización automática**: al subir cambios a `main`, GitHub Actions compila `src/` con un número de versión nuevo y publica. Las apps instaladas lo detectan (al abrir, al volver a primer plano, al recuperar Internet y cada 5 minutos) y se actualizan solas, sin interrumpir formularios ni ventanas abiertas. Para cambiar la app basta con subir los archivos modificados de `src/`.
* **Visual**: transiciones entre pantallas, listas con entrada escalonada, esqueletos de carga, efecto onda en botones, menú lateral en pantallas grandes, hojas y avisos animados. Se respeta "reducir movimiento" del sistema.


## Novedades de la versión 3 (clientes, costos, estadísticas)

**Antes de subir la app, ejecute `supabase/06_clientes_costos.sql` en Supabase (SQL Editor → Run).** Se puede repetir sin problema. Si algún día vuelve a ejecutar `03_seguridad.sql`, ejecute `06` otra vez después.

* **Clientes**: pestaña *Clientes* (administración con permiso "Clientes y cuentas", y proveedores). Todo pedido se asigna a un cliente o al **Cliente público general** (contado, sin cuenta corriente). Un cliente creado por la administración puede quedar para *todos los proveedores* o para uno solo; los que crea un proveedor son solo suyos.
* **Cuenta corriente**: al **entregar** un pedido se carga su total a la cuenta del cliente. La administración registra **pagos** (efectivo, transferencia, etc.) y **ajustes** con motivo. Estado: **Al día** (sin deuda), **Con saldo** (debe, dentro del plazo) o **Vencido** (la deuda más antigua pasó el plazo de pago del cliente; los pagos se aplican a las deudas más viejas primero).
* **Pedidos**: se muestran como *Pedido número N del cliente X*. El proveedor debe elegir cliente al enviar el carrito (puede crear uno nuevo ahí mismo).
* **Productos**: precio de **costo** (solo lo ven los administradores) y precio de **venta**, con ganancia y margen en vivo. El costo se guarda por pedido al momento de crearlo, así la ganancia histórica no cambia si luego cambia el costo.
* **Agregar productos a un pedido** (administración): botón en el detalle de pedidos pendientes, aprobados o en preparación. En pedidos ya aprobados reserva el stock enseguida y avisa al proveedor y al depósito.
* **Estadísticas**: períodos (hoy, 7/30/90 días, este mes, mes anterior, este año, personalizado) comparados con el período anterior; ventas, costo y ganancia en el tiempo, pedidos recibidos, estados, mejores clientes, productos y proveedores, por cobrar y valor del inventario.
* Segundos administradores: para usar Clientes hay que tildar el permiso **Clientes y cuentas** en Usuarios.

* **Datos del pedido**: cada pedido muestra su número, la **fecha**, la **hora** y el **proveedor** que lo realizó, tanto en las listas como en el detalle.


## Novedades de la versión 4 (arranque robusto + nuevas funciones)

**No requiere ejecutar ningún SQL nuevo.** Basta con subir los archivos a GitHub como siempre.

### Corrección: la app se quedaba en la pantalla de carga / login
* La librería de Supabase ahora se pide a 3 CDN (jsDelivr → esm.sh → unpkg) con tiempo límite; si una está bloqueada o lenta, usa la siguiente.
* Se quitó el uso de `navigator.locks` en el cliente: un bloqueo huérfano (app cerrada a la fuerza en Android) dejaba colgado `getSession()` y el inicio de sesión.
* Todas las peticiones tienen tiempo límite (20 s) y la lectura de sesión tiene plan B (sesión guardada en el teléfono).
* El inicio de sesión arranca la app directamente, sin depender solo de un evento de la librería; se evita arrancar dos veces.
* Si la sesión está vencida o corrupta, vuelve al login en lugar de quedarse esperando.
* El service worker ahora usa "red primero" para los archivos de la app, para que nunca se mezclen archivos de versiones distintas.
* **Guardián de arranque**: si en 15 s no aparece el login, se muestra una pantalla con *Reintentar* y *Reparar* (borra caché y sesión local).

### Funciones nuevas
* **Escáner de código de barras** (cámara) en Catálogo, Productos e Inventario, si el navegador lo soporta (Chrome en Android).
* **Alertas de stock bajo**: pestaña *Stock bajo* en Inventario con contador, umbral configurable y aviso en cada producto.
* **Exportar a Excel (CSV)**: pedidos (por estado), inventario, stock bajo y movimientos de stock.
* **Compartir e imprimir pedido**: texto por WhatsApp/otras apps y remito imprimible con espacio para firmas.
* **Repetir pedido** (proveedor): vuelve a cargar un pedido anterior en el carrito con precios y stock actuales.

### Subida automática a GitHub
`SUBIR_A_GITHUB_SIN_NODE.bat` ahora sube los archivos por sí solo (PowerShell + API de GitHub, sin Git ni Node.js), con barra de progreso, y muestra el estado de la publicación. Ver `LEEME_WINDOWS8.txt`.

## Respaldos automáticos en Supabase (archivos incluidos)

La carpeta `supabase/` incluye los dos SQL solicitados:

1. `supabase/07_respaldos.sql`: crea la configuración e historial de respaldos, el bucket privado `database-backups` y la función SQL que prepara el snapshot. Ejecutarlo **una sola vez después de `supabase/instalar_todo.sql`** desde Supabase → SQL Editor.
2. `supabase/08_programar_respaldos.sql`: configura `pg_cron` + `pg_net` para llamar periódicamente al respaldo. Ejecutarlo **después de desplegar** la Edge Function `deposito-backup` y de guardar en Supabase Vault los secretos indicados al comienzo del archivo. Reemplazar las URL y claves de ejemplo por las del propio proyecto; nunca subir la `service_role` a GitHub ni a la aplicación.

La función que debe desplegarse también está incluida en `supabase/functions/deposito-backup/index.ts`. Desde una terminal con Supabase CLI vinculada al proyecto, ejecutar `supabase functions deploy deposito-backup`. Supabase proporciona `SUPABASE_URL` y `SUPABASE_SERVICE_ROLE_KEY` como secretos de entorno de la función; no agregarlos al frontend. La función rechaza invocaciones que no lleven la autorización interna esperada.

**Orden resumido:** instalar la base (`instalar_todo.sql`) → ejecutar `07_respaldos.sql` → desplegar `deposito-backup` → crear los dos secretos de Vault indicados en `08_programar_respaldos.sql` → ejecutar `08_programar_respaldos.sql`. Luego comprobar el job desde SQL Editor con la consulta comentada al final de `08_programar_respaldos.sql`.

Nota: estos dos scripts habilitan la infraestructura de respaldo automático de la base de datos. El snapshot SQL incluido contiene las tablas de negocio enumeradas en `backup_snapshot`; no exporta identidades ni contraseñas de Supabase Auth ni los objetos de fotografías del bucket de productos.


## Respaldo integral y cobro al entregar (actualización)

Después de ejecutar la instalación principal y `supabase/07_respaldos.sql`, ejecutar también `supabase/09_respaldos_y_cobros.sql` en el SQL Editor de Supabase. Esta migración agrega una lectura segura para el respaldo de tablas protegidas (incluidos `order_item_costs`), conserva los pagos por pedido y crea el procedimiento transaccional de entrega con cobro.

Para activar el respaldo automático:
1. Ejecutar `supabase/07_respaldos.sql` y `supabase/09_respaldos_y_cobros.sql`.
2. Desplegar `supabase/functions/deposito-backup` como Edge Function `deposito-backup`.
3. Guardar `SUPABASE_URL` y `SUPABASE_SERVICE_ROLE_KEY` en Supabase Vault con los nombres que indica `supabase/08_programar_respaldos.sql`.
4. Ejecutar `supabase/08_programar_respaldos.sql` una sola vez.
5. En Administración > Respaldos, configurar frecuencia, hora, retención y modalidad de descarga.

La Edge Function genera el JSON con las tablas de negocio y los archivos del bucket privado `product-photos`. Los respaldos automáticos se guardan en el bucket privado `database-backups`. La exportación de usuarios no incluye contraseñas ni identidades de Supabase Auth.

Al confirmar una entrega, el sistema permite cobrar ahora (monto y medio de pago) o dejar el total a cuenta corriente. Si se registra un pago parcial a un cliente con cuenta, el resto queda pendiente. El registro de entrega, cargo y pago se ejecuta en una única transacción de base de datos.
