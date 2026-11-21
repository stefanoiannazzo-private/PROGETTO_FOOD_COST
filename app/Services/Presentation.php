<?php

declare(strict_types=1);

namespace App\Services;

use App\Auth\AuthContext;
use App\Domain\Costing\Dec;

/** Permessi applicati ai risultati e confronto con lo snapshot (port di services/presentation.ts). */
final class Presentation
{
    /**
     * Senza costs.read nessun importo; senza salaries.read le righe di manodopera non riportano
     * costo al minuto né costo nominativo (resta il subtotale aggregato).
     */
    public static function redactCost(?array $cost, AuthContext $ctx): ?array
    {
        if (! $cost || ! $ctx->can('costs.read')) {
            return null;
        }
        if ($ctx->can('salaries.read')) {
            return $cost;
        }

        return self::stripSalaries($cost);
    }

    private static function stripSalaries(array $cost): array
    {
        $cost['laborLines'] = array_map(fn ($l) => [...$l, 'costPerMinute' => null, 'cost' => null], $cost['laborLines']);
        $cost['subrecipeLines'] = array_map(fn ($s) => [...$s, 'sub' => $s['sub'] ? self::stripSalaries($s['sub']) : null], $cost['subrecipeLines']);

        return $cost;
    }

    /** Confronto tra valorizzazione corrente e ultimo snapshot, con i motivi principali della variazione. */
    public static function compare(array $current, object $snap, bool $salariesVisible): array
    {
        $old = is_string($snap->data) ? json_decode($snap->data, true) : $snap->data;
        $reasons = [];
        if ($old['revisionId'] !== $current['revisionId']) {
            $reasons[] = 'Composizione modificata: revisione '.($old['revisionNumber'] ?? '?').' → '.($current['revisionNumber'] ?? '?').'.';
        }
        if ($old['finalWeightKg'] !== $current['finalWeightKg'] || $old['portions'] !== $current['portions']) {
            $reasons[] = 'Resa finale o numero di porzioni modificati.';
        }

        $oldIng = [];
        foreach ($old['ingredientLines'] as $l) {
            $oldIng[$l['ingredientId'] ?? ''] = $l;
        }
        foreach ($current['ingredientLines'] as $l) {
            $o = $oldIng[$l['ingredientId'] ?? ''] ?? null;
            if ($o && self::t($o['unitPrice']) && self::t($l['unitPrice']) && ! Dec::of($o['unitPrice'])->eq($l['unitPrice'])) {
                $reasons[] = "Prezzo di {$l['name']}: ".self::fmt($o['unitPrice']).' → '.self::fmt($l['unitPrice']).' €/'.($l['baseUnit'] ?? '').'.';
            }
        }
        $oldTariffs = [];
        foreach ($old['equipmentLines'] as $line) {
            foreach ($line['sources'] as $s) {
                if (self::t($s['tariffId'])) {
                    $oldTariffs[$s['tariffId']] = $s['tariffPrice'];
                }
            }
        }
        $seen = [];
        foreach ($current['equipmentLines'] as $line) {
            foreach ($line['sources'] as $s) {
                if (! self::t($s['tariffId']) || isset($seen[$s['tariffId']])) {
                    continue;
                }
                $seen[$s['tariffId']] = true;
                $o = $oldTariffs[$s['tariffId']] ?? null;
                if (self::t($o) && self::t($s['tariffPrice']) && ! Dec::of($o)->eq($s['tariffPrice'])) {
                    $reasons[] = 'Tariffa energetica variata: '.self::fmt($o, 4).' → '.self::fmt($s['tariffPrice'], 4)." €/{$s['tariffUnit']}.";
                }
            }
        }
        if (! Dec::of($old['labor'])->eq($current['labor'])) {
            $oldLab = [];
            foreach ($old['laborLines'] as $l) {
                $oldLab[$l['employeeId']] = $l['costPerMinute'];
            }
            $changed = false;
            foreach ($current['laborLines'] as $l) {
                if (array_key_exists($l['employeeId'], $oldLab) && $oldLab[$l['employeeId']] !== $l['costPerMinute']) {
                    $changed = true;
                }
            }
            $reasons[] = $changed ? ($salariesVisible ? 'Costo orario di uno o più dipendenti variato.' : 'Costo del lavoro variato.') : 'Manodopera della ricetta variata.';
        }
        $oldSub = [];
        foreach ($old['subrecipeLines'] as $l) {
            $oldSub[$l['recipeId']] = $l;
        }
        foreach ($current['subrecipeLines'] as $l) {
            $o = $oldSub[$l['recipeId']] ?? null;
            if ($o && self::t($o['unitCost']) && self::t($l['unitCost']) && ! Dec::of($o['unitCost'])->eq($l['unitCost'])) {
                $reasons[] = "Costo del semilavorato {$l['name']}: ".self::fmt($o['unitCost']).' → '.self::fmt($l['unitCost']).' € per unità.';
            }
        }
        if (! $reasons && ! Dec::of($old['total'])->eq($current['total'])) {
            $reasons[] = 'Variazione dovuta ai dati di costo alla data di valorizzazione.';
        }

        $delta = Dec::of($current['total'])->minus($old['total']);

        return [
            'snapshotId' => $snap->id,
            'snapshotCreatedAt' => \App\Support\Clock::iso($snap->created_at),
            'snapshotDate' => $snap->valuation_date,
            'snapshotLabel' => $snap->label,
            'snapshotTotal' => $old['total'],
            'currentTotal' => $current['total'],
            'deltaTotal' => $delta->toFixed(),
            'deltaPercent' => Dec::of($old['total'])->isZero() ? null : $delta->div($old['total'])->times(100)->toFixed(),
            'deltaPerKg' => self::t($old['costPerKg']) && self::t($current['costPerKg']) ? Dec::of($current['costPerKg'])->minus($old['costPerKg'])->toFixed() : null,
            'deltaPerPortion' => self::t($old['costPerPortion']) && self::t($current['costPerPortion']) ? Dec::of($current['costPerPortion'])->minus($old['costPerPortion'])->toFixed() : null,
            'reasons' => $reasons,
        ];
    }

    /** Verità "alla JavaScript" per stringhe: "0" è vero, solo null e "" sono falsi. */
    private static function t(mixed $v): bool
    {
        return $v !== null && $v !== '' && $v !== false;
    }

    private static function fmt(string $v, int $places = 2): string
    {
        return str_replace('.', ',', Dec::of($v)->toFixed($places));
    }
}
