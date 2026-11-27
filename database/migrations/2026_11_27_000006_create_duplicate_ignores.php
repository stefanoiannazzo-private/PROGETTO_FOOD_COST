<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/** NUOVO — coppie di prodotti simili che il titolare ha detto essere diversi (es. «ali di pollo» e «ali di pollo bbq»). */
return new class extends Migration
{
    public function up(): void
    {
        Schema::create('duplicate_ignores', function (Blueprint $t) {
            $t->char('company_id', 36);
            $t->char('a_id', 36);
            $t->char('b_id', 36);
            $t->dateTime('created_at', 3)->useCurrent();
            $t->primary(['company_id', 'a_id', 'b_id']);
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('duplicate_ignores');
    }
};
