<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

/**
 * NUOVO — Coefficiente di redditività: costi fissi dell'attività, impostazioni (giorni di chiusura)
 * e prezzo in menu delle ricette. Tabelle separate: le tabelle dell'originale restano invariate.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::create('fixed_costs', function (Blueprint $t) {
            $t->char('id', 36)->primary();
            $t->char('company_id', 36);
            $t->string('name', 160);
            $t->string('category', 20);
            $t->decimal('amount', 14, 2);
            $t->string('period', 10);
            $t->date('valid_from');
            $t->date('valid_to')->nullable();
            $t->text('notes')->nullable();
            $t->char('created_by', 36)->nullable();
            $t->dateTime('created_at', 3)->useCurrent();
            $t->dateTime('updated_at', 3)->useCurrent();
            $t->index(['company_id', 'valid_from'], 'fixed_costs_company_idx');
            $t->foreign('company_id')->references('id')->on('companies');
            $t->foreign('created_by')->references('id')->on('users');
        });
        DB::statement("ALTER TABLE fixed_costs ADD CONSTRAINT fixed_costs_amount_chk CHECK (amount >= 0)");
        DB::statement("ALTER TABLE fixed_costs ADD CONSTRAINT fixed_costs_period_chk CHECK (period IN ('weekly','monthly','yearly'))");
        DB::statement("ALTER TABLE fixed_costs ADD CONSTRAINT fixed_costs_category_chk CHECK (category IN ('rent','mortgage','loan','leasing','insurance','utilities','services','other'))");
        DB::statement('ALTER TABLE fixed_costs ADD CONSTRAINT fixed_costs_dates_chk CHECK (valid_to IS NULL OR valid_to >= valid_from)');

        Schema::create('profitability_settings', function (Blueprint $t) {
            $t->char('company_id', 36)->primary();
            $t->json('closed_weekdays');
            $t->boolean('include_staff')->default(true);
            $t->char('reference_recipe_id', 36)->nullable();
            $t->dateTime('updated_at', 3)->useCurrent();
            $t->foreign('company_id')->references('id')->on('companies');
            $t->foreign('reference_recipe_id')->references('id')->on('recipes')->nullOnDelete();
        });

        Schema::create('recipe_prices', function (Blueprint $t) {
            $t->char('recipe_id', 36)->primary();
            $t->char('company_id', 36);
            $t->decimal('menu_price', 12, 2);
            $t->decimal('vat_percent', 5, 2)->default(10);
            $t->dateTime('updated_at', 3)->useCurrent();
            $t->index('company_id');
            $t->foreign('company_id')->references('id')->on('companies');
            $t->foreign('recipe_id')->references('id')->on('recipes')->cascadeOnDelete();
        });
        DB::statement('ALTER TABLE recipe_prices ADD CONSTRAINT recipe_prices_price_chk CHECK (menu_price >= 0)');
        DB::statement('ALTER TABLE recipe_prices ADD CONSTRAINT recipe_prices_vat_chk CHECK (vat_percent >= 0 AND vat_percent <= 100)');
    }

    public function down(): void
    {
        Schema::dropIfExists('recipe_prices');
        Schema::dropIfExists('profitability_settings');
        Schema::dropIfExists('fixed_costs');
    }
};
