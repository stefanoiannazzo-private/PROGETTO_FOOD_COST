<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * NUOVO — prodotti non alimentari (legna, bicchieri, box, detersivi…): niente peso del pezzo da chiedere.
 * Impostazione per categoria (ingredient_categories, solo le categorie che il titolare ha toccato: le altre
 * si riconoscono dal nome) ed eccezione sul singolo prodotto (ingredients.non_food: null = come la categoria).
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::create('ingredient_categories', function (Blueprint $t) {
            $t->char('id', 36)->primary();
            $t->char('company_id', 36);
            $t->string('name', 255);
            $t->boolean('non_food');
            $t->dateTime('updated_at', 3)->useCurrent();
            $t->unique(['company_id', 'name']);
            $t->foreign('company_id')->references('id')->on('companies');
        });
        Schema::table('ingredients', function (Blueprint $t) {
            $t->boolean('non_food')->nullable()->after('unit_weight_kg');
        });
    }

    public function down(): void
    {
        Schema::table('ingredients', fn (Blueprint $t) => $t->dropColumn('non_food'));
        Schema::dropIfExists('ingredient_categories');
    }
};
