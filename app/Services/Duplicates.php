<?php

namespace App\Services;

use App\Services\Imports\PriceList;
use App\Support\AppError;
use App\Support\Clock;
use Illuminate\Support\Facades\DB;

/**
 * NUOVO — prodotti doppi dello stesso fornitore (lo stesso articolo scritto in modi diversi nelle fatture:
 * «FRUTTI DEL CAPPERO in aceto», «FRUTTI DI CAPPERO in aceto vt1700»…) e loro unione in un solo prodotto.
 */
final class Duplicates
{
    /** @return list<array{key:string, keepId:string, items:list<array>}> */
    public static function find(string $cid): array
    {
        $rows = DB::table('ingredients as i')->where('i.company_id', $cid)->whereNull('i.archived_at')
            ->get(['i.id', 'i.code', 'i.name', 'i.supplier', 'i.category', 'i.purchase_unit', 'i.package_content', 'i.package_unit', 'i.created_at']);
        if ($rows->isEmpty()) {
            return [];
        }
        $ids = $rows->pluck('id')->all();
        $prices = DB::table('ingredient_prices')->whereIn('ingredient_id', $ids)->groupBy('ingredient_id')
            ->selectRaw('ingredient_id, COUNT(*) as n, MAX(valid_from) as last')->get()->keyBy('ingredient_id');
        $uses = DB::table('recipe_components as c')->join('recipes as r', 'r.current_revision_id', '=', 'c.revision_id')
            ->whereIn('c.ingredient_id', $ids)->groupBy('c.ingredient_id')->selectRaw('c.ingredient_id, COUNT(DISTINCT r.id) as n')->pluck('n', 'ingredient_id');
        $latest = [];
        foreach (DB::table('ingredient_prices as p')->whereIn('p.ingredient_id', $ids)
            ->whereRaw('p.valid_from = (SELECT MAX(p2.valid_from) FROM ingredient_prices p2 WHERE p2.ingredient_id = p.ingredient_id)')
            ->get(['p.ingredient_id', 'p.package_price', 'p.package_content', 'p.package_unit']) as $p) {
            $latest[$p->ingredient_id] = $p;
        }
        $ignored = [];
        foreach (DB::table('duplicate_ignores')->where('company_id', $cid)->get(['a_id', 'b_id']) as $x) {
            $ignored[$x->a_id.'|'.$x->b_id] = true;
        }
        // per fornitore: stessa descrizione (stesse parole, a meno di singolare/plurale, «sv», «di»…) = da unire;
        // descrizioni simili (una contiene l'altra più una parola, o quasi tutte le parole in comune) = da verificare
        $bySup = [];
        foreach ($rows as $r) {
            $st = array_values(array_unique(PriceList::stems($r->name)));
            if (! $st) {
                continue;
            }
            $bySup[PriceList::supplierKey((string) $r->supplier)][] = ['r' => $r, 'st' => $st, 'key' => implode(' ', $st), 'dim' => \App\Domain\Costing\Units::dimensionOf($r->package_unit)];
        }
        $out = [];
        foreach ($bySup as $sk => $list) {
            $n = count($list);
            if ($n < 2) {
                continue;
            }
            $parent = range(0, $n - 1);
            $find = function (int $i) use (&$parent, &$find): int {
                return $parent[$i] === $i ? $i : ($parent[$i] = $find($parent[$i]));
            };
            for ($i = 0; $i < $n; $i++) {
                for ($j = $i + 1; $j < $n; $j++) {
                    $a = $list[$i];
                    $b = $list[$j];
                    $same = $a['key'] === $b['key'];
                    if (! $same && ($a['dim'] !== $b['dim'] || ! self::similar($a['st'], $b['st']))) {
                        continue;
                    }
                    if (isset($ignored[min($a['r']->id, $b['r']->id).'|'.max($a['r']->id, $b['r']->id)])) {
                        continue; // il titolare ha detto che sono diversi
                    }
                    $parent[$find($i)] = $find($j);
                }
            }
            $groups = [];
            for ($i = 0; $i < $n; $i++) {
                $groups[$find($i)][] = $i;
            }
            foreach ($groups as $idx) {
                if (count($idx) < 2) {
                    continue;
                }
                $items = array_map(function ($i) use ($list, $prices, $latest, $uses) {
                    $r = $list[$i]['r'];

                    return ['i' => $i, 'key' => $list[$i]['key'], 'id' => $r->id, 'code' => $r->code, 'name' => $r->name, 'supplier' => $r->supplier, 'category' => $r->category,
                        'pack' => rtrim(rtrim((string) $r->package_content, '0'), '.').' '.$r->package_unit,
                        'prices' => (int) ($prices[$r->id]->n ?? 0), 'lastPrice' => $latest[$r->id]->package_price ?? null,
                        'lastDate' => $prices[$r->id]->last ?? null, 'recipes' => (int) ($uses[$r->id] ?? 0), 'createdAt' => $r->created_at];
                }, $idx);
                // si tiene quello usato nelle ricette, poi quello con la confezione completa (non «1 pz»), poi più prezzi, poi il più vecchio
                $info = fn ($x) => $x['pack'] === '1 pz' ? 0 : 1;
                usort($items, fn ($a, $b) => [$b['recipes'], $info($b), $b['prices'], $a['createdAt']] <=> [$a['recipes'], $info($a), $a['prices'], $b['createdAt']]);
                $keepKey = $items[0]['key'];
                $allSame = true;
                foreach ($items as &$it) {
                    $it['same'] = $it['key'] === $keepKey; // stessa descrizione del prodotto tenuto: proposto da unire
                    $allSame = $allSame && $it['same'];
                    unset($it['i'], $it['createdAt']);
                }
                unset($it);
                $out[] = ['key' => $sk.'|'.$items[0]['id'], 'keepId' => $items[0]['id'], 'sure' => $allSame, 'items' => $items];
            }
        }
        usort($out, fn ($a, $b) => [$b['sure'], mb_strtolower($a['items'][0]['name'])] <=> [$a['sure'], mb_strtolower($b['items'][0]['name'])]);

        return $out;
    }

    /**
     * Descrizioni «quasi uguali»: stessi numeri (formati, pezzature: 720 g ≠ 270 g, taglie diverse ≠) e parole uguali
     * a meno di UNA in più o in meno (es. «ali di pollo» / «ali di pollo bbq», da verificare) o di piccoli errori di
     * battitura («FRIARIELLI» / «FRIARELLI», «CIOCC.» / «CIOCCOLATO»).
     */
    public static function similar(array $a, array $b): bool
    {
        $num = fn (array $x) => array_values(array_filter($x, fn ($w) => preg_match('/\d/', $w)));
        $na = $num($a);
        $nb = $num($b);
        sort($na);
        sort($nb);
        if ($na !== $nb) {
            return false;
        }
        $wa = array_values(array_diff($a, $na));
        $wb = array_values(array_diff($b, $nb));
        // errore di battitura (parole lunghe) o abbreviazione («cioc.» → «cioccolato», «calam.» → «calamari»)
        $near = function (string $x, string $y): bool {
            if ($x === $y) {
                return true;
            }
            [$s, $l] = mb_strlen($x) <= mb_strlen($y) ? [$x, $y] : [$y, $x];

            return (mb_strlen($s) >= 5 && levenshtein($x, $y) <= 1) || (mb_strlen($s) >= 4 && mb_strlen($s) <= 5 && mb_strlen($l) >= mb_strlen($s) + 3 && str_starts_with($l, $s));
        };
        $matched = 0;
        foreach ($wa as $x) {
            foreach ($wb as $k => $y) {
                if ($near($x, $y)) {
                    $matched++;
                    unset($wb[$k]);
                    continue 2;
                }
            }
        }
        $unmatched = (count($wa) - $matched) + count($wb);

        return $matched >= 2 && $unmatched <= 1;
    }

    /** Segna come diversi tra loro i prodotti indicati (non verranno più proposti come doppi). */
    public static function ignore(string $cid, array $ids): int
    {
        $ids = array_values(array_unique($ids));
        $ok = DB::table('ingredients')->where('company_id', $cid)->whereIn('id', $ids)->pluck('id')->all();
        $n = 0;
        foreach ($ok as $i => $a) {
            foreach (array_slice($ok, $i + 1) as $b) {
                $n += DB::table('duplicate_ignores')->insertOrIgnore(['company_id' => $cid, 'a_id' => min($a, $b), 'b_id' => max($a, $b), 'created_at' => Clock::now()]);
            }
        }

        return $n;
    }

    /**
     * Unisce $mergeIds in $keepId: prezzi (a parità di data vince quello del prodotto tenuto), ricette, menu, vendite e
     * abbinamenti delle fatture passano al prodotto tenuto; gli altri vengono archiviati (non cancellati).
     *
     * @return array{prices:int, recipes:int}
     */
    public static function merge(string $cid, string $keepId, array $mergeIds, ?string $userId): array
    {
        $mergeIds = array_values(array_diff(array_unique($mergeIds), [$keepId]));
        if (! $mergeIds) {
            throw new AppError(422, 'validation_failed', 'Scegli almeno un prodotto da unire.');
        }
        $all = DB::table('ingredients')->where('company_id', $cid)->whereIn('id', [$keepId, ...$mergeIds])->lockForUpdate()->get()->keyBy('id');
        if (! isset($all[$keepId]) || count($all) !== count($mergeIds) + 1) {
            throw AppError::notFound('Prodotto');
        }
        $keep = $all[$keepId];
        $moved = 0;
        $recipes = 0;
        $now = Clock::now();
        foreach ($mergeIds as $id) {
            $have = DB::table('ingredient_prices')->where('ingredient_id', $keepId)->pluck('valid_from')->all();
            $moved += DB::table('ingredient_prices')->where('ingredient_id', $id)->whereNotIn('valid_from', $have ?: ['0000-00-00'])->update(['ingredient_id' => $keepId]);
            DB::table('ingredient_prices')->where('ingredient_id', $id)->delete(); // stessi giorni: resta il prezzo del prodotto tenuto
            $recipes += DB::table('recipe_components')->where('company_id', $cid)->where('ingredient_id', $id)->update(['ingredient_id' => $keepId]);
            DB::table('menu_items')->where('company_id', $cid)->where('ingredient_id', $id)->update(['ingredient_id' => $keepId]);
            DB::table('order_items')->where('company_id', $cid)->where('ingredient_id', $id)->update(['ingredient_id' => $keepId]);
            DB::table('invoice_line_maps')->where('company_id', $cid)->where('ingredient_id', $id)->update(['ingredient_id' => $keepId]);
            $o = $all[$id];
            DB::table('ingredients')->where('id', $id)->update([
                'archived_at' => $now, 'updated_at' => $now, 'lock_version' => $o->lock_version + 1,
                'notes' => mb_substr(trim(($o->notes ? $o->notes."\n" : '').'Unito in '.$keep->code.' «'.$keep->name.'» il '.substr($now, 0, 10).'.'), 0, 2000),
            ]);
            Audit::log($cid, $userId, 'ingredient', $id, 'merged', ['into' => $keep->code]);
        }
        Audit::log($cid, $userId, 'ingredient', $keepId, 'merged_from', ['codes' => array_values(array_map(fn ($id) => $all[$id]->code, $mergeIds))]);

        return ['prices' => $moved, 'recipes' => $recipes];
    }
}
