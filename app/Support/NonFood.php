<?php

namespace App\Support;

use Illuminate\Support\Facades\DB;

/**
 * NUOVO — prodotti non alimentari: non si usano a peso nelle ricette, quindi non serve il peso del pezzo.
 * Vale l'eccezione sul prodotto, poi l'impostazione della categoria, poi il riconoscimento dal nome della categoria.
 */
final class NonFood
{
    /** parole che, nel nome della categoria, indicano materiale non alimentare */
    private const WORDS = ['materiale', 'consumo', 'combustib', 'legna', 'pellet', 'carbone', 'pulizia', 'pulizie', 'detersiv', 'detergent', 'igien', 'sanific',
        'imball', 'packaging', 'monouso', 'usa e getta', 'cancelleria', 'stoviglie', 'attrezz', 'utensil', 'manutenzion', 'ricambi', 'divise', 'abbigliamento',
        'non alimentar', 'carta e plastica', 'plastica', 'sacchi'];

    public static function guess(?string $category): bool
    {
        $c = mb_strtolower(trim((string) $category));
        if ($c === '') {
            return false;
        }
        foreach (self::WORDS as $w) {
            if (str_contains($c, $w)) {
                return true;
            }
        }

        return false;
    }

    /** @return array<string, array{nonFood: bool, auto: bool}> chiave: nome categoria in minuscolo */
    public static function categoryMap(string $companyId): array
    {
        $set = [];
        foreach (DB::table('ingredient_categories')->where('company_id', $companyId)->get(['name', 'non_food']) as $r) {
            $set[mb_strtolower(trim($r->name))] = (bool) $r->non_food;
        }
        $out = [];
        foreach (DB::table('ingredients')->where('company_id', $companyId)->whereNotNull('category')->where('category', '<>', '')->distinct()->pluck('category') as $c) {
            $k = mb_strtolower(trim($c));
            $out[$k] = isset($set[$k]) ? ['nonFood' => $set[$k], 'auto' => false] : ['nonFood' => self::guess($c), 'auto' => true];
        }
        foreach ($set as $k => $v) {
            $out[$k] ??= ['nonFood' => $v, 'auto' => false];
        }

        return $out;
    }

    public static function isCategory(string $companyId, ?string $category, ?array $map = null): bool
    {
        $k = mb_strtolower(trim((string) $category));
        if ($k === '') {
            return false;
        }
        $map ??= self::categoryMap($companyId);

        return isset($map[$k]) ? $map[$k]['nonFood'] : self::guess($category);
    }

    /** nomi (originali) delle categorie non alimentari dell'azienda, per i filtri SQL */
    public static function categories(string $companyId): array
    {
        $names = [];
        foreach (DB::table('ingredients')->where('company_id', $companyId)->whereNotNull('category')->distinct()->pluck('category') as $c) {
            if (self::isCategory($companyId, $c, $map ??= self::categoryMap($companyId))) {
                $names[] = $c;
            }
        }

        return $names;
    }

    public static function effective(?bool $override, bool $categoryNonFood): bool
    {
        return $override ?? $categoryNonFood;
    }

    /** Condizione SQL «ha bisogno del peso»: a pezzi, senza peso, e non è materiale non alimentare. */
    public static function needsWeightWhere($query, string $companyId, string $alias = 'i'): void
    {
        $nf = self::categories($companyId);
        $query->where("{$alias}.package_unit", 'pz')->whereNull("{$alias}.unit_weight_kg")
            ->where(fn ($w) => $w->where("{$alias}.non_food", 0)->orWhere(fn ($x) => $x->whereNull("{$alias}.non_food")
                ->where(fn ($y) => $y->whereNull("{$alias}.category")->orWhereNotIn("{$alias}.category", $nf ?: ['__nessuna__']))));
    }
}
