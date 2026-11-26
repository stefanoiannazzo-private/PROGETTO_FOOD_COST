<?php

namespace App\Services;

use App\Support\AppError;
use App\Support\Clock;
use Illuminate\Support\Facades\DB;

/** NUOVO — codici promo dei promotori (referral). */
class Promoters
{
    public const CODE_PATTERN = '/^[A-Z0-9][A-Z0-9-]{2,22}[A-Z0-9]$/';

    public static function normalize(?string $code): string
    {
        return strtoupper(preg_replace('/\s+/', '', (string) $code) ?? '');
    }

    /** Promotore attivo con quel codice, oppure null. */
    public static function findActive(?string $code): ?object
    {
        $code = self::normalize($code);
        if ($code === '') {
            return null;
        }

        return DB::table('promoters')->where('code', $code)->where('is_active', 1)->first();
    }

    /** Come findActive ma con errore sul campo indicato se il codice non è valido. */
    public static function require(string $code, string $field = 'promoCode'): object
    {
        $p = self::findActive($code);
        if (! $p) {
            $msg = 'Codice promo non riconosciuto: controlla di averlo scritto giusto.';
            throw new AppError(422, 'validation_failed', $msg, ['fields' => [$field => $msg]]);
        }

        return $p;
    }

    /** Codice leggibile proposto dal nome: MARIO + 2 cifre, unico. */
    public static function suggest(string $name): string
    {
        $base = strtoupper(preg_replace('/[^A-Za-z]/', '', iconv('UTF-8', 'ASCII//TRANSLIT//IGNORE', explode(' ', trim($name))[0] ?? '') ?: '') ?? '');
        $base = substr($base !== '' ? $base : 'PROMO', 0, 10);
        if (strlen($base) < 3) {
            $base .= 'RQ';
        }
        for ($i = 0; $i < 50; $i++) {
            $code = $base.random_int(10, 99);
            if (! DB::table('promoters')->where('code', $code)->exists()) {
                return $code;
            }
        }

        return $base.strtoupper(bin2hex(random_bytes(3)));
    }

    public static function attach(string $companyId, object $promoter, string $via): void
    {
        DB::table('companies')->where('id', $companyId)->update([
            'promoter_id' => $promoter->id, 'promo_code' => $promoter->code, 'referred_via' => $via, 'referred_at' => Clock::now(),
        ]);
    }
}
