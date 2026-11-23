<?php

declare(strict_types=1);

namespace App\Services;

use App\Domain\Costing\Calculators;
use App\Domain\Costing\Dec;
use App\Domain\Costing\Units;
use App\Support\Clock;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Log;
use Illuminate\Support\Str;
use Throwable;

/**
 * NUOVO — Avvisi di variazione dei costi, senza email né notifiche push.
 *
 * Prima di una modifica (nuovo prezzo, fattura, importazione, bolletta, costo del personale, strumento,
 * semilavorato) si "osserva" la situazione: prezzi correnti dei prodotti, tariffe correnti e costo delle
 * ricette interessate. Dopo la modifica si confronta: per ogni prodotto e ogni ricetta che cambia davvero
 * a oggi nasce un avviso. Ogni utente vede gli avvisi finché non apre la ricetta o il prodotto.
 * Un errore qui non deve mai bloccare l'operazione principale.
 */
final class ChangeAlerts
{
    private const KEEP_DAYS = 90;

    /**
     * Fotografia prima della modifica.
     *
     * @param  'ingredients'|'tariffs'|'employees'|'equipment'|'recipes'  $type
     */
    public static function watch(string $cid, string $type, array $ids): array
    {
        $w = ['cid' => $cid, 'type' => $type, 'ids' => array_values(array_unique($ids)), 'ok' => false];
        try {
            $today = Clock::today();
            $affected = Costing::affectedRecipes($cid, $type, $w['ids']);
            $w['recipesBefore'] = self::totals(Costing::currentValuations($cid, $affected, $today));
            if ($type === 'ingredients') {
                $w['pricesBefore'] = self::unitPrices($cid, $w['ids']);
            }
            if ($type === 'tariffs') {
                $w['tariffsBefore'] = self::tariffPrices($cid, $w['ids']);
            }
            $w['ok'] = true;
        } catch (Throwable $e) {
            Log::warning('ChangeAlerts::watch '.$e->getMessage());
        }

        return $w;
    }

    /**
     * Confronto dopo la modifica (da chiamare dopo Costing::invalidate) e creazione degli avvisi.
     *
     * @param  array{source?: ?string, label?: ?string, seenIngredients?: bool, skipRecipes?: list<string>}  $o
     */
    public static function commit(array $w, ?string $userId, array $o = []): void
    {
        if (! $w['ok']) {
            return;
        }
        try {
            DB::transaction(fn () => self::doCommit($w, $userId, $o));
        } catch (Throwable $e) {
            Log::warning('ChangeAlerts::commit '.$e->getMessage());
        }
    }

    private static function doCommit(array $w, ?string $userId, array $o): void
    {
        $cid = $w['cid'];
        $today = Clock::today();
        $now = Clock::now();
        $source = isset($o['source']) ? mb_substr((string) $o['source'], 0, 200) : null;
        $skip = $o['skipRecipes'] ?? [];

        // 1) motivi per elemento modificato
        $reasons = []; // id elemento => testo
        if ($w['type'] === 'ingredients') {
            $after = self::unitPrices($cid, $w['ids']);
            $names = DB::table('ingredients')->whereIn('id', $w['ids'])->pluck('name', 'id');
            foreach ($w['ids'] as $id) {
                $b = $w['pricesBefore'][$id] ?? null;
                $a = $after[$id] ?? null;
                if (self::samePrice($b, $a)) {
                    continue;
                }
                $txt = self::priceText($b, $a);
                $reasons[$id] = 'Prezzo di '.($names[$id] ?? 'un prodotto').': '.$txt;
                DB::table('change_alerts')->insert(self::row($cid, 'ingredient', $id, 'Prezzo: '.$txt, $source, $b['price'] ?? null, $a['price'] ?? null, null, null, $a['unit'] ?? $b['unit'] ?? null, $userId, $now));
                if (! empty($o['seenIngredients']) && $userId) {
                    self::markSeen($userId, $cid, 'ingredient', $id, $now);
                }
            }
            if (! $reasons && ! empty($o['label'])) {
                foreach ($w['ids'] as $id) {
                    $reasons[$id] = $o['label'];
                }
            }
        } elseif ($w['type'] === 'tariffs') {
            $after = self::tariffPrices($cid, $w['ids']);
            foreach ($w['ids'] as $id) {
                $b = $w['tariffsBefore'][$id] ?? null;
                $a = $after[$id] ?? null;
                $name = $a['name'] ?? $b['name'] ?? 'Utenza';
                $unit = $a['unit'] ?? $b['unit'] ?? '';
                if ($b && $a && $b['price'] !== null && $a['price'] !== null && Dec::of($b['price'])->eq($a['price'])) {
                    $reasons[$id] = $o['label'] ?? "Utenza {$name} aggiornata";

                    continue;
                }
                $reasons[$id] = "Utenza {$name}: ".self::money($b['price'] ?? null, 4).' → '.self::money($a['price'] ?? null, 4)." €/{$unit}".self::pct($b['price'] ?? null, $a['price'] ?? null);
            }
        } else {
            foreach ($w['ids'] as $id) {
                $reasons[$id] = $o['label'] ?? 'Dati modificati';
            }
        }
        if (! $reasons) {
            return;
        }

        // 2) ricette: per ognuna i motivi che la riguardano e il costo prima/dopo
        $byRecipe = [];
        foreach ($reasons as $id => $txt) {
            foreach (Costing::affectedRecipes($cid, $w['type'], [$id]) as $rid) {
                if (! in_array($rid, $skip, true)) {
                    $byRecipe[$rid][] = $txt;
                }
            }
        }
        if (! $byRecipe) {
            return;
        }
        $after = self::totals(Costing::currentValuations($cid, array_keys($byRecipe), $today));
        foreach ($byRecipe as $rid => $lines) {
            $b = $w['recipesBefore'][$rid] ?? null;
            $a = $after[$rid] ?? null;
            if ($b && $a && $b['total'] === $a['total'] && $b['portion'] === $a['portion'] && $b['complete'] === $a['complete']) {
                continue; // nessun effetto sul costo di oggi (es. prezzo con data futura)
            }
            $msg = implode("\n", array_slice(array_values(array_unique($lines)), 0, 8));
            DB::table('change_alerts')->insert(self::row($cid, 'recipe', $rid, $msg, $source, $b['total'] ?? null, $a['total'] ?? null, $b['portion'] ?? null, $a['portion'] ?? null, null, $userId, $now));
        }
    }

    /** Avvisi non ancora visti dall'utente per una ricetta o un prodotto. */
    public static function forEntity(string $cid, string $userId, string $type, string $id): array
    {
        $seen = DB::table('alert_reads')->where('user_id', $userId)->where('entity_type', $type)->where('entity_id', $id)->value('seen_at');
        $q = DB::table('change_alerts as a')->leftJoin('users as u', 'u.id', '=', 'a.created_by')
            ->where('a.company_id', $cid)->where('a.entity_type', $type)->where('a.entity_id', $id)
            ->where('a.created_at', '>=', self::since());
        if ($seen) {
            $q->where('a.created_at', '>', $seen);
        }

        return $q->orderByDesc('a.created_at')->limit(20)
            ->get(['a.id', 'a.message', 'a.source', 'a.before_value', 'a.after_value', 'a.before_portion', 'a.after_portion', 'a.unit', 'a.created_at', 'u.name as created_by'])
            ->map(fn ($r) => [
                'id' => $r->id,
                'lines' => explode("\n", $r->message),
                'source' => $r->source,
                'before' => self::n($r->before_value),
                'after' => self::n($r->after_value),
                'beforePortion' => self::n($r->before_portion),
                'afterPortion' => self::n($r->after_portion),
                'unit' => $r->unit,
                'createdAt' => Clock::iso($r->created_at),
                'createdBy' => $r->created_by,
            ])->all();
    }

    /** Ricette e prodotti con avvisi non visti dall'utente (per elenchi e menu). */
    public static function unseen(string $cid, string $userId): array
    {
        $rows = DB::table('change_alerts as a')
            ->leftJoin('alert_reads as r', fn ($j) => $j->on('r.entity_type', '=', 'a.entity_type')->on('r.entity_id', '=', 'a.entity_id')->where('r.user_id', '=', $userId))
            ->where('a.company_id', $cid)->where('a.created_at', '>=', self::since())
            ->where(fn ($w) => $w->whereNull('r.seen_at')->orWhereColumn('a.created_at', '>', 'r.seen_at'))
            ->groupBy('a.entity_type', 'a.entity_id')
            ->get(['a.entity_type', 'a.entity_id', DB::raw('COUNT(*) as n'), DB::raw('MAX(a.created_at) as last_at')]);
        $out = ['recipes' => [], 'ingredients' => []];
        foreach ($rows as $r) {
            $out[$r->entity_type === 'recipe' ? 'recipes' : 'ingredients'][] = ['id' => $r->entity_id, 'count' => (int) $r->n, 'lastAt' => Clock::iso($r->last_at)];
        }

        return $out;
    }

    public static function markSeen(string $userId, string $cid, string $type, string $id, ?string $at = null): void
    {
        DB::table('alert_reads')->upsert(
            [['user_id' => $userId, 'company_id' => $cid, 'entity_type' => $type, 'entity_id' => $id, 'seen_at' => $at ?? Clock::now()]],
            ['user_id', 'entity_type', 'entity_id'],
            ['seen_at', 'company_id'],
        );
    }

    /** Segna come visti tutti gli avvisi di un tipo. */
    public static function markAllSeen(string $userId, string $cid, string $type): int
    {
        $u = self::unseen($cid, $userId)[$type === 'recipe' ? 'recipes' : 'ingredients'];
        $now = Clock::now();
        foreach ($u as $x) {
            self::markSeen($userId, $cid, $type, $x['id'], $now);
        }

        return count($u);
    }

    /** Pulizia periodica (cron). */
    public static function prune(): int
    {
        return DB::table('change_alerts')->where('created_at', '<', self::since())->delete();
    }

    /* ------------------------------------------------------------------ */

    private static function since(): string
    {
        return Clock::plusSeconds(-self::KEEP_DAYS * 86400);
    }

    /** @return array<string, array{total: ?string, portion: ?string, complete: bool}> */
    private static function totals(array $vals): array
    {
        $out = [];
        foreach ($vals as $id => $v) {
            $out[$id] = [
                'total' => isset($v['total']) ? Dec::of($v['total'])->toFixed(4) : null,
                'portion' => isset($v['costPerPortion']) && $v['costPerPortion'] !== null ? Dec::of($v['costPerPortion'])->toFixed(4) : null,
                'complete' => (bool) ($v['complete'] ?? false),
            ];
        }

        return $out;
    }

    /** Prezzo normalizzato (al kg / litro / pezzo) valido oggi per ogni prodotto. */
    public static function unitPrices(string $cid, array $ids): array
    {
        if (! $ids) {
            return [];
        }
        $today = Clock::today();
        $rows = DB::table('ingredient_prices as p')->where('p.company_id', $cid)->whereIn('p.ingredient_id', $ids)->where('p.valid_from', '<=', $today)
            ->whereRaw('p.valid_from = (SELECT MAX(p2.valid_from) FROM ingredient_prices p2 WHERE p2.ingredient_id = p.ingredient_id AND p2.valid_from <= ?)', [$today])
            ->get(['p.ingredient_id', 'p.package_price', 'p.package_content', 'p.package_unit']);
        $out = [];
        foreach ($rows as $r) {
            $out[$r->ingredient_id] = [
                'price' => Calculators::normalizedPrice(['packagePrice' => Dec::of($r->package_price), 'packageContent' => Dec::of($r->package_content), 'packageUnit' => $r->package_unit])->toFixed(4),
                'unit' => Units::BASE_UNIT[Units::dimensionOf($r->package_unit)],
            ];
        }

        return $out;
    }

    private static function tariffPrices(string $cid, array $ids): array
    {
        $today = Clock::today();
        $out = [];
        foreach (DB::table('utility_tariffs')->where('company_id', $cid)->whereIn('id', $ids)->get(['id', 'name', 'unit']) as $t) {
            $p = DB::table('tariff_versions')->where('tariff_id', $t->id)->where('valid_from', '<=', $today)->orderByDesc('valid_from')->value('price_per_unit');
            $out[$t->id] = ['name' => $t->name, 'unit' => match ($t->unit) { 'kwh' => 'kWh', 'smc' => 'Smc', 'm3' => 'm³', default => $t->unit }, 'price' => $p !== null ? Dec::of($p)->toFixed(6) : null];
        }

        return $out;
    }

    private static function samePrice(?array $b, ?array $a): bool
    {
        if (! $b || ! $a) {
            return $b === $a;
        }

        return $b['unit'] === $a['unit'] && Dec::of($b['price'])->eq($a['price']);
    }

    private static function priceText(?array $b, ?array $a): string
    {
        $unit = match ($a['unit'] ?? $b['unit'] ?? 'kg') { 'l' => 'litro', 'pz' => 'pezzo', default => 'kg' };
        if (! $b) {
            return 'primo prezzo '.self::money($a['price'], 2)." € al {$unit}";
        }
        if (! $a) {
            return 'nessun prezzo valido a oggi (prima '.self::money($b['price'], 2)." € al {$unit})";
        }

        return self::money($b['price'], 2).' → '.self::money($a['price'], 2)." € al {$unit}".self::pct($b['price'], $a['price']);
    }

    private static function pct(?string $b, ?string $a): string
    {
        if ($b === null || $a === null || Dec::of($b)->isZero()) {
            return '';
        }
        $p = Dec::of($a)->minus($b)->div($b)->times(100)->toFloat();

        return ' ('.($p >= 0 ? '+' : '−').number_format(abs($p), 1, ',', '.').'%)';
    }

    private static function money(?string $v, int $dec): string
    {
        if ($v === null) {
            return '—';
        }
        $f = Dec::of($v)->toFloat();
        $d = $dec;
        if ($dec > 2 && abs($f) >= 1) {
            $d = 2;
        }

        return number_format($f, $d, ',', '.');
    }

    private static function n(mixed $v): ?string
    {
        return $v === null ? null : Dec::of((string) $v)->toFixed();
    }

    private static function row(string $cid, string $type, string $id, string $msg, ?string $source, ?string $before, ?string $after, ?string $bp, ?string $ap, ?string $unit, ?string $userId, string $now): array
    {
        return [
            'id' => (string) Str::uuid(),
            'company_id' => $cid,
            'entity_type' => $type,
            'entity_id' => $id,
            'message' => mb_substr($msg, 0, 2000),
            'source' => $source,
            'before_value' => $before,
            'after_value' => $after,
            'before_portion' => $bp,
            'after_portion' => $ap,
            'unit' => $unit,
            'created_by' => $userId,
            'created_at' => $now,
        ];
    }
}
