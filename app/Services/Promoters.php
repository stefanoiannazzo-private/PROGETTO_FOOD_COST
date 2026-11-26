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

    /**
     * Chiave di confronto tollerante agli errori di battitura: maiuscole/minuscole, spazi, trattini e punti
     * non contano, e le lettere che si confondono con le cifre valgono come la cifra (O→0, I e L→1).
     * Così «mario-24», «MARIO 24» e «MAR1O24» trovano lo stesso codice. L'unicità dei codici è su questa chiave.
     */
    public static function key(?string $code): string
    {
        $k = strtoupper(preg_replace('/[^A-Za-z0-9]/', '', (string) $code) ?? '');

        return strtr($k, ['O' => '0', 'I' => '1', 'L' => '1']);
    }

    /** Promotore attivo con quel codice (confronto tollerante), oppure null. */
    public static function findActive(?string $code): ?object
    {
        $key = self::key($code);
        if ($key === '') {
            return null;
        }

        return DB::table('promoters')->where('code_key', $key)->where('is_active', 1)->first();
    }

    /** Il codice (o uno equivalente) è già usato da un altro promotore? */
    public static function taken(string $code, ?string $exceptId = null): bool
    {
        return DB::table('promoters')->where('code_key', self::key($code))->when($exceptId, fn ($q) => $q->where('id', '<>', $exceptId))->exists();
    }

    /** Link da condividere: apre la richiesta di attivazione con il codice già compilato. */
    public static function link(string $code): string
    {
        return rtrim((string) config('foodcost.app_url'), '/').'/registrati?promo='.rawurlencode($code);
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
            if (! self::taken($code)) {
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
