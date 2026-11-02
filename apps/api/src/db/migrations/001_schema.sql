-- Food Cost — schema iniziale (PostgreSQL 15+)
-- Convenzioni: importi e quantità NUMERIC; ogni entità aziendale ha company_id;
-- gli indici delle anagrafiche iniziano da company_id per le query sempre delimitate all'azienda.


-- ===================== Aziende, utenti, accessi =====================

CREATE TABLE companies (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz
);

CREATE TABLE users (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email              text NOT NULL,
  name               text NOT NULL,
  password_hash      text,
  is_active          boolean NOT NULL DEFAULT true,
  is_platform_admin  boolean NOT NULL DEFAULT false,
  created_at         timestamptz NOT NULL DEFAULT now(),
  last_login_at      timestamptz
);
CREATE UNIQUE INDEX users_email_uq ON users (lower(email));

CREATE TABLE memberships (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid NOT NULL REFERENCES companies(id),
  user_id     uuid NOT NULL REFERENCES users(id),
  role        text NOT NULL CHECK (role IN ('admin', 'manager', 'operator')),
  -- permessi aggiuntivi rispetto al ruolo (es. salaries.read, costs.read)
  extra_permissions text[] NOT NULL DEFAULT '{}',
  is_active   boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, user_id)
);
CREATE INDEX memberships_user_idx ON memberships (user_id);

CREATE TABLE sessions (
  token_hash        text PRIMARY KEY,
  user_id           uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  active_company_id uuid REFERENCES companies(id),
  created_at        timestamptz NOT NULL DEFAULT now(),
  last_seen_at      timestamptz NOT NULL DEFAULT now(),
  expires_at        timestamptz NOT NULL
);
CREATE INDEX sessions_user_idx ON sessions (user_id);

CREATE TABLE password_resets (
  token_hash  text PRIMARY KEY,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE invitations (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid NOT NULL REFERENCES companies(id),
  email       text NOT NULL,
  name        text NOT NULL,
  role        text NOT NULL CHECK (role IN ('admin', 'manager', 'operator')),
  extra_permissions text[] NOT NULL DEFAULT '{}',
  token_hash  text NOT NULL UNIQUE,
  invited_by  uuid REFERENCES users(id),
  expires_at  timestamptz NOT NULL,
  accepted_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX invitations_company_idx ON invitations (company_id);

-- ============================ Ingredienti ============================

CREATE TABLE ingredients (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id       uuid NOT NULL REFERENCES companies(id),
  code             text NOT NULL,
  name             text NOT NULL,
  category         text,
  supplier         text,
  notes            text,
  -- confezione corrente: es. 25 kg, 750 ml, 12 pz
  purchase_unit    text NOT NULL DEFAULT 'confezione',
  package_content  numeric(18,6) NOT NULL CHECK (package_content > 0),
  package_unit     text NOT NULL CHECK (package_unit IN ('g','kg','ml','cl','l','pz')),
  usage_unit       text NOT NULL CHECK (usage_unit IN ('g','kg','ml','cl','l','pz')),
  edible_yield     numeric(9,6) NOT NULL DEFAULT 1 CHECK (edible_yield > 0 AND edible_yield <= 1),
  density_kg_per_l numeric(18,6) CHECK (density_kg_per_l IS NULL OR density_kg_per_l > 0),
  unit_weight_kg   numeric(18,6) CHECK (unit_weight_kg IS NULL OR unit_weight_kg > 0),
  archived_at      timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  lock_version     integer NOT NULL DEFAULT 1
);
CREATE UNIQUE INDEX ingredients_code_uq ON ingredients (company_id, lower(code));
CREATE INDEX ingredients_list_idx ON ingredients (company_id, archived_at, lower(name));
CREATE INDEX ingredients_category_idx ON ingredients (company_id, category);

-- Storico prezzi: ogni voce fotografa anche la confezione a cui il prezzo si riferisce.
CREATE TABLE ingredient_prices (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id       uuid NOT NULL REFERENCES companies(id),
  ingredient_id    uuid NOT NULL REFERENCES ingredients(id),
  package_price    numeric(18,6) NOT NULL CHECK (package_price >= 0),
  package_content  numeric(18,6) NOT NULL CHECK (package_content > 0),
  package_unit     text NOT NULL CHECK (package_unit IN ('g','kg','ml','cl','l','pz')),
  valid_from       date NOT NULL,
  source           text,
  notes            text,
  import_id        uuid,
  created_by       uuid REFERENCES users(id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  -- una sola voce per articolo e data: niente ambiguità
  UNIQUE (ingredient_id, valid_from)
);
CREATE INDEX ingredient_prices_lookup_idx ON ingredient_prices (company_id, ingredient_id, valid_from DESC);

-- ============================== Utenze ==============================

CREATE TABLE utility_tariffs (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid NOT NULL REFERENCES companies(id),
  name        text NOT NULL,
  kind        text NOT NULL CHECK (kind IN ('electricity', 'gas', 'water')),
  unit        text NOT NULL CHECK (unit IN ('kwh', 'm3', 'smc')),
  notes       text,
  archived_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CHECK (kind <> 'electricity' OR unit = 'kwh'),
  CHECK (kind <> 'water' OR unit = 'm3')
);
CREATE INDEX utility_tariffs_company_idx ON utility_tariffs (company_id, kind);

CREATE TABLE tariff_versions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id      uuid NOT NULL REFERENCES companies(id),
  tariff_id       uuid NOT NULL REFERENCES utility_tariffs(id),
  price_per_unit  numeric(18,8) NOT NULL CHECK (price_per_unit >= 0),
  valid_from      date NOT NULL,
  origin          text NOT NULL CHECK (origin IN ('direct', 'bill')),
  m3_to_smc       numeric(18,8) CHECK (m3_to_smc IS NULL OR m3_to_smc > 0),
  smc_to_kwh      numeric(18,8) CHECK (smc_to_kwh IS NULL OR smc_to_kwh > 0),
  -- dettaglio della bolletta per la modalità assistita (periodo, consumo, voci incluse)
  bill            jsonb,
  notes           text,
  created_by      uuid REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tariff_id, valid_from)
);
CREATE INDEX tariff_versions_lookup_idx ON tariff_versions (company_id, tariff_id, valid_from DESC);

-- ======================= Strumenti e macchinari =======================

CREATE TABLE equipment (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id           uuid NOT NULL REFERENCES companies(id),
  code                 text NOT NULL,
  name                 text NOT NULL,
  category             text,
  description          text,
  power_type           text NOT NULL CHECK (power_type IN ('electric', 'gas', 'mixed', 'manual')),
  status               text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'maintenance', 'inactive')),
  capacity             text,
  electric_power_kw    numeric(12,4) CHECK (electric_power_kw IS NULL OR electric_power_kw > 0),
  usage_coefficient    numeric(6,4) CHECK (usage_coefficient IS NULL OR (usage_coefficient > 0 AND usage_coefficient <= 1)),
  preheat_coefficient  numeric(6,4) CHECK (preheat_coefficient IS NULL OR (preheat_coefficient > 0 AND preheat_coefficient <= 1)),
  hold_coefficient     numeric(6,4) CHECK (hold_coefficient IS NULL OR (hold_coefficient > 0 AND hold_coefficient <= 1)),
  electric_tariff_id   uuid REFERENCES utility_tariffs(id),
  gas_mode             text CHECK (gas_mode IS NULL OR gas_mode IN ('flow', 'energy')),
  gas_flow_per_hour    numeric(12,6) CHECK (gas_flow_per_hour IS NULL OR gas_flow_per_hour > 0),
  gas_flow_unit        text CHECK (gas_flow_unit IS NULL OR gas_flow_unit IN ('m3', 'smc')),
  gas_power_kw         numeric(12,4) CHECK (gas_power_kw IS NULL OR gas_power_kw > 0),
  gas_load_factor      numeric(6,4) CHECK (gas_load_factor IS NULL OR (gas_load_factor > 0 AND gas_load_factor <= 1)),
  gas_tariff_id        uuid REFERENCES utility_tariffs(id),
  archived_at          timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  lock_version         integer NOT NULL DEFAULT 1
);
CREATE UNIQUE INDEX equipment_code_uq ON equipment (company_id, lower(code));
CREATE INDEX equipment_list_idx ON equipment (company_id, archived_at, lower(name));

-- ============================ Dipendenti ============================

CREATE TABLE employees (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid NOT NULL REFERENCES companies(id),
  code        text NOT NULL,
  first_name  text NOT NULL,
  last_name   text NOT NULL,
  job_title   text,
  status      text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  user_id     uuid REFERENCES users(id),
  archived_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX employees_code_uq ON employees (company_id, lower(code));
CREATE INDEX employees_list_idx ON employees (company_id, archived_at, lower(last_name));

CREATE TABLE employee_cost_configs (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id           uuid NOT NULL REFERENCES companies(id),
  employee_id          uuid NOT NULL REFERENCES employees(id),
  valid_from           date NOT NULL,
  gross_monthly        numeric(12,2) NOT NULL CHECK (gross_monthly >= 0),
  contributions_mode   text NOT NULL CHECK (contributions_mode IN ('none', 'amount', 'percent')),
  contributions_value  numeric(12,4),
  other_monthly_costs  numeric(12,2) NOT NULL DEFAULT 0 CHECK (other_monthly_costs >= 0),
  productive_hours     numeric(8,2) NOT NULL CHECK (productive_hours > 0),
  notes                text,
  import_id            uuid,
  created_by           uuid REFERENCES users(id),
  created_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (employee_id, valid_from),
  -- un solo modo di imputare gli oneri: niente doppia imputazione
  CHECK ((contributions_mode = 'none' AND contributions_value IS NULL)
      OR (contributions_mode IN ('amount', 'percent') AND contributions_value IS NOT NULL AND contributions_value >= 0))
);
CREATE INDEX employee_cost_lookup_idx ON employee_cost_configs (company_id, employee_id, valid_from DESC);

-- ============================== Ricette ==============================

CREATE TABLE recipes (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id           uuid NOT NULL REFERENCES companies(id),
  code                 text NOT NULL,
  title                text NOT NULL,
  category             text,
  description          text,
  status               text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'archived')),
  current_revision_id  uuid,
  duplicated_from_id   uuid REFERENCES recipes(id),
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  lock_version         integer NOT NULL DEFAULT 1
);
CREATE UNIQUE INDEX recipes_code_uq ON recipes (company_id, lower(code));
CREATE INDEX recipes_list_idx ON recipes (company_id, status, lower(title));

-- Revisioni immutabili: ogni salvataggio crea una nuova revisione con la sua composizione.
CREATE TABLE recipe_revisions (
  id                         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id                 uuid NOT NULL REFERENCES companies(id),
  recipe_id                  uuid NOT NULL REFERENCES recipes(id),
  number                     integer NOT NULL,
  instructions               text,
  final_quantity             numeric(14,4) CHECK (final_quantity IS NULL OR final_quantity > 0),
  final_unit                 text CHECK (final_unit IS NULL OR final_unit IN ('g','kg','ml','cl','l','pz')),
  final_weight_kg            numeric(14,4) CHECK (final_weight_kg IS NULL OR final_weight_kg > 0),
  portions                   numeric(10,2) CHECK (portions IS NULL OR portions > 0),
  declared_duration_minutes  numeric(10,2) CHECK (declared_duration_minutes IS NULL OR declared_duration_minutes > 0),
  yield_notes                text,
  created_by                 uuid REFERENCES users(id),
  created_at                 timestamptz NOT NULL DEFAULT now(),
  UNIQUE (recipe_id, number)
);
ALTER TABLE recipes ADD CONSTRAINT recipes_current_revision_fk FOREIGN KEY (current_revision_id) REFERENCES recipe_revisions(id);

CREATE TABLE recipe_phases (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id             uuid NOT NULL REFERENCES companies(id),
  revision_id            uuid NOT NULL REFERENCES recipe_revisions(id),
  position               integer NOT NULL,
  name                   text NOT NULL,
  description            text,
  start_offset_minutes   numeric(10,2),
  duration_minutes       numeric(10,2)
);
CREATE INDEX recipe_phases_rev_idx ON recipe_phases (revision_id);

CREATE TABLE recipe_components (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id     uuid NOT NULL REFERENCES companies(id),
  revision_id    uuid NOT NULL REFERENCES recipe_revisions(id),
  position       integer NOT NULL,
  ingredient_id  uuid REFERENCES ingredients(id),
  sub_recipe_id  uuid REFERENCES recipes(id),
  -- nullable: una bozza può essere salvata con quantità ancora da inserire (segnalata come incompleta)
  quantity       numeric(14,4) CHECK (quantity IS NULL OR quantity > 0),
  unit           text NOT NULL CHECK (unit IN ('g','kg','ml','cl','l','pz')),
  note           text,
  -- esattamente un riferimento: ingrediente oppure ricetta
  CHECK ((ingredient_id IS NULL) <> (sub_recipe_id IS NULL))
);
CREATE INDEX recipe_components_rev_idx ON recipe_components (revision_id);
CREATE INDEX recipe_components_ing_idx ON recipe_components (company_id, ingredient_id);
CREATE INDEX recipe_components_sub_idx ON recipe_components (company_id, sub_recipe_id);

CREATE TABLE recipe_equipment_uses (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id             uuid NOT NULL REFERENCES companies(id),
  revision_id            uuid NOT NULL REFERENCES recipe_revisions(id),
  phase_id               uuid REFERENCES recipe_phases(id),
  position               integer NOT NULL,
  equipment_id           uuid NOT NULL REFERENCES equipment(id),
  segment                text NOT NULL DEFAULT 'work' CHECK (segment IN ('preheat', 'work', 'hold')),
  minutes                numeric(10,2) CHECK (minutes IS NULL OR minutes > 0),
  share                  numeric(7,6) NOT NULL DEFAULT 1 CHECK (share > 0 AND share <= 1),
  sources                text[],
  measured_electric_kwh  numeric(14,6) CHECK (measured_electric_kwh IS NULL OR measured_electric_kwh >= 0),
  measured_gas_quantity  numeric(14,6) CHECK (measured_gas_quantity IS NULL OR measured_gas_quantity >= 0),
  measured_gas_unit      text CHECK (measured_gas_unit IS NULL OR measured_gas_unit IN ('kwh', 'm3', 'smc')),
  note                   text
);
CREATE INDEX recipe_equipment_rev_idx ON recipe_equipment_uses (revision_id);
CREATE INDEX recipe_equipment_eq_idx ON recipe_equipment_uses (company_id, equipment_id);

CREATE TABLE recipe_labor (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id      uuid NOT NULL REFERENCES companies(id),
  revision_id     uuid NOT NULL REFERENCES recipe_revisions(id),
  phase_id        uuid REFERENCES recipe_phases(id),
  position        integer NOT NULL,
  employee_id     uuid NOT NULL REFERENCES employees(id),
  active_minutes  numeric(10,2) CHECK (active_minutes IS NULL OR active_minutes > 0),
  share           numeric(7,6) NOT NULL DEFAULT 1 CHECK (share > 0 AND share <= 1),
  note            text
);
CREATE INDEX recipe_labor_rev_idx ON recipe_labor (revision_id);
CREATE INDEX recipe_labor_emp_idx ON recipe_labor (company_id, employee_id);

-- ==================== Snapshot e cache dei costi ====================

CREATE TABLE cost_snapshots (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id        uuid NOT NULL REFERENCES companies(id),
  recipe_id         uuid NOT NULL REFERENCES recipes(id),
  revision_id       uuid NOT NULL REFERENCES recipe_revisions(id),
  valuation_date    date NOT NULL,
  label             text,
  complete          boolean NOT NULL,
  total             numeric(18,6) NOT NULL,
  cost_per_kg       numeric(18,6),
  cost_per_portion  numeric(18,6),
  -- fotografia autosufficiente: risultato completo, comprese le sottoricette annidate e i valori usati
  data              jsonb NOT NULL,
  created_by        uuid REFERENCES users(id),
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX cost_snapshots_recipe_idx ON cost_snapshots (company_id, recipe_id, created_at DESC);

-- Cache della valorizzazione corrente per (ricetta, data); invalidata dagli eventi che cambiano i costi.
CREATE TABLE recipe_cost_cache (
  company_id        uuid NOT NULL REFERENCES companies(id),
  recipe_id         uuid NOT NULL REFERENCES recipes(id),
  valuation_date    date NOT NULL,
  revision_id       uuid NOT NULL,
  complete          boolean NOT NULL,
  total             numeric(18,6) NOT NULL,
  cost_per_kg       numeric(18,6),
  cost_per_portion  numeric(18,6),
  error_count       integer NOT NULL DEFAULT 0,
  data              jsonb NOT NULL,
  computed_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (recipe_id, valuation_date)
);
CREATE INDEX recipe_cost_cache_company_idx ON recipe_cost_cache (company_id, valuation_date);

-- ============================ Importazioni ============================

CREATE TABLE imports (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id      uuid NOT NULL REFERENCES companies(id),
  type            text NOT NULL CHECK (type IN ('ingredients', 'employees')),
  status          text NOT NULL DEFAULT 'uploaded'
                  CHECK (status IN ('uploaded', 'mapped', 'validating', 'validated', 'applying', 'applied', 'failed', 'cancelled')),
  original_name   text NOT NULL,
  storage_path    text NOT NULL,
  file_size       integer NOT NULL,
  file_kind       text NOT NULL CHECK (file_kind IN ('csv', 'xlsx')),
  options         jsonb NOT NULL DEFAULT '{}',
  mapping         jsonb,
  summary         jsonb,
  progress        integer NOT NULL DEFAULT 0,
  total_rows      integer,
  error           text,
  created_by      uuid REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  validated_at    timestamptz,
  confirmed_at    timestamptz,
  applied_at      timestamptz,
  lock_version    integer NOT NULL DEFAULT 1
);
CREATE INDEX imports_company_idx ON imports (company_id, created_at DESC);

CREATE TABLE import_rows (
  id            bigserial PRIMARY KEY,
  import_id     uuid NOT NULL REFERENCES imports(id) ON DELETE CASCADE,
  company_id    uuid NOT NULL REFERENCES companies(id),
  row_number    integer NOT NULL,
  raw           jsonb NOT NULL,
  normalized    jsonb,
  action        text CHECK (action IN ('create', 'update', 'skip', 'error')),
  target_id     uuid,
  errors        jsonb,
  warnings      jsonb,
  UNIQUE (import_id, row_number)
);

-- Coda di lavoro minimale su database (nessun servizio esterno richiesto).
CREATE TABLE jobs (
  id          bigserial PRIMARY KEY,
  type        text NOT NULL,
  payload     jsonb NOT NULL,
  status      text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'done', 'failed')),
  attempts    integer NOT NULL DEFAULT 0,
  run_at      timestamptz NOT NULL DEFAULT now(),
  locked_at   timestamptz,
  error       text,
  -- chiave di idempotenza: un secondo accodamento dello stesso lavoro è ignorato
  dedupe_key  text UNIQUE,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX jobs_queue_idx ON jobs (status, run_at);

-- ============================ Audit ============================

CREATE TABLE audit_logs (
  id           bigserial PRIMARY KEY,
  company_id   uuid REFERENCES companies(id),
  user_id      uuid REFERENCES users(id),
  entity_type  text NOT NULL,
  entity_id    text,
  action       text NOT NULL,
  -- nomi dei campi modificati e valori non sensibili; mai le retribuzioni
  details      jsonb,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_logs_company_idx ON audit_logs (company_id, created_at DESC);
