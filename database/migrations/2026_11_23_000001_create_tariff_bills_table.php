<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

/**
 * NUOVO — Archivio delle bollette caricate (PDF o foto) per ogni utenza, con i dati letti automaticamente.
 * Il file resta nello storico anche se il valore della tariffa generato viene eliminato (version_id → NULL).
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::create('tariff_bills', function (Blueprint $t) {
            $t->char('id', 36)->primary();
            $t->char('company_id', 36);
            $t->char('tariff_id', 36);
            $t->char('version_id', 36)->nullable();
            $t->string('original_name', 200);
            $t->string('storage_path', 255);
            $t->string('mime', 40);
            $t->unsignedInteger('file_size');
            $t->char('sha256', 64);
            $t->string('supplier', 120)->nullable();
            $t->date('period_from')->nullable();
            $t->date('period_to')->nullable();
            $t->decimal('total_amount', 14, 2)->nullable();
            $t->string('extraction_status', 10);
            $t->string('extraction_error', 500)->nullable();
            $t->json('extracted')->nullable();
            $t->char('created_by', 36)->nullable();
            $t->dateTime('created_at', 3)->useCurrent();
            $t->index(['company_id', 'tariff_id', 'created_at'], 'tariff_bills_lookup_idx');
            $t->index(['company_id', 'created_at'], 'tariff_bills_month_idx');
            $t->foreign('company_id')->references('id')->on('companies');
            $t->foreign('tariff_id')->references('id')->on('utility_tariffs');
            $t->foreign('version_id')->references('id')->on('tariff_versions')->nullOnDelete();
            $t->foreign('created_by')->references('id')->on('users');
        });
        DB::statement("ALTER TABLE tariff_bills ADD CONSTRAINT tariff_bills_status_chk CHECK (extraction_status IN ('ok','failed','off','limit'))");
    }

    public function down(): void
    {
        Schema::dropIfExists('tariff_bills');
    }
};
