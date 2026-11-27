<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

/**
 * NUOVO — Nome della sala unico per azienda (un doppio clic ne creava due uguali).
 * Le sale doppie già esistenti non vengono cancellate: si rinominano «Nome (2)» e il titolare decide.
 */
return new class extends Migration
{
    public function up(): void
    {
        $seen = [];
        foreach (DB::table('dining_areas')->orderBy('created_at')->get() as $a) {
            $k = $a->company_id.'|'.mb_strtolower(trim($a->name));
            if (! isset($seen[$k])) {
                $seen[$k] = 1;

                continue;
            }
            do {
                $seen[$k]++;
                $name = mb_substr(trim($a->name), 0, 54).' ('.$seen[$k].')';
            } while (DB::table('dining_areas')->where('company_id', $a->company_id)->where('name', $name)->exists());
            DB::table('dining_areas')->where('id', $a->id)->update(['name' => $name]);
        }
        Schema::table('dining_areas', function (Blueprint $t) {
            $t->unique(['company_id', 'name']);
        });
    }

    public function down(): void
    {
        Schema::table('dining_areas', function (Blueprint $t) {
            $t->dropUnique(['company_id', 'name']);
        });
    }
};
