<?php

namespace App\Http\Controllers\Api;

use App\Domain\Costing\Dec;
use App\Domain\Costing\Units;
use App\Http\Controllers\Controller;
use App\Services\Audit;
use App\Services\ChangeAlerts;
use App\Services\Costing;
use App\Services\Imports\CodeBook;
use App\Services\Imports\ImportError;
use App\Services\Imports\PriceList;
use App\Support\AppError;
use App\Support\Clock;
use App\Support\NonFood;
use App\Support\RateLimit;
use App\Support\Validation\S;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;

/**
 * NUOVO — importazione del listino dei fornitori (data, nome, prezzo, iva, U.M., sconti, fornitore):
 * anteprima per prodotto modificabile, poi applicazione con storico prezzi (prezzi netti, sconti applicati).
 */
class PriceListController extends Controller
{
    private function ctx(Request $req)
    {
        $ctx = $this->requireCompany($req, 'imports.manage');
        if (! $ctx->can('ingredients.manage') || ! $ctx->can('costs.read')) {
            throw AppError::forbidden('Per importare un listino servono la gestione dei prodotti e la lettura dei costi.');
        }

        return $ctx;
    }

    public function preview(Request $req): array
    {
        $ctx = $this->ctx($req);
        RateLimit::hit('pricelist', (string) $req->ip(), 30, 600);
        $file = $req->file('file') ?? (array_values($req->allFiles())[0] ?? null);
        if (! $file || ! $file->isValid()) {
            throw AppError::badRequest('no_file', 'Nessun file caricato.');
        }
        $lower = mb_strtolower($file->getClientOriginalName());
        $kind = str_ends_with($lower, '.xlsx') ? 'xlsx' : (str_ends_with($lower, '.csv') ? 'csv' : null);
        if (! $kind) {
            throw AppError::badRequest('unsupported_type', 'Formato non supportato: usa .csv o .xlsx.');
        }
        if ($file->getSize() > config('foodcost.import_max_bytes')) {
            throw AppError::badRequest('file_too_large', 'File troppo grande.');
        }
        $tmp = tempnam(sys_get_temp_dir(), 'pl');
        copy($file->getRealPath(), $tmp);
        try {
            $rows = PriceList::read($tmp, $kind);
        } catch (ImportError $e) {
            throw new AppError(422, 'invalid_file', $e->getMessage());
        } finally {
            @unlink($tmp);
        }

        return PriceList::analyze($ctx->companyId(), $rows);
    }

    public function apply(Request $req): array
    {
        $ctx = $this->ctx($req);
        $b = $this->parseBody($req, S::object(['products' => S::array(S::object([
            'existingId' => S::uuid()->nullable()->optional(),
            'code' => S::optText(40),
            'name' => S::reqText('Il nome', 160),
            'supplier' => S::optText(120),
            'category' => S::reqText('La categoria', 80),
            'nonFood' => S::bool(),
            'mode' => S::enum(['kg', 'l', 'conf']),
            'content' => S::dec(['gt' => 0, 'label' => 'Il contenuto']),
            'unit' => S::measureUnit(),
            'purchaseUnit' => S::optText(40),
            'pieceKg' => S::decOpt(['gt' => 0, 'label' => 'Il peso del pezzo']),
            'density' => S::decOpt(['gt' => 0, 'label' => 'La densità']),
            'prices' => S::array(S::object([
                'date' => S::isoDate(),
                'net' => S::dec(['gt' => 0, 'label' => 'Il prezzo']),
                'gross' => S::decOpt(['gt' => 0, 'label' => 'Il prezzo di listino']),
                'discount' => S::optText(60),
            ]))->min(1, 'Ogni prodotto deve avere almeno un prezzo.')->max(400),
        ]))->min(1, 'Nessun prodotto da importare.')->max(10000)]));
        $cid = $ctx->companyId();
        $existingIds = array_values(array_filter(array_map(fn ($p) => $p['existingId'] ?? null, $b['products'])));
        $watch = ChangeAlerts::watch($cid, 'ingredients', $existingIds);
        $catMap = NonFood::categoryMap($cid);

        $result = DB::transaction(function () use ($b, $cid, $ctx, $catMap) {
            $codes = new CodeBook($cid);
            $now = Clock::now();
            $out = ['created' => 0, 'updated' => 0, 'prices' => 0, 'pricesUpdated' => 0, 'ids' => []];
            foreach ($b['products'] as $i => $p) {
                [$content, $unit, $purchase] = match ($p['mode']) {
                    'kg' => ['1', 'kg', 'kg'],
                    'l' => ['1', 'l', 'litro'],
                    default => [Dec::of($p['content'])->toFixed(6), $p['unit'], $p['purchaseUnit'] ?: 'confezione'],
                };
                if ($p['mode'] === 'conf' && $unit === 'kg' && Dec::of($content)->eq(Dec::of('1')) && in_array($purchase, ['confezione', 'cf', ''], true)) {
                    $purchase = 'kg';
                }
                $catNonFood = NonFood::isCategory($cid, $p['category'], $catMap);
                $override = $p['nonFood'] === $catNonFood ? null : ($p['nonFood'] ? 1 : 0);
                $pieceKg = $p['nonFood'] ? null : ($p['pieceKg'] ?? null);
                $density = $p['density'] ?? null;
                $dim = Units::dimensionOf($unit);
                $id = $p['existingId'] ?? null;
                if ($id) {
                    $cur = DB::table('ingredients')->where('id', $id)->where('company_id', $cid)->lockForUpdate()->first();
                    if (! $cur) {
                        throw new AppError(422, 'validation_failed', "«{$p['name']}»: il prodotto non esiste più. Ricarica il listino.");
                    }
                    $weight = $pieceKg ?? $cur->unit_weight_kg;
                    $dens = $density ?? $cur->density_kg_per_l;
                    $usage = self::usage($cur->usage_unit, $unit, $weight, $dens);
                    // prezzi già registrati con la confezione di prima: allineati (stessa grandezza) o convertiti
                    if (! Dec::of($cur->package_content)->eq(Dec::of($content)) || $cur->package_unit !== $unit) {
                        foreach (DB::table('ingredient_prices')->where('ingredient_id', $id)->get(['id', 'package_content', 'package_unit']) as $old) {
                            if ($old->package_unit === $cur->package_unit && Dec::of($old->package_content)->eq(Dec::of($cur->package_content))) {
                                if (Units::dimensionOf($old->package_unit) === $dim) {
                                    DB::table('ingredient_prices')->where('id', $old->id)->update(['package_content' => $content, 'package_unit' => $unit]);

                                    continue;
                                }
                            }
                            if (Units::dimensionOf($old->package_unit) !== $dim) {
                                try {
                                    $base = Units::convertToDimension(Dec::of($old->package_content), $old->package_unit, $dim, [
                                        'unitWeightKg' => $weight !== null ? Dec::of($weight) : null, 'densityKgPerL' => $dens !== null ? Dec::of($dens) : null]);
                                    DB::table('ingredient_prices')->where('id', $old->id)->update(['package_content' => Units::fromBase($base, $unit)->toFixed(6), 'package_unit' => $unit]);
                                } catch (\Throwable) {
                                    // non convertibile: resta com'è (la scheda segnala il prezzo sfasato)
                                }
                            }
                        }
                    }
                    DB::table('ingredients')->where('id', $id)->update([
                        'supplier' => $p['supplier'] ?: $cur->supplier, 'category' => $p['category'], 'purchase_unit' => $purchase,
                        'package_content' => $content, 'package_unit' => $unit, 'usage_unit' => $usage,
                        'unit_weight_kg' => $weight, 'density_kg_per_l' => $dens, 'non_food' => $override,
                        'updated_at' => $now, 'lock_version' => $cur->lock_version + 1,
                    ]);
                    $out['updated']++;
                } else {
                    $code = $p['code'] ?? null;
                    if (! $code || $codes->exists($code)) {
                        $code = $codes->next('ING');
                    }
                    $codes->add($code);
                    $id = (string) Str::uuid();
                    DB::table('ingredients')->insert([
                        'id' => $id, 'company_id' => $cid, 'code' => $code, 'name' => $p['name'], 'category' => $p['category'], 'supplier' => $p['supplier'] ?? null,
                        'purchase_unit' => $purchase, 'package_content' => $content, 'package_unit' => $unit,
                        'usage_unit' => self::usage(null, $unit, $pieceKg, $density), 'edible_yield' => '1',
                        'unit_weight_kg' => $pieceKg, 'density_kg_per_l' => $density, 'non_food' => $override,
                        'created_at' => $now, 'updated_at' => $now,
                    ]);
                    $out['created']++;
                }
                $out['ids'][] = $id;
                foreach ($p['prices'] as $pr) {
                    $source = mb_substr('Listino'.(! empty($pr['gross']) ? ': prezzo '.Dec::of($pr['gross'])->toFixed() : '').(! empty($pr['discount']) ? ' sconti '.$pr['discount'].'%' : ''), 0, 255);
                    $row = ['package_price' => Dec::of($pr['net'])->toFixed(6), 'package_content' => $content, 'package_unit' => $unit, 'source' => $source, 'supplier' => $p['supplier'] ?? null];
                    $old = DB::table('ingredient_prices')->where('ingredient_id', $id)->where('valid_from', $pr['date'])->first(['id']);
                    if ($old) {
                        DB::table('ingredient_prices')->where('id', $old->id)->update($row);
                        $out['pricesUpdated']++;
                    } else {
                        DB::table('ingredient_prices')->insert([...$row, 'id' => (string) Str::uuid(), 'company_id' => $cid, 'ingredient_id' => $id, 'valid_from' => $pr['date'],
                            'created_by' => $ctx->userId(), 'created_at' => $now]);
                        $out['prices']++;
                    }
                }
            }
            Audit::log($cid, $ctx->userId(), 'import', null, 'pricelist_applied', ['created' => $out['created'], 'updated' => $out['updated'], 'prices' => $out['prices'], 'pricesUpdated' => $out['pricesUpdated']]);

            return $out;
        });
        $affected = Costing::invalidate($cid, 'ingredients', $result['ids']);
        ChangeAlerts::commit($watch, $ctx->userId(), ['label' => 'Listino fornitori importato', 'seenIngredients' => false]);
        unset($result['ids']);

        return [...$result, 'affectedRecipes' => Costing::describeRecipes($cid, $affected)];
    }

    /** unità in ricetta: si tiene quella di prima se ancora convertibile, altrimenti quella naturale della confezione */
    private static function usage(?string $current, string $unit, mixed $pieceKg, mixed $density): string
    {
        $natural = match ($unit) { 'kg' => 'g', 'l' => 'ml', 'cl' => 'ml', default => $unit };
        if (! $current) {
            return $natural;
        }
        $a = Units::dimensionOf($current);
        $b = Units::dimensionOf($unit);
        if ($a === $b) {
            return $current;
        }
        $pair = [$a => true, $b => true];
        $ok = (! isset($pair['count']) || $pieceKg !== null) && (! (isset($pair['volume']) && (isset($pair['mass']) || isset($pair['count']))) || $density !== null);

        return $ok ? $current : $natural;
    }
}
