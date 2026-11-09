-- =====================================================================
-- CATÁLOGO DE PRUEBAS (1.200 productos de distribuidora, 15 rubros, con costo y stock)
-- Determinístico (siempre los mismos productos) y re-ejecutable (no duplica).
-- Todos los códigos empiezan con TST- y los rubros con "[TEST] ", para poder borrarlos con limpiar_pruebas.sql.
-- ⚠ Cargar SOLO en un proyecto de pruebas, no en el de producción real.
-- =====================================================================
insert into public.categories(name)
select '[TEST] ' || c from unnest(array['Gaseosas','Aguas y jugos','Cervezas','Vinos','Lácteos','Fiambres','Almacén','Galletitas','Golosinas',
  'Snacks','Limpieza','Perfumería','Congelados','Descartables','Infusiones']) c
where not exists (select 1 from public.categories where name = '[TEST] ' || c);

with cat as (select name, row_number() over (order by name) rn from public.categories where name like '[TEST] %'),
rubros(rn, nombre, tipos, marcas, pres, base) as (values
  (1,'Gaseosas',  array['Cola','Lima limón','Naranja','Pomelo','Tónica','Ginger'], array['Fresca','Burbuja','Sierra','Norte'], array['500 ml','1,5 L','2,25 L','lata 354 ml'], 1500),
  (2,'Aguas y jugos', array['Agua mineral','Agua saborizada','Jugo de naranja','Jugo de manzana','Jugo multifruta'], array['Manantial','Cumbres','Vita','Pura'], array['500 ml','1,5 L','2 L','tetra 1 L'], 900),
  (3,'Cervezas',  array['Rubia','Negra','IPA','Roja','Light'], array['Andina','Patagonia Sur','Cerro','Pampa'], array['lata 473 ml','botella 1 L','retornable 1 L','pack x6'], 2200),
  (4,'Vinos',     array['Malbec','Cabernet','Torrontés','Blend tinto','Chardonnay'], array['Valle Alto','Bodega Sol','Finca Luna','Altura'], array['750 ml','1,125 L','tetra 1 L'], 4200),
  (5,'Lácteos',   array['Leche entera','Leche descremada','Yogur firme','Yogur bebible','Queso cremoso','Manteca','Dulce de leche'], array['La Granja','Pradera','Sierras','Campo'], array['1 L','200 g','500 g','1 kg'], 1800),
  (6,'Fiambres',  array['Jamón cocido','Salame','Mortadela','Paleta','Queso de máquina','Bondiola'], array['Casa Rossi','Del Pago','Fino','Criollo'], array['200 g','500 g','1 kg'], 3500),
  (7,'Almacén',   array['Arroz','Fideos','Harina 000','Azúcar','Aceite girasol','Sal fina','Puré de tomate','Lentejas','Polenta','Yerba'], array['Granero','Doña Rosa','Sol','Campo Verde'], array['500 g','1 kg','900 ml','5 kg'], 1700),
  (8,'Galletitas',array['Dulces','Crackers','Surtidas','Rellenas','Integrales','Obleas'], array['Crocante','Delicia','Merienda','Trigal'], array['100 g','200 g','300 g','pack x3'], 1100),
  (9,'Golosinas',  array['Caramelos','Chicles','Alfajor','Chocolate','Gomitas','Turrón','Bombones'], array['Dulcería','Nube','Capricho','Arcoíris'], array['unidad','caja x12','bolsa 500 g'], 600),
  (10,'Snacks',    array['Papas fritas','Maníes','Palitos','Chizitos','Nachos','Pochoclo'], array['Crujiente','Tostado','Mix','Cancha'], array['40 g','100 g','200 g','familiar'], 800),
  (11,'Limpieza',  array['Lavandina','Detergente','Jabón en polvo','Suavizante','Limpiador piso','Desengrasante','Esponja'], array['Brillo','Pureza','Hogar','Espuma'], array['500 ml','900 ml','2 L','3 kg'], 1400),
  (12,'Perfumería',array['Shampoo','Acondicionador','Jabón de tocador','Desodorante','Pasta dental','Crema corporal','Papel higiénico'], array['Aura','Fresca Piel','Nativa','Dermo'], array['200 ml','400 ml','pack x4','pack x12'], 2000),
  (13,'Congelados',array['Hamburguesas','Nuggets','Papas prefritas','Empanadas','Pizza','Helado','Vegetales'], array['Frío Sur','Polar','Ártico','Nevado'], array['x4','x12','500 g','1 kg'], 3000),
  (14,'Descartables',array['Vasos','Platos','Servilletas','Bolsas residuo','Papel aluminio','Film','Cubiertos'], array['Práctico','Eco','Fiesta','Uno'], array['x50','x100','rollo','pack x10'], 700),
  (15,'Infusiones',array['Té negro','Té de hierbas','Café molido','Café instantáneo','Mate cocido','Edulcorante'], array['Aroma','Hebras','Tostado','Alba'], array['x25','x100','250 g','500 g'], 1300)),
base as (
  select r.rn rubro, r.nombre, t.tipo, m.marca, p.pres, r.base,
         row_number() over (order by r.rn, t.tipo, m.marca, p.pres) n
  from rubros r, unnest(r.tipos) t(tipo), unnest(r.marcas) m(marca), unnest(r.pres) p(pres)),
sel as (select * from base where n <= 1200)
insert into public.products(code, name, description, category_id, price, active)
select 'TST-' || lpad(s.n::text, 5, '0'),
       s.tipo || ' ' || s.marca || ' ' || s.pres,
       'Producto de prueba del rubro ' || s.nombre,
       (select c.id from public.categories c where c.name = '[TEST] ' || s.nombre),
       round((s.base * (0.6 + (abs(hashtext(s.n::text)) % 1000) / 1000.0 * 1.4))::numeric, 0),
       (s.n % 97 <> 0)      -- ~1 % de productos inactivos, como en la vida real
from sel s
on conflict (code) do nothing;

insert into public.product_costs(product_id, cost_price)
select p.id, round(p.price * (0.62 + (abs(hashtext(p.code)) % 20) / 100.0), 2)     -- costo = 62 % a 81 % del precio
from public.products p where p.code like 'TST-%'
on conflict (product_id) do nothing;

-- Stock inicial: de 0 a ~2.000 unidades (algunos productos agotados a propósito)
update public.inventory i set physical_stock = case when abs(hashtext(p.code || 's')) % 40 = 0 then 0 else 50 + abs(hashtext(p.code || 'q')) % 1950 end
from public.products p where p.id = i.product_id and p.code like 'TST-%' and i.physical_stock = 0 and i.reserved_stock = 0;

select count(*) as productos_de_prueba, count(*) filter (where active) as activos from public.products where code like 'TST-%';
