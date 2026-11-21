<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

/**
 * Schema FOOD COST per MySQL 8.0.16+ (port di apps/api/src/db/migrations/001_schema.sql).
 *
 * Conversioni rispetto a PostgreSQL:
 * - uuid → CHAR(36) generato dall'applicazione; timestamptz → DATETIME(3) in UTC; text[] e jsonb → JSON;
 * - UNIQUE (company_id, lower(code)) → UNIQUE (company_id, code) con collation utf8mb4_0900_as_ci
 *   (non distingue maiuscole/minuscole ma distingue gli accenti, come lower());
 * - i vincoli CHECK sono gli stessi dell'originale (MySQL li applica dalla 8.0.16).
 *
 * Novità rispetto all'originale (marcate con NUOVO):
 * - employee_cost_configs.extra_monthly: voce extra della retribuzione, sommata al lordo mensile;
 * - ingredient_prices.supplier e agent_name: fornitore e agente registrati su ogni prezzo, per le statistiche;
 * - comparison_groups e comparison_group_items: gruppi di ricette equivalenti per i confronti del superadmin.
 */
return new class extends Migration
{
    private const UNITS = "('g','kg','ml','cl','l','pz')";

    public function up(): void
    {
        $ci = 'utf8mb4_0900_as_ci';
        $uuid = fn (Blueprint $t, string $col) => $t->char($col, 36);
        $ts = fn (Blueprint $t, string $col) => $t->dateTime($col, 3);
        $created = fn (Blueprint $t) => $t->dateTime('created_at', 3)->useCurrent();

        /* ===================== Aziende, utenti, accessi ===================== */

        Schema::create('companies', function (Blueprint $t) use ($uuid, $ts, $created) {
            $uuid($t, 'id');
            $t->primary('id');
            $t->string('name', 255);
            $created($t);
            $ts($t, 'archived_at')->nullable();
        });

        Schema::create('users', function (Blueprint $t) use ($uuid, $ts, $created, $ci) {
            $uuid($t, 'id');
            $t->primary('id');
            $t->string('email', 254)->collation($ci);
            $t->string('name', 255);
            $t->string('password_hash', 255)->nullable();
            $t->boolean('is_active')->default(true);
            $t->boolean('is_platform_admin')->default(false);
            $created($t);
            $ts($t, 'last_login_at')->nullable();
            $t->unique('email', 'users_email_uq');
        });

        Schema::create('memberships', function (Blueprint $t) use ($uuid, $created) {
            $uuid($t, 'id');
            $t->primary('id');
            $uuid($t, 'company_id');
            $uuid($t, 'user_id');
            $t->string('role', 20);
            $t->json('extra_permissions');
            $t->boolean('is_active')->default(true);
            $created($t);
            $t->unique(['company_id', 'user_id']);
            $t->index('user_id', 'memberships_user_idx');
            $t->foreign('company_id')->references('id')->on('companies');
            $t->foreign('user_id')->references('id')->on('users');
        });

        Schema::create('sessions', function (Blueprint $t) use ($uuid, $ts, $created) {
            $t->string('token_hash', 64);
            $t->primary('token_hash');
            $uuid($t, 'user_id');
            $uuid($t, 'active_company_id')->nullable();
            $created($t);
            $ts($t, 'last_seen_at')->useCurrent();
            $ts($t, 'expires_at');
            $t->index('user_id', 'sessions_user_idx');
            $t->foreign('user_id')->references('id')->on('users')->cascadeOnDelete();
            $t->foreign('active_company_id')->references('id')->on('companies');
        });

        Schema::create('password_resets', function (Blueprint $t) use ($uuid, $ts, $created) {
            $t->string('token_hash', 64);
            $t->primary('token_hash');
            $uuid($t, 'user_id');
            $ts($t, 'expires_at');
            $ts($t, 'used_at')->nullable();
            $created($t);
            $t->foreign('user_id')->references('id')->on('users')->cascadeOnDelete();
        });

        Schema::create('invitations', function (Blueprint $t) use ($uuid, $ts, $created, $ci) {
            $uuid($t, 'id');
            $t->primary('id');
            $uuid($t, 'company_id');
            $t->string('email', 254)->collation($ci);
            $t->string('name', 255);
            $t->string('role', 20);
            $t->json('extra_permissions');
            $t->string('token_hash', 64)->unique();
            $uuid($t, 'invited_by')->nullable();
            $ts($t, 'expires_at');
            $ts($t, 'accepted_at')->nullable();
            $created($t);
            $t->index('company_id', 'invitations_company_idx');
            $t->foreign('company_id')->references('id')->on('companies');
            $t->foreign('invited_by')->references('id')->on('users');
        });

        /* ============================ Ingredienti ============================ */

        Schema::create('ingredients', function (Blueprint $t) use ($uuid, $ts, $created, $ci) {
            $uuid($t, 'id');
            $t->primary('id');
            $uuid($t, 'company_id');
            $t->string('code', 255)->collation($ci);
            $t->string('name', 255);
            $t->string('category', 255)->nullable();
            $t->string('supplier', 255)->nullable();
            $t->text('notes')->nullable();
            $t->string('purchase_unit', 255)->default('confezione');
            $t->decimal('package_content', 18, 6);
            $t->string('package_unit', 2);
            $t->string('usage_unit', 2);
            $t->decimal('edible_yield', 9, 6)->default(1);
            $t->decimal('density_kg_per_l', 18, 6)->nullable();
            $t->decimal('unit_weight_kg', 18, 6)->nullable();
            $ts($t, 'archived_at')->nullable();
            $created($t);
            $ts($t, 'updated_at')->useCurrent();
            $t->unsignedInteger('lock_version')->default(1);
            $t->unique(['company_id', 'code'], 'ingredients_code_uq');
            $t->index(['company_id', 'archived_at', 'name'], 'ingredients_list_idx');
            $t->index(['company_id', 'category'], 'ingredients_category_idx');
            $t->index(['company_id', 'supplier'], 'ingredients_supplier_idx');
            $t->foreign('company_id')->references('id')->on('companies');
        });
        $this->check('ingredients', [
            'ingredients_content_chk' => 'package_content > 0',
            'ingredients_package_unit_chk' => 'package_unit IN '.self::UNITS,
            'ingredients_usage_unit_chk' => 'usage_unit IN '.self::UNITS,
            'ingredients_yield_chk' => 'edible_yield > 0 AND edible_yield <= 1',
            'ingredients_density_chk' => 'density_kg_per_l IS NULL OR density_kg_per_l > 0',
            'ingredients_weight_chk' => 'unit_weight_kg IS NULL OR unit_weight_kg > 0',
        ]);

        Schema::create('ingredient_prices', function (Blueprint $t) use ($uuid, $created) {
            $uuid($t, 'id');
            $t->primary('id');
            $uuid($t, 'company_id');
            $uuid($t, 'ingredient_id');
            $t->decimal('package_price', 18, 6);
            $t->decimal('package_content', 18, 6);
            $t->string('package_unit', 2);
            $t->date('valid_from');
            $t->string('source', 255)->nullable();
            // NUOVO: fornitore al momento del prezzo e agente commerciale (facoltativo)
            $t->string('supplier', 255)->nullable();
            $t->string('agent_name', 255)->nullable();
            $t->text('notes')->nullable();
            $uuid($t, 'import_id')->nullable();
            $uuid($t, 'created_by')->nullable();
            $created($t);
            $t->unique(['ingredient_id', 'valid_from']);
            $t->index(['company_id', 'ingredient_id', 'valid_from'], 'ingredient_prices_lookup_idx');
            $t->index(['company_id', 'agent_name'], 'ingredient_prices_agent_idx');
            $t->foreign('company_id')->references('id')->on('companies');
            $t->foreign('ingredient_id')->references('id')->on('ingredients');
            $t->foreign('created_by')->references('id')->on('users');
        });
        $this->check('ingredient_prices', [
            'ingredient_prices_price_chk' => 'package_price >= 0',
            'ingredient_prices_content_chk' => 'package_content > 0',
            'ingredient_prices_unit_chk' => 'package_unit IN '.self::UNITS,
        ]);

        /* ============================== Utenze ============================== */

        Schema::create('utility_tariffs', function (Blueprint $t) use ($uuid, $ts, $created) {
            $uuid($t, 'id');
            $t->primary('id');
            $uuid($t, 'company_id');
            $t->string('name', 255);
            $t->string('kind', 20);
            $t->string('unit', 10);
            $t->text('notes')->nullable();
            $ts($t, 'archived_at')->nullable();
            $created($t);
            $ts($t, 'updated_at')->useCurrent();
            $t->index(['company_id', 'kind'], 'utility_tariffs_company_idx');
            $t->foreign('company_id')->references('id')->on('companies');
        });
        $this->check('utility_tariffs', [
            'utility_tariffs_kind_chk' => "kind IN ('electricity','gas','water')",
            'utility_tariffs_unit_chk' => "unit IN ('kwh','m3','smc')",
            'utility_tariffs_el_chk' => "kind <> 'electricity' OR unit = 'kwh'",
            'utility_tariffs_water_chk' => "kind <> 'water' OR unit = 'm3'",
        ]);

        Schema::create('tariff_versions', function (Blueprint $t) use ($uuid, $created) {
            $uuid($t, 'id');
            $t->primary('id');
            $uuid($t, 'company_id');
            $uuid($t, 'tariff_id');
            $t->decimal('price_per_unit', 18, 8);
            $t->date('valid_from');
            $t->string('origin', 10);
            $t->decimal('m3_to_smc', 18, 8)->nullable();
            $t->decimal('smc_to_kwh', 18, 8)->nullable();
            $t->json('bill')->nullable();
            $t->text('notes')->nullable();
            $uuid($t, 'created_by')->nullable();
            $created($t);
            $t->unique(['tariff_id', 'valid_from']);
            $t->index(['company_id', 'tariff_id', 'valid_from'], 'tariff_versions_lookup_idx');
            $t->foreign('company_id')->references('id')->on('companies');
            $t->foreign('tariff_id')->references('id')->on('utility_tariffs');
            $t->foreign('created_by')->references('id')->on('users');
        });
        $this->check('tariff_versions', [
            'tariff_versions_price_chk' => 'price_per_unit >= 0',
            'tariff_versions_origin_chk' => "origin IN ('direct','bill')",
            'tariff_versions_m3_chk' => 'm3_to_smc IS NULL OR m3_to_smc > 0',
            'tariff_versions_kwh_chk' => 'smc_to_kwh IS NULL OR smc_to_kwh > 0',
        ]);

        /* ======================= Strumenti e macchinari ======================= */

        Schema::create('equipment', function (Blueprint $t) use ($uuid, $ts, $created, $ci) {
            $uuid($t, 'id');
            $t->primary('id');
            $uuid($t, 'company_id');
            $t->string('code', 255)->collation($ci);
            $t->string('name', 255);
            $t->string('category', 255)->nullable();
            $t->text('description')->nullable();
            $t->string('power_type', 10);
            $t->string('status', 20)->default('active');
            $t->string('capacity', 255)->nullable();
            $t->decimal('electric_power_kw', 12, 4)->nullable();
            $t->decimal('usage_coefficient', 6, 4)->nullable();
            $t->decimal('preheat_coefficient', 6, 4)->nullable();
            $t->decimal('hold_coefficient', 6, 4)->nullable();
            $uuid($t, 'electric_tariff_id')->nullable();
            $t->string('gas_mode', 10)->nullable();
            $t->decimal('gas_flow_per_hour', 12, 6)->nullable();
            $t->string('gas_flow_unit', 5)->nullable();
            $t->decimal('gas_power_kw', 12, 4)->nullable();
            $t->decimal('gas_load_factor', 6, 4)->nullable();
            $uuid($t, 'gas_tariff_id')->nullable();
            $ts($t, 'archived_at')->nullable();
            $created($t);
            $ts($t, 'updated_at')->useCurrent();
            $t->unsignedInteger('lock_version')->default(1);
            $t->unique(['company_id', 'code'], 'equipment_code_uq');
            $t->index(['company_id', 'archived_at', 'name'], 'equipment_list_idx');
            $t->foreign('company_id')->references('id')->on('companies');
            $t->foreign('electric_tariff_id')->references('id')->on('utility_tariffs');
            $t->foreign('gas_tariff_id')->references('id')->on('utility_tariffs');
        });
        $coef = fn ($c) => "{$c} IS NULL OR ({$c} > 0 AND {$c} <= 1)";
        $this->check('equipment', [
            'equipment_power_type_chk' => "power_type IN ('electric','gas','mixed','manual')",
            'equipment_status_chk' => "status IN ('active','maintenance','inactive')",
            'equipment_el_kw_chk' => 'electric_power_kw IS NULL OR electric_power_kw > 0',
            'equipment_usage_chk' => $coef('usage_coefficient'),
            'equipment_preheat_chk' => $coef('preheat_coefficient'),
            'equipment_hold_chk' => $coef('hold_coefficient'),
            'equipment_gas_mode_chk' => "gas_mode IS NULL OR gas_mode IN ('flow','energy')",
            'equipment_gas_flow_chk' => 'gas_flow_per_hour IS NULL OR gas_flow_per_hour > 0',
            'equipment_gas_unit_chk' => "gas_flow_unit IS NULL OR gas_flow_unit IN ('m3','smc')",
            'equipment_gas_kw_chk' => 'gas_power_kw IS NULL OR gas_power_kw > 0',
            'equipment_load_chk' => $coef('gas_load_factor'),
        ]);

        /* ============================ Dipendenti ============================ */

        Schema::create('employees', function (Blueprint $t) use ($uuid, $ts, $created, $ci) {
            $uuid($t, 'id');
            $t->primary('id');
            $uuid($t, 'company_id');
            $t->string('code', 255)->collation($ci);
            $t->string('first_name', 255);
            $t->string('last_name', 255);
            $t->string('job_title', 255)->nullable();
            $t->string('status', 20)->default('active');
            $uuid($t, 'user_id')->nullable();
            $ts($t, 'archived_at')->nullable();
            $created($t);
            $ts($t, 'updated_at')->useCurrent();
            $t->unique(['company_id', 'code'], 'employees_code_uq');
            $t->index(['company_id', 'archived_at', 'last_name'], 'employees_list_idx');
            $t->foreign('company_id')->references('id')->on('companies');
            $t->foreign('user_id')->references('id')->on('users');
        });
        $this->check('employees', ['employees_status_chk' => "status IN ('active','inactive')"]);

        Schema::create('employee_cost_configs', function (Blueprint $t) use ($uuid, $created) {
            $uuid($t, 'id');
            $t->primary('id');
            $uuid($t, 'company_id');
            $uuid($t, 'employee_id');
            $t->date('valid_from');
            $t->decimal('gross_monthly', 12, 2);
            // NUOVO: voce extra della retribuzione, sommata al lordo mensile
            $t->decimal('extra_monthly', 12, 2)->nullable();
            $t->string('contributions_mode', 10);
            $t->decimal('contributions_value', 12, 4)->nullable();
            $t->decimal('other_monthly_costs', 12, 2)->default(0);
            $t->decimal('productive_hours', 8, 2);
            $t->text('notes')->nullable();
            $uuid($t, 'import_id')->nullable();
            $uuid($t, 'created_by')->nullable();
            $created($t);
            $t->unique(['employee_id', 'valid_from']);
            $t->index(['company_id', 'employee_id', 'valid_from'], 'employee_cost_lookup_idx');
            $t->foreign('company_id')->references('id')->on('companies');
            $t->foreign('employee_id')->references('id')->on('employees');
            $t->foreign('created_by')->references('id')->on('users');
        });
        $this->check('employee_cost_configs', [
            'ecc_gross_chk' => 'gross_monthly >= 0',
            'ecc_extra_chk' => 'extra_monthly IS NULL OR extra_monthly >= 0',
            'ecc_mode_chk' => "contributions_mode IN ('none','amount','percent')",
            'ecc_other_chk' => 'other_monthly_costs >= 0',
            'ecc_hours_chk' => 'productive_hours > 0',
            'ecc_contrib_chk' => "(contributions_mode = 'none' AND contributions_value IS NULL) OR (contributions_mode IN ('amount','percent') AND contributions_value IS NOT NULL AND contributions_value >= 0)",
        ]);

        /* ============================== Ricette ============================== */

        Schema::create('recipes', function (Blueprint $t) use ($uuid, $created, $ts, $ci) {
            $uuid($t, 'id');
            $t->primary('id');
            $uuid($t, 'company_id');
            $t->string('code', 255)->collation($ci);
            $t->string('title', 255);
            $t->string('category', 255)->nullable();
            $t->text('description')->nullable();
            $t->string('status', 20)->default('draft');
            $uuid($t, 'current_revision_id')->nullable();
            $uuid($t, 'duplicated_from_id')->nullable();
            $created($t);
            $ts($t, 'updated_at')->useCurrent();
            $t->unsignedInteger('lock_version')->default(1);
            $t->unique(['company_id', 'code'], 'recipes_code_uq');
            $t->index(['company_id', 'status', 'title'], 'recipes_list_idx');
            $t->foreign('company_id')->references('id')->on('companies');
        });
        Schema::table('recipes', fn (Blueprint $t) => $t->foreign('duplicated_from_id')->references('id')->on('recipes'));
        $this->check('recipes', ['recipes_status_chk' => "status IN ('draft','active','archived')"]);

        Schema::create('recipe_revisions', function (Blueprint $t) use ($uuid, $created) {
            $uuid($t, 'id');
            $t->primary('id');
            $uuid($t, 'company_id');
            $uuid($t, 'recipe_id');
            $t->unsignedInteger('number');
            $t->text('instructions')->nullable();
            $t->decimal('final_quantity', 14, 4)->nullable();
            $t->string('final_unit', 2)->nullable();
            $t->decimal('final_weight_kg', 14, 4)->nullable();
            $t->decimal('portions', 10, 2)->nullable();
            $t->decimal('declared_duration_minutes', 10, 2)->nullable();
            $t->text('yield_notes')->nullable();
            $uuid($t, 'created_by')->nullable();
            $created($t);
            $t->unique(['recipe_id', 'number']);
            $t->foreign('company_id')->references('id')->on('companies');
            $t->foreign('recipe_id')->references('id')->on('recipes');
            $t->foreign('created_by')->references('id')->on('users');
        });
        $this->check('recipe_revisions', [
            'rr_qty_chk' => 'final_quantity IS NULL OR final_quantity > 0',
            'rr_unit_chk' => 'final_unit IS NULL OR final_unit IN '.self::UNITS,
            'rr_weight_chk' => 'final_weight_kg IS NULL OR final_weight_kg > 0',
            'rr_portions_chk' => 'portions IS NULL OR portions > 0',
            'rr_duration_chk' => 'declared_duration_minutes IS NULL OR declared_duration_minutes > 0',
        ]);
        Schema::table('recipes', fn (Blueprint $t) => $t->foreign('current_revision_id', 'recipes_current_revision_fk')->references('id')->on('recipe_revisions'));

        Schema::create('recipe_phases', function (Blueprint $t) use ($uuid) {
            $uuid($t, 'id');
            $t->primary('id');
            $uuid($t, 'company_id');
            $uuid($t, 'revision_id');
            $t->integer('position');
            $t->string('name', 255);
            $t->text('description')->nullable();
            $t->decimal('start_offset_minutes', 10, 2)->nullable();
            $t->decimal('duration_minutes', 10, 2)->nullable();
            $t->index('revision_id', 'recipe_phases_rev_idx');
            $t->foreign('company_id')->references('id')->on('companies');
            $t->foreign('revision_id')->references('id')->on('recipe_revisions');
        });

        Schema::create('recipe_components', function (Blueprint $t) use ($uuid) {
            $uuid($t, 'id');
            $t->primary('id');
            $uuid($t, 'company_id');
            $uuid($t, 'revision_id');
            $t->integer('position');
            $uuid($t, 'ingredient_id')->nullable();
            $uuid($t, 'sub_recipe_id')->nullable();
            $t->decimal('quantity', 14, 4)->nullable();
            $t->string('unit', 2);
            $t->text('note')->nullable();
            $t->index('revision_id', 'recipe_components_rev_idx');
            $t->index(['company_id', 'ingredient_id'], 'recipe_components_ing_idx');
            $t->index(['company_id', 'sub_recipe_id'], 'recipe_components_sub_idx');
            $t->foreign('company_id')->references('id')->on('companies');
            $t->foreign('revision_id')->references('id')->on('recipe_revisions');
            $t->foreign('ingredient_id')->references('id')->on('ingredients');
            $t->foreign('sub_recipe_id')->references('id')->on('recipes');
        });
        $this->check('recipe_components', [
            'rc_qty_chk' => 'quantity IS NULL OR quantity > 0',
            'rc_unit_chk' => 'unit IN '.self::UNITS,
            'rc_ref_chk' => '(ingredient_id IS NULL) <> (sub_recipe_id IS NULL)',
        ]);

        Schema::create('recipe_equipment_uses', function (Blueprint $t) use ($uuid) {
            $uuid($t, 'id');
            $t->primary('id');
            $uuid($t, 'company_id');
            $uuid($t, 'revision_id');
            $uuid($t, 'phase_id')->nullable();
            $t->integer('position');
            $uuid($t, 'equipment_id');
            $t->string('segment', 10)->default('work');
            $t->decimal('minutes', 10, 2)->nullable();
            $t->decimal('share', 7, 6)->default(1);
            $t->json('sources')->nullable();
            $t->decimal('measured_electric_kwh', 14, 6)->nullable();
            $t->decimal('measured_gas_quantity', 14, 6)->nullable();
            $t->string('measured_gas_unit', 5)->nullable();
            $t->text('note')->nullable();
            $t->index('revision_id', 'recipe_equipment_rev_idx');
            $t->index(['company_id', 'equipment_id'], 'recipe_equipment_eq_idx');
            $t->foreign('company_id')->references('id')->on('companies');
            $t->foreign('revision_id')->references('id')->on('recipe_revisions');
            $t->foreign('phase_id')->references('id')->on('recipe_phases');
            $t->foreign('equipment_id')->references('id')->on('equipment');
        });
        $this->check('recipe_equipment_uses', [
            'reu_segment_chk' => "segment IN ('preheat','work','hold')",
            'reu_minutes_chk' => 'minutes IS NULL OR minutes > 0',
            'reu_share_chk' => 'share > 0 AND share <= 1',
            'reu_kwh_chk' => 'measured_electric_kwh IS NULL OR measured_electric_kwh >= 0',
            'reu_gas_chk' => 'measured_gas_quantity IS NULL OR measured_gas_quantity >= 0',
            'reu_gas_unit_chk' => "measured_gas_unit IS NULL OR measured_gas_unit IN ('kwh','m3','smc')",
        ]);

        Schema::create('recipe_labor', function (Blueprint $t) use ($uuid) {
            $uuid($t, 'id');
            $t->primary('id');
            $uuid($t, 'company_id');
            $uuid($t, 'revision_id');
            $uuid($t, 'phase_id')->nullable();
            $t->integer('position');
            $uuid($t, 'employee_id');
            $t->decimal('active_minutes', 10, 2)->nullable();
            $t->decimal('share', 7, 6)->default(1);
            $t->text('note')->nullable();
            $t->index('revision_id', 'recipe_labor_rev_idx');
            $t->index(['company_id', 'employee_id'], 'recipe_labor_emp_idx');
            $t->foreign('company_id')->references('id')->on('companies');
            $t->foreign('revision_id')->references('id')->on('recipe_revisions');
            $t->foreign('phase_id')->references('id')->on('recipe_phases');
            $t->foreign('employee_id')->references('id')->on('employees');
        });
        $this->check('recipe_labor', [
            'rl_minutes_chk' => 'active_minutes IS NULL OR active_minutes > 0',
            'rl_share_chk' => 'share > 0 AND share <= 1',
        ]);

        /* ==================== Snapshot e cache dei costi ==================== */

        Schema::create('cost_snapshots', function (Blueprint $t) use ($uuid, $created) {
            $uuid($t, 'id');
            $t->primary('id');
            $uuid($t, 'company_id');
            $uuid($t, 'recipe_id');
            $uuid($t, 'revision_id');
            $t->date('valuation_date');
            $t->string('label', 255)->nullable();
            $t->boolean('complete');
            $t->decimal('total', 18, 6);
            $t->decimal('cost_per_kg', 18, 6)->nullable();
            $t->decimal('cost_per_portion', 18, 6)->nullable();
            $t->json('data');
            $uuid($t, 'created_by')->nullable();
            $created($t);
            $t->index(['company_id', 'recipe_id', 'created_at'], 'cost_snapshots_recipe_idx');
            $t->foreign('company_id')->references('id')->on('companies');
            $t->foreign('recipe_id')->references('id')->on('recipes');
            $t->foreign('revision_id')->references('id')->on('recipe_revisions');
            $t->foreign('created_by')->references('id')->on('users');
        });

        Schema::create('recipe_cost_cache', function (Blueprint $t) use ($uuid, $ts) {
            $uuid($t, 'company_id');
            $uuid($t, 'recipe_id');
            $t->date('valuation_date');
            $uuid($t, 'revision_id');
            $t->boolean('complete');
            $t->decimal('total', 18, 6);
            $t->decimal('cost_per_kg', 18, 6)->nullable();
            $t->decimal('cost_per_portion', 18, 6)->nullable();
            $t->integer('error_count')->default(0);
            $t->json('data');
            $ts($t, 'computed_at')->useCurrent();
            $t->primary(['recipe_id', 'valuation_date']);
            $t->index(['company_id', 'valuation_date'], 'recipe_cost_cache_company_idx');
            $t->foreign('company_id')->references('id')->on('companies');
            $t->foreign('recipe_id')->references('id')->on('recipes');
        });

        /* ============================ Importazioni ============================ */

        Schema::create('imports', function (Blueprint $t) use ($uuid, $ts, $created) {
            $uuid($t, 'id');
            $t->primary('id');
            $uuid($t, 'company_id');
            $t->string('type', 20);
            $t->string('status', 20)->default('uploaded');
            $t->string('original_name', 255);
            $t->string('storage_path', 500);
            $t->unsignedInteger('file_size');
            $t->string('file_kind', 5);
            $t->json('options');
            $t->json('mapping')->nullable();
            $t->json('summary')->nullable();
            $t->integer('progress')->default(0);
            $t->integer('total_rows')->nullable();
            $t->text('error')->nullable();
            $uuid($t, 'created_by')->nullable();
            $created($t);
            $ts($t, 'validated_at')->nullable();
            $ts($t, 'confirmed_at')->nullable();
            $ts($t, 'applied_at')->nullable();
            $t->unsignedInteger('lock_version')->default(1);
            $t->index(['company_id', 'created_at'], 'imports_company_idx');
            $t->foreign('company_id')->references('id')->on('companies');
            $t->foreign('created_by')->references('id')->on('users');
        });
        $this->check('imports', [
            'imports_type_chk' => "type IN ('ingredients','employees')",
            'imports_status_chk' => "status IN ('uploaded','mapped','validating','validated','applying','applied','failed','cancelled')",
            'imports_kind_chk' => "file_kind IN ('csv','xlsx')",
        ]);

        Schema::create('import_rows', function (Blueprint $t) use ($uuid) {
            $t->bigIncrements('id');
            $uuid($t, 'import_id');
            $uuid($t, 'company_id');
            $t->integer('row_number');
            $t->json('raw');
            $t->json('normalized')->nullable();
            $t->string('action', 10)->nullable();
            $uuid($t, 'target_id')->nullable();
            $t->json('errors')->nullable();
            $t->json('warnings')->nullable();
            $t->unique(['import_id', 'row_number']);
            $t->foreign('import_id')->references('id')->on('imports')->cascadeOnDelete();
            $t->foreign('company_id')->references('id')->on('companies');
        });
        $this->check('import_rows', ['import_rows_action_chk' => "action IS NULL OR action IN ('create','update','skip','error')"]);

        // Coda di lavoro su database. Senza worker: i lavori avanzano a blocchi durante il polling e con il cron.
        Schema::create('jobs', function (Blueprint $t) use ($ts, $created) {
            $t->bigIncrements('id');
            $t->string('type', 50);
            $t->json('payload');
            $t->string('status', 10)->default('queued');
            $t->integer('attempts')->default(0);
            $ts($t, 'run_at')->useCurrent();
            $ts($t, 'locked_at')->nullable();
            $t->text('error')->nullable();
            $t->string('dedupe_key', 255)->nullable()->unique();
            $created($t);
            $t->index(['status', 'run_at'], 'jobs_queue_idx');
        });
        $this->check('jobs', ['jobs_status_chk' => "status IN ('queued','running','done','failed')"]);

        /* ============================== Audit ============================== */

        Schema::create('audit_logs', function (Blueprint $t) use ($uuid, $created) {
            $t->bigIncrements('id');
            $uuid($t, 'company_id')->nullable();
            $uuid($t, 'user_id')->nullable();
            $t->string('entity_type', 50);
            $t->string('entity_id', 100)->nullable();
            $t->string('action', 50);
            $t->json('details')->nullable();
            $created($t);
            $t->index(['company_id', 'created_at'], 'audit_logs_company_idx');
            $t->foreign('company_id')->references('id')->on('companies');
            $t->foreign('user_id')->references('id')->on('users');
        });

        /* ====================== NUOVO: piattaforma SaaS ====================== */

        // Gruppi di ricette equivalenti (anche con nomi diversi) scelti dal superadmin per i confronti.
        Schema::create('comparison_groups', function (Blueprint $t) use ($uuid, $ts, $created) {
            $uuid($t, 'id');
            $t->primary('id');
            $t->string('name', 255);
            $t->text('notes')->nullable();
            $uuid($t, 'created_by')->nullable();
            $created($t);
            $ts($t, 'updated_at')->useCurrent();
            $t->foreign('created_by')->references('id')->on('users');
        });

        Schema::create('comparison_group_items', function (Blueprint $t) use ($uuid, $created) {
            $uuid($t, 'id');
            $t->primary('id');
            $uuid($t, 'group_id');
            $uuid($t, 'company_id');
            $uuid($t, 'recipe_id');
            $created($t);
            $t->unique(['group_id', 'recipe_id']);
            $t->foreign('group_id')->references('id')->on('comparison_groups')->cascadeOnDelete();
            $t->foreign('company_id')->references('id')->on('companies');
            $t->foreign('recipe_id')->references('id')->on('recipes');
        });

        // Cache e limitazione delle richieste su database (hosting condiviso: niente Redis obbligatorio).
        Schema::create('cache', function (Blueprint $t) {
            $t->string('key')->primary();
            $t->mediumText('value');
            $t->integer('expiration')->index();
        });
        Schema::create('cache_locks', function (Blueprint $t) {
            $t->string('key')->primary();
            $t->string('owner');
            $t->integer('expiration')->index();
        });
    }

    public function down(): void
    {
        Schema::disableForeignKeyConstraints();
        foreach ([
            'cache_locks', 'cache', 'comparison_group_items', 'comparison_groups', 'audit_logs', 'jobs', 'import_rows', 'imports',
            'recipe_cost_cache', 'cost_snapshots', 'recipe_labor', 'recipe_equipment_uses', 'recipe_components', 'recipe_phases',
            'recipes', 'recipe_revisions', 'employee_cost_configs', 'employees', 'equipment', 'tariff_versions', 'utility_tariffs',
            'ingredient_prices', 'ingredients', 'invitations', 'password_resets', 'sessions', 'memberships', 'users', 'companies',
        ] as $table) {
            Schema::dropIfExists($table);
        }
        Schema::enableForeignKeyConstraints();
    }

    /** @param array<string, string> $checks */
    private function check(string $table, array $checks): void
    {
        foreach ($checks as $name => $expr) {
            DB::statement("ALTER TABLE `{$table}` ADD CONSTRAINT `{$name}` CHECK ({$expr})");
        }
    }
};
