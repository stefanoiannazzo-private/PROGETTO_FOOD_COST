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
        $groups = [];
        foreach ($rows as $r) {
            $loose = PriceList::looseKey($r->name);
            if ($loose === '') {
                continue;
            }
            $groups[PriceList::supplierKey((string) $r->supplier).'|'.$loose][] = $r;
        }
        $out = [];
        foreach ($groups as $key => $items) {
            if (count($items) < 2) {
                continue;
            }
            $list = array_map(fn ($r) => [
                'id' => $r->id, 'code' => $r->code, 'name' => $r->name, 'supplier' => $r->supplier, 'category' => $r->category,
                'pack' => rtrim(rtrim((string) $r->package_content, '0'), '.').' '.$r->package_unit,
                'prices' => (int) ($prices[$r->id]->n ?? 0), 'lastPrice' => $latest[$r->id]->package_price ?? null,
                'lastDate' => $prices[$r->id]->last ?? null, 'recipes' => (int) ($uses[$r->id] ?? 0), 'createdAt' => $r->created_at,
            ], $items);
            // si tiene quello usato nelle ricette, poi quello con la confezione completa (non «1 pz», es. l'acqua corretta a 24 pz),
            // poi quello con più prezzi, poi il più vecchio
            $info = fn ($x) => $x['pack'] === '1 pz' ? 0 : 1;
            usort($list, fn ($a, $b) => [$b['recipes'], $info($b), $b['prices'], $a['createdAt']] <=> [$a['recipes'], $info($a), $a['prices'], $b['createdAt']]);
            $out[] = ['key' => $key, 'keepId' => $list[0]['id'], 'items' => array_map(fn ($x) => array_diff_key($x, ['createdAt' => 1]), $list)];
        }
        usort($out, fn ($a, $b) => strcasecmp($a['items'][0]['name'], $b['items'][0]['name']));

        return $out;
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
