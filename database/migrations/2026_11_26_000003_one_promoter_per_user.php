<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

/**
 * NUOVO — un solo codice promo per persona. Se per caso un utente avesse già due promotori
 * (creati in contemporanea dal superadmin e dal ristoratore), il più vecchio resta collegato
 * all'utente e gli altri diventano promotori «esterni»: nessuna azienda presentata va persa.
 */
return new class extends Migration
{
    public function up(): void
    {
        $dups = DB::table('promoters')->whereNotNull('user_id')->groupBy('user_id')->havingRaw('count(*) > 1')->pluck('user_id');
        foreach ($dups as $userId) {
            $ids = DB::table('promoters')->where('user_id', $userId)->orderBy('created_at')->pluck('id');
            DB::table('promoters')->whereIn('id', $ids->slice(1)->all())->update(['user_id' => null]);
        }
        Schema::table('promoters', function (Blueprint $t) {
            $t->unique('user_id', 'promoters_user_unique');
        });
    }

    public function down(): void
    {
        Schema::table('promoters', function (Blueprint $t) {
            $t->dropUnique('promoters_user_unique');
        });
    }
};
