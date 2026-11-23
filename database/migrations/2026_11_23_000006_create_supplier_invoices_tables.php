<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * NUOVO — Fatture elettroniche dei fornitori caricate a mano (XML / P7M / ZIP) e memoria degli abbinamenti
 * riga di fattura → prodotto, per fornitore. La fattura resta in "draft" finché il ristoratore non conferma.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::create('supplier_invoices', function (Blueprint $t) {
            $t->char('id', 36)->primary();
            $t->char('company_id', 36);
            $t->string('status', 10); // draft | applied
            $t->string('supplier_name', 120);
            $t->string('supplier_vat', 30);
            $t->string('doc_type', 10)->nullable();
            $t->string('number', 40);
            $t->date('invoice_date')->nullable();
            $t->decimal('total_amount', 14, 2)->nullable();
            $t->string('original_name', 200);
            $t->char('sha256', 64);
            $t->mediumText('xml');
            $t->json('lines');
            $t->json('summary')->nullable();
            $t->char('created_by', 36)->nullable();
            $t->dateTime('created_at', 3)->useCurrent();
            $t->char('applied_by', 36)->nullable();
            $t->dateTime('applied_at', 3)->nullable();
            $t->index(['company_id', 'status', 'created_at'], 'supplier_invoices_list_idx');
            $t->index(['company_id', 'supplier_vat', 'number', 'invoice_date'], 'supplier_invoices_dup_idx');
            $t->foreign('company_id')->references('id')->on('companies');
            $t->foreign('created_by')->references('id')->on('users');
            $t->foreign('applied_by')->references('id')->on('users');
        });

        Schema::create('invoice_line_maps', function (Blueprint $t) {
            $t->char('id', 36)->primary();
            $t->char('company_id', 36);
            $t->string('supplier_vat', 30);
            $t->string('match_key', 190);
            $t->string('action', 10); // product | ignore
            $t->char('ingredient_id', 36)->nullable();
            $t->string('mode', 6)->nullable();
            $t->decimal('package_content', 14, 4)->nullable();
            $t->string('package_unit', 5)->nullable();
            $t->string('purchase_unit', 40)->nullable();
            $t->dateTime('updated_at', 3)->useCurrent();
            $t->unique(['company_id', 'supplier_vat', 'match_key'], 'invoice_line_maps_key');
            $t->foreign('company_id')->references('id')->on('companies');
            $t->foreign('ingredient_id')->references('id')->on('ingredients')->cascadeOnDelete();
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('invoice_line_maps');
        Schema::dropIfExists('supplier_invoices');
    }
};
