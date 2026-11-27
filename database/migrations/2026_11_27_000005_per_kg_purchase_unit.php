<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Support\Facades\DB;

/**
 * NUOVO — prodotti importati con «1 kg» o «1 l» ma segnati «a confezione»: se l'unità di misura è KG o L
 * il prezzo è sempre al kg / al litro. Cambia solo l'etichetta (purchase_unit): prezzi e costi restano identici.
 */
return new class extends Migration
{
    public function up(): void
    {
        foreach (['kg' => 'kg', 'l' => 'litro'] as $unit => $label) {
            DB::table('ingredients')->where('package_unit', $unit)->where('package_content', 1)
                ->whereIn(DB::raw('LOWER(TRIM(purchase_unit))'), ['confezione', 'conf', 'cf', ''])
                ->update(['purchase_unit' => $label]);
        }
    }

    public function down(): void
    {
    }
};
