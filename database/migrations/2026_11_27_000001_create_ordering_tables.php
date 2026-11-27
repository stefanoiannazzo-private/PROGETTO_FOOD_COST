<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * NUOVO — Area «Ordini» (sala, cucina, bancone).
 * Fondamenta: postazioni, sezioni e voci del menu, sale e tavoli, PIN degli operatori, impostazioni.
 * Servizio: tavoli aperti (anche uniti), comande, righe ordinate con portata e stato, VIA delle portate.
 * Ogni riga conserva nome, prezzo, IVA e costo del momento: le statistiche non cambiano se poi cambia il menu.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::create('stations', function (Blueprint $t) {
            $t->char('id', 36)->primary();
            $t->char('company_id', 36);
            $t->string('name', 60);
            $t->string('kind', 12)->default('kitchen'); // kitchen | bar | other
            $t->unsignedSmallInteger('sort')->default(0);
            $t->boolean('is_active')->default(true);
            $t->dateTime('created_at', 3)->useCurrent();
            $t->index(['company_id', 'sort']);
            $t->foreign('company_id')->references('id')->on('companies');
        });

        Schema::create('menu_sections', function (Blueprint $t) {
            $t->char('id', 36)->primary();
            $t->char('company_id', 36);
            $t->string('name', 80);
            $t->char('station_id', 36)->nullable(); // postazione predefinita delle voci
            $t->boolean('is_drinks')->default(false); // bevande: non seguono le portate, partono subito
            $t->unsignedSmallInteger('sort')->default(0);
            $t->boolean('is_visible')->default(true);
            $t->dateTime('created_at', 3)->useCurrent();
            $t->index(['company_id', 'sort']);
            $t->foreign('company_id')->references('id')->on('companies');
            $t->foreign('station_id')->references('id')->on('stations')->nullOnDelete();
        });

        Schema::create('menu_items', function (Blueprint $t) {
            $t->char('id', 36)->primary();
            $t->char('company_id', 36);
            $t->char('section_id', 36);
            $t->string('source_type', 12); // recipe | ingredient
            $t->char('recipe_id', 36)->nullable();
            $t->char('ingredient_id', 36)->nullable();
            $t->decimal('portion_qty', 14, 6)->nullable(); // solo prodotti pronti: quanto se ne serve (es. 1 pz, 0,2 l)
            $t->string('portion_unit', 8)->nullable();
            $t->string('name', 160);
            $t->string('description', 500)->nullable();
            $t->decimal('price', 12, 2);
            $t->decimal('vat_percent', 5, 2)->default(10);
            $t->char('station_id', 36)->nullable(); // se vuota vale quella della sezione
            $t->boolean('is_available')->default(true); // false = esaurito oggi
            $t->boolean('is_public')->default(true); // visibile nel menu digitale
            $t->unsignedSmallInteger('sort')->default(0);
            $t->dateTime('archived_at', 3)->nullable();
            $t->dateTime('created_at', 3)->useCurrent();
            $t->dateTime('updated_at', 3)->useCurrent();
            $t->index(['company_id', 'section_id', 'sort']);
            $t->index(['company_id', 'recipe_id']);
            $t->foreign('company_id')->references('id')->on('companies');
            $t->foreign('section_id')->references('id')->on('menu_sections');
            $t->foreign('recipe_id')->references('id')->on('recipes');
            $t->foreign('ingredient_id')->references('id')->on('ingredients');
            $t->foreign('station_id')->references('id')->on('stations')->nullOnDelete();
        });

        Schema::create('dining_areas', function (Blueprint $t) {
            $t->char('id', 36)->primary();
            $t->char('company_id', 36);
            $t->string('name', 60);
            $t->unsignedSmallInteger('sort')->default(0);
            $t->dateTime('created_at', 3)->useCurrent();
            $t->index(['company_id', 'sort']);
            $t->foreign('company_id')->references('id')->on('companies');
        });

        Schema::create('dining_tables', function (Blueprint $t) {
            $t->char('id', 36)->primary();
            $t->char('company_id', 36);
            $t->char('area_id', 36)->nullable();
            $t->string('label', 20); // «5», «12B»
            $t->unsignedSmallInteger('seats')->default(4);
            $t->unsignedSmallInteger('sort')->default(0);
            $t->boolean('is_active')->default(true);
            $t->string('qr_token', 32); // per il QR del menu digitale
            $t->dateTime('created_at', 3)->useCurrent();
            $t->unique(['company_id', 'label']);
            $t->unique('qr_token');
            $t->foreign('company_id')->references('id')->on('companies');
            $t->foreign('area_id')->references('id')->on('dining_areas')->nullOnDelete();
        });

        Schema::create('ordering_settings', function (Blueprint $t) {
            $t->char('company_id', 36)->primary();
            $t->string('public_token', 32)->unique(); // menu digitale del locale
            $t->string('public_mode', 12)->default('open'); // off | open | required | optional
            $t->string('gift_text', 160)->nullable(); // omaggio per chi si registra (modalità facoltativa)
            $t->boolean('guest_ordering')->default(false); // predisposto: il cliente ordina dal QR (non ancora attivo)
            $t->decimal('cover_charge', 8, 2)->default(0); // coperto per persona
            $t->dateTime('updated_at', 3)->useCurrent();
            $t->foreign('company_id')->references('id')->on('companies');
        });

        Schema::table('memberships', function (Blueprint $t) {
            $t->string('pin_hash', 255)->nullable(); // PIN rapido sui tablet condivisi
            $t->string('pin_lookup', 64)->nullable(); // impronta per l'unicità del PIN nell'azienda
            $t->unique(['company_id', 'pin_lookup']);
        });
        Schema::table('sessions', function (Blueprint $t) {
            $t->boolean('service_device')->default(false); // tablet di servizio: solo area ordini, operatore via PIN
        });

        Schema::create('table_sessions', function (Blueprint $t) {
            $t->char('id', 36)->primary();
            $t->char('company_id', 36);
            $t->string('label', 60); // «5» oppure «5-6» se uniti
            $t->unsignedSmallInteger('covers')->default(0);
            $t->string('status', 10)->default('open'); // open | closed | cancelled
            $t->unsignedSmallInteger('next_course')->default(2); // prossima portata da mandare con VIA
            $t->char('opened_by', 36)->nullable();
            $t->dateTime('opened_at', 3);
            $t->char('closed_by', 36)->nullable();
            $t->dateTime('closed_at', 3)->nullable();
            $t->decimal('total', 12, 2)->nullable(); // totale del preconto alla chiusura
            $t->string('notes', 500)->nullable();
            $t->index(['company_id', 'status']);
            $t->index(['company_id', 'opened_at']);
            $t->foreign('company_id')->references('id')->on('companies');
        });

        Schema::create('table_session_tables', function (Blueprint $t) {
            $t->char('session_id', 36);
            $t->char('table_id', 36);
            $t->char('company_id', 36);
            $t->boolean('is_open')->default(true); // un tavolo può stare in un solo tavolo aperto
            $t->primary(['session_id', 'table_id']);
            $t->index(['company_id', 'table_id', 'is_open']);
            $t->foreign('session_id')->references('id')->on('table_sessions')->cascadeOnDelete();
            $t->foreign('table_id')->references('id')->on('dining_tables');
        });

        Schema::create('order_items', function (Blueprint $t) {
            $t->char('id', 36)->primary();
            $t->char('company_id', 36);
            $t->char('session_id', 36);
            $t->char('batch_id', 36); // comanda (un invio del cameriere)
            $t->char('menu_item_id', 36)->nullable();
            $t->char('recipe_id', 36)->nullable();
            $t->char('ingredient_id', 36)->nullable();
            $t->string('name', 160);
            $t->unsignedSmallInteger('qty');
            $t->decimal('unit_price', 12, 2);
            $t->decimal('vat_percent', 5, 2);
            $t->decimal('unit_cost', 14, 6)->nullable(); // costo per porzione al momento dell'ordine
            $t->unsignedSmallInteger('course')->default(1); // 0 = bevande, 1 = subito, 2+ = a seguire
            $t->char('station_id', 36)->nullable();
            $t->string('notes', 300)->nullable();
            $t->string('status', 10); // held | sent | preparing | ready | served | cancelled
            $t->char('waiter_id', 36)->nullable();
            $t->dateTime('created_at', 3);
            $t->dateTime('sent_at', 3)->nullable();
            $t->dateTime('ready_at', 3)->nullable();
            $t->dateTime('cancelled_at', 3)->nullable();
            $t->index(['company_id', 'station_id', 'status']);
            $t->index(['session_id']);
            $t->index(['company_id', 'created_at']);
            $t->foreign('company_id')->references('id')->on('companies');
            $t->foreign('session_id')->references('id')->on('table_sessions')->cascadeOnDelete();
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('order_items');
        Schema::dropIfExists('table_session_tables');
        Schema::dropIfExists('table_sessions');
        Schema::table('sessions', fn (Blueprint $t) => $t->dropColumn('service_device'));
        Schema::table('memberships', function (Blueprint $t) {
            $t->dropUnique(['company_id', 'pin_lookup']);
            $t->dropColumn(['pin_hash', 'pin_lookup']);
        });
        Schema::dropIfExists('ordering_settings');
        Schema::dropIfExists('dining_tables');
        Schema::dropIfExists('dining_areas');
        Schema::dropIfExists('menu_items');
        Schema::dropIfExists('menu_sections');
        Schema::dropIfExists('stations');
    }
};
