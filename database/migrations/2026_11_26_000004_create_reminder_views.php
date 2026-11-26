<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/** NUOVO — promemoria mensile «carica fatture e bollette»: quante volte è stato mostrato a ogni utente, per azienda e mese. */
return new class extends Migration
{
    public function up(): void
    {
        Schema::create('reminder_views', function (Blueprint $t) {
            $t->char('user_id', 36);
            $t->char('company_id', 36);
            $t->char('period', 7); // AAAA-MM
            $t->unsignedTinyInteger('shown')->default(0);
            $t->dateTime('last_shown_at', 3)->nullable();
            $t->dateTime('done_at', 3)->nullable(); // «Ho già fatto»: basta per questo mese
            $t->primary(['user_id', 'company_id', 'period']);
            $t->foreign('user_id')->references('id')->on('users')->cascadeOnDelete();
            $t->foreign('company_id')->references('id')->on('companies')->cascadeOnDelete();
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('reminder_views');
    }
};
