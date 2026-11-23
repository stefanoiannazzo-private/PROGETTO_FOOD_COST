<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * NUOVO — Avvisi di variazione dei costi (ricette e prodotti) e quando ogni utente li ha visti.
 * Un prezzo di prodotto collegato alla fattura da cui arriva (storico prezzi).
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::create('change_alerts', function (Blueprint $t) {
            $t->char('id', 36)->primary();
            $t->char('company_id', 36);
            $t->string('entity_type', 12); // recipe | ingredient
            $t->char('entity_id', 36);
            $t->string('message', 2000);
            $t->string('source', 200)->nullable();
            $t->decimal('before_value', 18, 6)->nullable();
            $t->decimal('after_value', 18, 6)->nullable();
            $t->decimal('before_portion', 18, 6)->nullable();
            $t->decimal('after_portion', 18, 6)->nullable();
            $t->string('unit', 6)->nullable();
            $t->char('created_by', 36)->nullable();
            $t->dateTime('created_at', 3);
            $t->index(['company_id', 'created_at'], 'change_alerts_company_idx');
            $t->index(['entity_type', 'entity_id', 'created_at'], 'change_alerts_entity_idx');
            $t->foreign('company_id')->references('id')->on('companies');
        });

        Schema::create('alert_reads', function (Blueprint $t) {
            $t->char('user_id', 36);
            $t->char('company_id', 36);
            $t->string('entity_type', 12);
            $t->char('entity_id', 36);
            $t->dateTime('seen_at', 3);
            $t->primary(['user_id', 'entity_type', 'entity_id']);
            $t->foreign('user_id')->references('id')->on('users')->cascadeOnDelete();
        });

        Schema::table('ingredient_prices', function (Blueprint $t) {
            $t->char('supplier_invoice_id', 36)->nullable();
            $t->foreign('supplier_invoice_id')->references('id')->on('supplier_invoices')->nullOnDelete();
        });
    }

    public function down(): void
    {
        Schema::table('ingredient_prices', function (Blueprint $t) {
            $t->dropForeign(['supplier_invoice_id']);
            $t->dropColumn('supplier_invoice_id');
        });
        Schema::dropIfExists('alert_reads');
        Schema::dropIfExists('change_alerts');
    }
};
