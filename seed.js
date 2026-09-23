// Builds the "shop" dataset. scale=1 → ~2.35M rows. Deterministic thanks to setseed().
// Classic script: defines window.PGLAB_SEED so index.html works when opened straight from disk.
window.PGLAB_SEED = { version: "shop-v1", steps: function seedSteps(scale = 1) {
  const NC = Math.round(50000 * scale);   // customers
  const NP = 5000;                        // products (fixed; keeps item picks collision-free)
  const NO = Math.round(400000 * scale);  // orders
  const NE = Math.round(600000 * scale);  // events
  const NR = Math.round(100000 * scale);  // reviews

  const FIRST = `ARRAY['aarav','priya','liam','olivia','noah','emma','mateo','sofia','kenji','yuki','amara','chidi','lukas','hanna','rohan','ananya','diego','lucia','omar','layla','ethan','ava','arjun','isha','felix','clara','tomas','ines','kofi','zara','leo','mia','ravi','sana','hugo','elena','sam','nora','jin','maya']`;
  const LAST = `ARRAY['sharma','patel','smith','johnson','garcia','silva','tanaka','sato','okafor','adeyemi','muller','schmidt','kumar','iyer','lopez','martin','nguyen','kim','brown','wilson','rossi','dubois','novak','haddad','mensah','larsen','costa','reddy','chen','wang','singh','khan','ali','murphy','walsh','fischer','weber','ito','moreau','santos']`;

  return [
    ['Preparing', `
      SELECT setseed(0.4242);
      DROP TABLE IF EXISTS order_items, orders, reviews, events, products, customers, employees CASCADE;
    `],

    ['customers', `
      CREATE TABLE customers (
        id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        email            text        NOT NULL UNIQUE,
        full_name        text        NOT NULL,
        country          char(2)     NOT NULL,
        city             text        NOT NULL,
        tier             text        NOT NULL DEFAULT 'free' CHECK (tier IN ('free','pro','enterprise')),
        marketing_opt_in boolean     NOT NULL DEFAULT false,
        signup_at        timestamptz NOT NULL,
        deleted_at       timestamptz
      );
      CREATE TEMP TABLE _geo AS
      SELECT country, city, w,
             (sum(w) OVER (ORDER BY ord) - w)::float8 / 100 AS lo,
             (sum(w) OVER (ORDER BY ord))::float8 / 100     AS hi
      FROM (VALUES
        (1,'US','New York',6),(2,'US','San Francisco',5),(3,'US','Austin',4),(4,'US','Chicago',4),(5,'US','Seattle',4),
        (6,'US','Boston',3),(7,'US','Denver',2),(8,'US','Miami',2),
        (9,'IN','Bengaluru',6),(10,'IN','Mumbai',4),(11,'IN','Delhi',4),(12,'IN','Pune',3),(13,'IN','Hyderabad',3),
        (14,'GB','London',6),(15,'GB','Manchester',2),(16,'GB','Edinburgh',2),
        (17,'DE','Berlin',4),(18,'DE','Munich',2),(19,'DE','Hamburg',2),
        (20,'BR','São Paulo',4),(21,'BR','Rio de Janeiro',3),
        (22,'CA','Toronto',3),(23,'CA','Vancouver',2),
        (24,'FR','Paris',4),(25,'FR','Lyon',1),
        (26,'JP','Tokyo',4),(27,'JP','Osaka',1),
        (28,'AU','Sydney',2),(29,'AU','Melbourne',2),
        (30,'NG','Lagos',2),(31,'NG','Abuja',1),
        (32,'NL','Amsterdam',2),(33,'SG','Singapore',1)
      ) v(ord, country, city, w);

      INSERT INTO customers (email, full_name, country, city, tier, marketing_opt_in, signup_at, deleted_at)
      SELECT CASE WHEN g % 7 = 0 THEN initcap(fn) || '.' || initcap(ln) ELSE fn || '.' || ln END
               || g || '@' || dom,
             initcap(fn) || ' ' || initcap(ln),
             geo.country, geo.city,
             CASE WHEN rt < 0.80 THEN 'free' WHEN rt < 0.97 THEN 'pro' ELSE 'enterprise' END,
             rm < 0.35,
             signup_at,
             CASE WHEN rd < 0.03 THEN signup_at + (timestamptz '2026-06-30' - signup_at) * rd * 33 END
      FROM (
        SELECT g,
               (${FIRST})[1 + floor(random() * 40)::int] AS fn,
               (${LAST})[1 + floor(random() * 40)::int]  AS ln,
               (ARRAY['gmail.com','gmail.com','gmail.com','outlook.com','yahoo.com','proton.me','icloud.com','acme.io','globex.com','initech.com'])[1 + floor(random() * 10)::int] AS dom,
               random() AS rg, random() AS rt, random() AS rm, random() AS rd,
               timestamptz '2022-01-01' + (random() ^ 0.7) * interval '1641 days' AS signup_at
        FROM generate_series(1, ${NC}) g
      ) s
      JOIN _geo geo ON s.rg >= geo.lo AND s.rg < geo.hi
      ORDER BY signup_at;
    `],

    ['products', `
      CREATE TABLE products (
        id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        sku         text        NOT NULL UNIQUE,
        name        text        NOT NULL,
        category    text        NOT NULL,
        price_cents integer     NOT NULL CHECK (price_cents > 0),
        stock       integer     NOT NULL DEFAULT 0 CHECK (stock >= 0),
        attributes  jsonb       NOT NULL DEFAULT '{}',
        tags        text[]      NOT NULL DEFAULT '{}',
        created_at  timestamptz NOT NULL
      );
      INSERT INTO products (sku, name, category, price_cents, stock, attributes, tags, created_at)
      SELECT upper(left(cat, 3)) || '-' || lpad(g::text, 6, '0'),
             adj || ' ' || noun || ' ' || (100 + floor(r1 * 900)::int),
             cat,
             (lo_p + (hi_p - lo_p) * (r2 ^ 2))::int,
             CASE WHEN r3 < 0.05 THEN 0 ELSE floor(r3 * 500)::int END,
             jsonb_build_object('brand', brand, 'color', color, 'weight_g', 50 + floor(r4 * 4950)::int)
               || CASE cat WHEN 'electronics' THEN jsonb_build_object('warranty_months', (ARRAY[6,12,12,24,36])[1 + floor(r5 * 5)::int])
                           WHEN 'fashion'     THEN jsonb_build_object('size', (ARRAY['XS','S','M','L','XL'])[1 + floor(r5 * 5)::int])
                           WHEN 'books'       THEN jsonb_build_object('pages', 80 + floor(r5 * 800)::int)
                           ELSE '{}'::jsonb END,
             array_remove(ARRAY[
               CASE WHEN random() < 0.08 THEN 'bestseller' END,
               CASE WHEN random() < 0.15 THEN 'eco' END,
               CASE WHEN random() < 0.12 THEN 'new' END,
               CASE WHEN random() < 0.06 THEN 'clearance' END,
               CASE WHEN random() < 0.10 THEN 'gift' END,
               CASE WHEN random() < 0.07 THEN 'premium' END], NULL),
             timestamptz '2021-06-01' + random() * interval '1800 days' AS created_at
      FROM (
        SELECT g, c.cat, c.lo_p, c.hi_p,
               (ARRAY['Swift','Nova','Classic','Urban','Pure','Zen','Bold','Arc','Prime','Lumen'])[1 + floor(random() * 10)::int] AS adj,
               c.nouns[1 + floor(random() * array_length(c.nouns, 1))::int] AS noun,
               c.brands[1 + floor(random() * array_length(c.brands, 1))::int] AS brand,
               (ARRAY['black','white','red','blue','green','grey','beige','navy'])[1 + floor(random() * 8)::int] AS color,
               random() AS r1, random() AS r2, random() AS r3, random() AS r4, random() AS r5
        FROM generate_series(1, ${NP}) g
        JOIN (VALUES
          (0,'electronics', 1999, 149999, ARRAY['Headphones','Speaker','Charger','Keyboard','Monitor','Webcam','Router','Smartwatch'], ARRAY['Voltix','Auralis','Kinetic','Nimbus','Pixelon']),
          (1,'books',        499,   4999, ARRAY['Novel','Cookbook','Biography','Atlas','Textbook','Anthology'], ARRAY['Inkwell Press','Folio','Pagecraft']),
          (2,'home',         999,  39999, ARRAY['Lamp','Rug','Kettle','Blender','Pillow','Shelf','Mug'], ARRAY['Hearth','Nordhem','Casa Viva','Oakline']),
          (3,'toys',         599,  14999, ARRAY['Puzzle','Robot','Board Game','Plush','Kite','Blocks'], ARRAY['Playwell','Tinker','Joyful']),
          (4,'sports',      1499,  59999, ARRAY['Yoga Mat','Dumbbell','Racket','Bottle','Backpack','Bike Light'], ARRAY['Stride','Peakform','Velo']),
          (5,'beauty',       399,   9999, ARRAY['Serum','Cleanser','Lip Balm','Shampoo','Sunscreen'], ARRAY['Glowlab','Botanica','Dermae']),
          (6,'grocery',      199,   3999, ARRAY['Coffee','Tea','Granola','Olive Oil','Honey','Chocolate'], ARRAY['Harvest','Green Valley','Maple & Co']),
          (7,'fashion',      999,  29999, ARRAY['T-Shirt','Jacket','Sneakers','Scarf','Jeans','Hoodie'], ARRAY['Thread','Northline','Mode','Kaya'])
        ) c(k, cat, lo_p, hi_p, nouns, brands) ON c.k = g % 8
      ) s
      ORDER BY created_at;
    `],

    ['orders (generate)', `
      CREATE TEMP TABLE _o AS
      WITH picks AS MATERIALIZED (
        SELECT (1 + floor((random() ^ 2) * ${NC}))::bigint AS customer_id,
               random() AS r1, random() AS r2, random() AS r3, random() AS r4, random() AS r5,
               floor((random() ^ 1.6) * ${NP})::int AS pbase
        FROM generate_series(1, ${NO})
      ), dated AS (
        SELECT p.*, c.country,
               c.signup_at + (timestamptz '2026-06-30 23:00' - c.signup_at) * (p.r1 ^ 0.6) AS created_at
        FROM picks p JOIN customers c ON c.id = p.customer_id
      )
      SELECT row_number() OVER (ORDER BY created_at) AS id,
             customer_id, created_at, pbase,
             CASE WHEN created_at > timestamptz '2026-06-23' THEN (ARRAY['pending','paid','shipped'])[1 + floor(r2 * 3)::int]
                  WHEN r2 < 0.80 THEN 'delivered'
                  WHEN r2 < 0.92 THEN 'cancelled'
                  WHEN r2 < 0.97 THEN 'refunded'
                  ELSE 'shipped' END AS status,
             CASE WHEN r3 < 0.95 THEN country
                  ELSE (ARRAY['US','IN','GB','DE','BR','CA','FR','JP','AU','NG'])[1 + floor(r4 * 10)::int] END AS shipping_country,
             CASE WHEN r5 < 0.12 THEN (ARRAY['WELCOME10','BLACKFRIDAY','SPRING25','LOYAL5','FREESHIP'])[1 + floor(r5 * 41)::int] END AS coupon_code
      FROM dated;
    `],

    ['order_items (generate)', `
      CREATE TEMP TABLE _oi AS
      SELECT o.id AS order_id,
             1 + ((o.pbase + k * 997) % ${NP}) AS product_id,
             CASE WHEN random() < 0.78 THEN 1 WHEN random() < 0.7 THEN 2 ELSE 3 + floor(random() * 3)::int END AS quantity
      FROM _o o
      CROSS JOIN LATERAL generate_series(1, 1 + floor(random() * 4)::int) k;
      ALTER TABLE _oi ADD COLUMN unit_price_cents integer;
      UPDATE _oi SET unit_price_cents = CASE WHEN random() < 0.1 THEN (p.price_cents * 0.8)::int ELSE p.price_cents END
      FROM products p WHERE p.id = _oi.product_id;
    `],

    ['orders', `
      CREATE TABLE orders (
        id               bigint GENERATED ALWAYS AS IDENTITY,
        customer_id      bigint      NOT NULL,
        status           text        NOT NULL CHECK (status IN ('pending','paid','shipped','delivered','cancelled','refunded')),
        created_at       timestamptz NOT NULL,
        total_cents      integer     NOT NULL DEFAULT 0,
        shipping_country char(2)     NOT NULL,
        coupon_code      text
      );
      INSERT INTO orders (id, customer_id, status, created_at, total_cents, shipping_country, coupon_code)
      OVERRIDING SYSTEM VALUE
      SELECT o.id, o.customer_id, o.status, o.created_at, t.total, o.shipping_country, o.coupon_code
      FROM _o o
      JOIN (SELECT order_id, sum(quantity * unit_price_cents)::int AS total FROM _oi GROUP BY order_id) t ON t.order_id = o.id
      ORDER BY o.id;
      ALTER TABLE orders ADD PRIMARY KEY (id);
      SELECT setval(pg_get_serial_sequence('orders', 'id'), (SELECT max(id) FROM orders));
    `],

    ['order_items', `
      CREATE TABLE order_items (
        order_id         bigint  NOT NULL,
        product_id       bigint  NOT NULL,
        quantity         integer NOT NULL CHECK (quantity > 0),
        unit_price_cents integer NOT NULL
      );
      INSERT INTO order_items SELECT order_id, product_id, quantity, unit_price_cents FROM _oi ORDER BY order_id, product_id;
      ALTER TABLE order_items ADD PRIMARY KEY (order_id, product_id);
      DROP TABLE _o; DROP TABLE _oi;
    `],

    ['events', `
      CREATE TABLE events (
        id          bigint GENERATED ALWAYS AS IDENTITY,
        customer_id bigint,
        event_type  text        NOT NULL,
        occurred_at timestamptz NOT NULL,
        payload     jsonb       NOT NULL DEFAULT '{}'
      );
      INSERT INTO events (customer_id, event_type, occurred_at, payload)
      SELECT CASE WHEN ra < 0.25 THEN NULL ELSE (1 + floor(rb * ${NC}))::bigint END,
             et, ts,
             CASE et
               WHEN 'page_view'   THEN jsonb_build_object('path', '/p/' || (1 + floor(rc * ${NP})::int), 'device', dev, 'ms', 40 + floor((rd ^ 3) * 4000)::int)
               WHEN 'search'      THEN jsonb_build_object('q', (ARRAY['headphones','yoga mat','coffee','sneakers','novel','lamp','robot','serum','charger','jacket'])[1 + floor(rc * 10)::int], 'device', dev, 'results', floor(rd * 200)::int)
               WHEN 'add_to_cart' THEN jsonb_build_object('product_id', 1 + floor(rc * ${NP})::int, 'qty', 1 + floor(rd * 3)::int)
               WHEN 'checkout'    THEN jsonb_build_object('step', 1 + floor(rc * 3)::int, 'device', dev)
               ELSE                    jsonb_build_object('order_value_cents', 500 + floor(rc * 30000)::int)
             END
      FROM (
        SELECT timestamptz '2026-01-01' + ((g - 1)::float8 / ${NE}) * interval '181 days' + random() * interval '20 seconds' AS ts,
               random() AS ra, random() AS rb, random() AS rc, random() AS rd,
               (ARRAY['mobile','mobile','mobile','desktop','desktop','tablet'])[1 + floor(random() * 6)::int] AS dev,
               CASE WHEN r < 0.70 THEN 'page_view' WHEN r < 0.82 THEN 'search' WHEN r < 0.92 THEN 'add_to_cart'
                    WHEN r < 0.97 THEN 'checkout' ELSE 'purchase' END AS et
        FROM (SELECT g, random() AS r FROM generate_series(1, ${NE}) g) x
      ) s
      ORDER BY ts;
      ALTER TABLE events ADD PRIMARY KEY (id);
    `],

    ['reviews', `
      CREATE TABLE reviews (
        id          bigint GENERATED ALWAYS AS IDENTITY,
        product_id  bigint      NOT NULL,
        customer_id bigint      NOT NULL,
        rating      smallint    NOT NULL CHECK (rating BETWEEN 1 AND 5),
        title       text,
        body        text        NOT NULL,
        created_at  timestamptz NOT NULL
      );
      INSERT INTO reviews (product_id, customer_id, rating, title, body, created_at)
      SELECT product_id, customer_id, rating,
             CASE rating WHEN 5 THEN (ARRAY['Love it','Five stars','Exceeded expectations','Perfect'])[1 + floor(t * 4)::int]
                         WHEN 4 THEN (ARRAY['Solid purchase','Pretty good','Happy with it'])[1 + floor(t * 3)::int]
                         WHEN 3 THEN (ARRAY['It is okay','Meh','Average'])[1 + floor(t * 3)::int]
                         ELSE (ARRAY['Not worth it','Disappointed','Terrible','Avoid'])[1 + floor(t * 4)::int] END,
             initcap(left(b, 1)) || substr(b, 2) || '.',
             created_at
      FROM (
        SELECT product_id, customer_id, rating, t, created_at,
               CASE WHEN rating >= 4 THEN pos[1 + floor(p1 * 12)::int] || '. ' || pos[1 + floor(p2 * 12)::int] || CASE WHEN p3 < 0.5 THEN '. ' || neu[1 + floor(p3 * 12)::int] ELSE '' END
                    WHEN rating = 3  THEN neu[1 + floor(p1 * 6)::int] || '. ' || CASE WHEN p2 < 0.5 THEN pos[1 + floor(p2 * 24)::int] ELSE neg[1 + floor((p2 - 0.5) * 24)::int] END
                    ELSE neg[1 + floor(p1 * 12)::int] || '. ' || neg[1 + floor(p2 * 12)::int] || CASE WHEN p3 < 0.4 THEN '. ' || neu[1 + floor(p3 * 15)::int] ELSE '' END
               END AS b
        FROM (
          SELECT 1 + floor((random() ^ 1.8) * ${NP})::int AS product_id,
                 1 + floor(random() * ${NC})::int AS customer_id,
                 CASE WHEN rr < 0.45 THEN 5 WHEN rr < 0.70 THEN 4 WHEN rr < 0.82 THEN 3 WHEN rr < 0.90 THEN 2 ELSE 1 END AS rating,
                 random() AS t, random() AS p1, random() AS p2, random() AS p3,
                 timestamptz '2023-01-01' + random() * interval '1276 days' AS created_at,
                 ARRAY['battery life is excellent','arrived quickly and well packaged','great value for money','works exactly as described',
                       'my kids love it','the build quality feels premium','would definitely buy again','setup took two minutes',
                       'fits perfectly','the color is even better in person','sound quality is amazing','very comfortable to use'] AS pos,
                 ARRAY['stopped working after a week','arrived damaged','battery drains overnight','feels like cheap plastic',
                       'customer support never replied','much smaller than expected','the instructions were useless','returned it the next day',
                       'broke on the first use','shipping took forever','the zipper broke','it smells like chemicals'] AS neg,
                 ARRAY['does the job','average for the price','nothing special but fine','packaging could be better',
                       'took a while to arrive','the size runs a little small'] AS neu
          FROM (SELECT random() AS rr FROM generate_series(1, ${NR})) x
        ) y
      ) z
      ORDER BY created_at;
      ALTER TABLE reviews ADD PRIMARY KEY (id);
    `],

    ['employees', `
      CREATE TABLE employees (
        id         integer PRIMARY KEY,
        full_name  text    NOT NULL,
        department text    NOT NULL,
        title      text    NOT NULL,
        manager_id integer REFERENCES employees(id),
        salary     integer NOT NULL,
        hired_at   date    NOT NULL
      );
      WITH d(di, dept, mult) AS (VALUES (0,'Engineering',1.20),(1,'Sales',1.00),(2,'Marketing',0.95),(3,'Support',0.75),
                                        (4,'Finance',1.05),(5,'People',0.90),(6,'Product',1.15)),
      base AS (
        SELECT g AS id,
               CASE WHEN g = 1 THEN -1
                    WHEN g <= 8 THEN g - 2
                    WHEN g <= 68 THEN (g - 9) % 7
                    WHEN g <= 200 THEN (g - 69) % 7
                    ELSE floor(random() * 7)::int END AS di,
               CASE WHEN g = 1 THEN 0 WHEN g <= 8 THEN 1 WHEN g <= 68 THEN 2 WHEN g <= 200 THEN 3 ELSE 4 END AS lvl,
               random() AS r1, random() AS r2, random() AS r3,
               (${FIRST})[1 + floor(random() * 40)::int] AS fn,
               (${LAST})[1 + floor(random() * 40)::int] AS ln
        FROM generate_series(1, 1200) g
      )
      INSERT INTO employees
      SELECT b.id,
             initcap(b.fn) || ' ' || initcap(b.ln),
             coalesce(d.dept, 'Executive'),
             CASE b.lvl WHEN 0 THEN 'Chief Executive Officer' WHEN 1 THEN 'VP of ' || d.dept WHEN 2 THEN d.dept || ' Manager'
                        WHEN 3 THEN 'Team Lead' ELSE (ARRAY['Associate','Specialist','Senior Specialist','Principal'])[1 + floor(b.r3 * 4)::int] END,
             CASE b.lvl WHEN 0 THEN NULL WHEN 1 THEN 1
                        WHEN 2 THEN 2 + b.di
                        WHEN 3 THEN 9 + b.di + 7 * floor(b.r1 * 8)::int
                        ELSE 69 + b.di + 7 * floor(b.r1 * 18)::int END,
             (round(CASE b.lvl WHEN 0 THEN 450000 WHEN 1 THEN 250000 + b.r2 * 70000 WHEN 2 THEN 160000 + b.r2 * 60000
                              WHEN 3 THEN 130000 + b.r2 * 40000 ELSE 60000 + b.r2 * 90000 END * coalesce(d.mult, 1) / 1000) * 1000)::int,
             date '2015-01-01' + floor(b.r3 * 3800)::int
      FROM base b LEFT JOIN d ON d.di = b.di
      ORDER BY b.id;
    `],

    ['Foreign keys', `
      ALTER TABLE orders      ADD CONSTRAINT orders_customer_id_fkey      FOREIGN KEY (customer_id) REFERENCES customers(id);
      ALTER TABLE order_items ADD CONSTRAINT order_items_order_id_fkey    FOREIGN KEY (order_id)    REFERENCES orders(id);
      ALTER TABLE order_items ADD CONSTRAINT order_items_product_id_fkey  FOREIGN KEY (product_id)  REFERENCES products(id);
      ALTER TABLE reviews     ADD CONSTRAINT reviews_product_id_fkey      FOREIGN KEY (product_id)  REFERENCES products(id);
      ALTER TABLE reviews     ADD CONSTRAINT reviews_customer_id_fkey     FOREIGN KEY (customer_id) REFERENCES customers(id);
      ALTER TABLE events      ADD CONSTRAINT events_customer_id_fkey      FOREIGN KEY (customer_id) REFERENCES customers(id);
      DROP TABLE _geo;
    `],

    ['VACUUM ANALYZE', `VACUUM ANALYZE;`],
  ];
} };
