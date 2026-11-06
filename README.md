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
