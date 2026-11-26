<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * NUOVO — Promotori (referral): ogni promotore ha un codice promo; le aziende nuove possono indicarlo
 * alla creazione (superadmin) o all'accettazione dell'invito del primo amministratore.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::create('promoters', function (Blueprint $t) {
            $t->char('id', 36)->primary();
            $t->string('code', 24);
            $t->string('name', 120);
            $t->string('email', 254)->nullable();
            $t->string('phone', 40)->nullable();
            $t->char('user_id', 36)->nullable(); // utente del portale, se il promotore ne ha uno
            $t->text('notes')->nullable();
            $t->boolean('is_active')->default(true);
            $t->char('created_by', 36)->nullable();
            $t->dateTime('created_at', 3);
            $t->unique('code');
            $t->index('user_id');
            $t->foreign('user_id')->references('id')->on('users')->nullOnDelete();
        });

        Schema::table('companies', function (Blueprint $t) {
            $t->char('promoter_id', 36)->nullable();
            $t->string('promo_code', 24)->nullable(); // codice usato, conservato anche se poi il promotore lo cambia
            $t->string('referred_via', 12)->nullable(); // platform | invite | signup
            $t->dateTime('referred_at', 3)->nullable();
            $t->index('promoter_id');
            $t->foreign('promoter_id')->references('id')->on('promoters')->nullOnDelete();
        });
    }

    public function down(): void
    {
        Schema::table('companies', function (Blueprint $t) {
            $t->dropForeign(['promoter_id']);
            $t->dropIndex(['promoter_id']);
            $t->dropColumn(['promoter_id', 'promo_code', 'referred_via', 'referred_at']);
        });
        Schema::dropIfExists('promoters');
    }
};
