<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Support\Facades\DB;

/**
 * NUOVO — Il peso finale ora ricade sul peso totale degli ingredienti quando non è indicato:
 * i costi già calcolati e messi da parte vanno ricalcolati (gli snapshot non cambiano).
 */
return new class extends Migration
{
    public function up(): void
    {
        DB::table('recipe_cost_cache')->delete();
    }

    public function down(): void {}
};
