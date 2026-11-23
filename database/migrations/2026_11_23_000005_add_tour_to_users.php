<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/** NUOVO — guida del primo accesso: quando l'utente l'ha completata o chiusa (non ricompare su altri dispositivi). */
return new class extends Migration
{
    public function up(): void
    {
        Schema::table('users', function (Blueprint $t) {
            $t->dateTime('tour_completed_at', 3)->nullable();
        });
    }

    public function down(): void
    {
        Schema::table('users', function (Blueprint $t) {
            $t->dropColumn('tour_completed_at');
        });
    }
};
