<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/** NUOVO — come è stata letta la bolletta: 'ai' (Anthropic, conteggiata nel limite mensile) o 'local' (testo del PDF). */
return new class extends Migration
{
    public function up(): void
    {
        Schema::table('tariff_bills', function (Blueprint $t) {
            $t->string('read_method', 10)->nullable()->after('extraction_status');
        });
    }

    public function down(): void
    {
        Schema::table('tariff_bills', function (Blueprint $t) {
            $t->dropColumn('read_method');
        });
    }
};
