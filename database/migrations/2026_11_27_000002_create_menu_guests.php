<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/** NUOVO — clienti che si registrano dal menu digitale (QR), con il consenso privacy e l'eventuale omaggio. */
return new class extends Migration
{
    public function up(): void
    {
        Schema::create('menu_guests', function (Blueprint $t) {
            $t->char('id', 36)->primary();
            $t->char('company_id', 36);
            $t->string('first_name', 80);
            $t->string('last_name', 80);
            $t->string('email', 254);
            $t->string('phone', 40);
            $t->boolean('marketing_consent')->default(false);
            $t->dateTime('privacy_accepted_at', 3);
            $t->char('table_id', 36)->nullable();
            $t->char('token_hash', 64); // il telefono del cliente resta «registrato» per questo locale
            $t->string('gift_text', 160)->nullable();
            $t->string('gift_code', 12)->nullable();
            $t->dateTime('gift_redeemed_at', 3)->nullable();
            $t->dateTime('created_at', 3);
            $t->index(['company_id', 'created_at']);
            $t->index(['company_id', 'email']);
            $t->unique('token_hash');
            $t->foreign('company_id')->references('id')->on('companies');
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('menu_guests');
    }
};
