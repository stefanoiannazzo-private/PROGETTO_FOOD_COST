<?php

declare(strict_types=1);

namespace App\Services;

use Illuminate\Support\Facades\DB;

/** Prossimo codice libero con prefisso (es. ING-00042), port di services/codes.ts. */
final class Codes
{
    public static function next(string $table, string $companyId, string $prefix): string
    {
        $max = 0;
        $codes = DB::table($table)->where('company_id', $companyId)->where('code', 'like', $prefix.'-%')->pluck('code');
        foreach ($codes as $code) {
            // confronto sensibile alle maiuscole, come l'operatore ~ di PostgreSQL
            if (preg_match('/^'.preg_quote($prefix, '/').'-(\d+)$/', $code, $m)) {
                $max = max($max, (int) $m[1]);
            }
        }

        return $prefix.'-'.str_pad((string) ($max + 1), 5, '0', STR_PAD_LEFT);
    }
}
