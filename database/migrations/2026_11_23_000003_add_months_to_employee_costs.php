<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

/**
 * NUOVO — mensilità pagate in un anno (12 = tredicesima spalmata o assente, 13, 14…) e numero di mensilità
 * su cui si paga la voce extra. NULL = 12 (comportamento dell'originale: costo mensile × 12 / 12).
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::table('employee_cost_configs', function (Blueprint $t) {
            $t->unsignedTinyInteger('months_paid')->nullable()->after('extra_monthly');
            $t->unsignedTinyInteger('extra_months')->nullable()->after('months_paid');
        });
        DB::statement('ALTER TABLE employee_cost_configs ADD CONSTRAINT ecc_months_chk CHECK (months_paid IS NULL OR (months_paid BETWEEN 12 AND 16))');
        DB::statement('ALTER TABLE employee_cost_configs ADD CONSTRAINT ecc_extra_months_chk CHECK (extra_months IS NULL OR (extra_months BETWEEN 0 AND 16))');
    }

    public function down(): void
    {
        DB::statement('ALTER TABLE employee_cost_configs DROP CHECK ecc_months_chk');
        DB::statement('ALTER TABLE employee_cost_configs DROP CHECK ecc_extra_months_chk');
        Schema::table('employee_cost_configs', function (Blueprint $t) {
            $t->dropColumn(['months_paid', 'extra_months']);
        });
    }
};
