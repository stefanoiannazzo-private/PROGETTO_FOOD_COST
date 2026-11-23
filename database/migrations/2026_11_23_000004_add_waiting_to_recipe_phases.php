<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/** NUOVO — fase di attesa (lievitazione, maturazione, riposo): nessuno lavora, conta solo nel tempo di preparazione. */
return new class extends Migration
{
    public function up(): void
    {
        Schema::table('recipe_phases', function (Blueprint $t) {
            $t->boolean('is_waiting')->default(false)->after('duration_minutes');
        });
    }

    public function down(): void
    {
        Schema::table('recipe_phases', function (Blueprint $t) {
            $t->dropColumn('is_waiting');
        });
    }
};
