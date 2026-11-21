<?php

declare(strict_types=1);

namespace App\Services;

use App\Support\Clock;
use Illuminate\Support\Facades\DB;

/** Registro delle operazioni (port di services/audit.ts). Mai importi retributivi, password o token. */
final class Audit
{
    private const SENSITIVE = ['gross_monthly', 'extra_monthly', 'contributions_value', 'other_monthly_costs', 'password_hash', 'password', 'token', 'token_hash'];

    public static function log(?string $companyId, ?string $userId, string $entityType, ?string $entityId, string $action, ?array $details = null): void
    {
        DB::table('audit_logs')->insert([
            'company_id' => $companyId,
            'user_id' => $userId,
            'entity_type' => $entityType,
            'entity_id' => $entityId,
            'action' => $action,
            'details' => $details !== null ? json_encode(self::scrub($details), JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES) : null,
            'created_at' => Clock::now(),
        ]);
    }

    private static function scrub(array $obj): array
    {
        $out = [];
        foreach ($obj as $k => $v) {
            if (in_array($k, self::SENSITIVE, true)) {
                $out[$k] = '[riservato]';
            } elseif (is_array($v) && ! array_is_list($v)) {
                $out[$k] = self::scrub($v);
            } else {
                $out[$k] = $v;
            }
        }

        return $out;
    }

    /** Campi cambiati tra due insiemi di valori (confronto come stringhe, come l'originale). */
    public static function diff(array $before, array $after): array
    {
        $changes = [];
        foreach ($after as $k => $b) {
            $a = $before[$k] ?? null;
            if ((string) ($a ?? '') !== (string) ($b ?? '')) {
                $changes[$k] = ['from' => $a, 'to' => $b];
            }
        }

        return $changes;
    }

    /** Normalizza i numeri provenienti dal database ("1.500000" → "1.5") per il confronto. */
    public static function normalizeNum(mixed $v): mixed
    {
        if (is_string($v) && preg_match('/^-?\d+(\.\d+)?$/', $v)) {
            return \App\Domain\Costing\Dec::of($v)->toFixed();
        }

        return $v;
    }
}
