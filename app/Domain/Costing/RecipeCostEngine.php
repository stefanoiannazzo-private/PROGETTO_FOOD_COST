<?php

declare(strict_types=1);

namespace App\Domain\Costing;

/**
 * Motore di valorizzazione delle ricette (port 1:1 di engine.ts).
 *
 * - Una sottoricetta è valorizzata una sola volta per contesto (memoizzazione per ricetta).
 * - Ogni riga che usa una sottoricetta è costata separatamente: due usi della stessa sottoricetta si sommano.
 * - Il costo di una sottoricetta entra nel padre solo come subtotale di riga; il dettaglio interno è informativo.
 *
 * Il contesto è un array: date (Y-m-d), recipes, ingredients, equipment, tariffs, employees (array id => dati),
 * maxDepth?, maxNodes?. Il risultato è un array con le stesse chiavi di RecipeCost dell'originale.
 */
final class RecipeCostEngine
{
    private const DEFAULT_MAX_DEPTH = 12;

    private const DEFAULT_MAX_NODES = 2000;

    private const LOCAL_ONLY = ['missing_final_weight', 'missing_portions', 'missing_yield'];

    /** @var array<string, array> */
    private array $memo = [];

    private int $visits = 0;

    public function __construct(private readonly array $ctx)
    {
    }

    public static function valueRecipe(array $ctx, string $recipeId): array
    {
        return (new self($ctx))->value($recipeId);
    }

    public function value(string $recipeId): array
    {
        return $this->visit($recipeId, []);
    }

    /** Percentuale di una voce sul totale (null se il totale è zero). */
    public static function shareOfTotal(Dec $part, Dec $total): ?Dec
    {
        return $total->isZero() ? null : $part->div($total)->times(100);
    }

    public static function itDate(string $iso): string
    {
        return preg_match('/^\d{4}-\d{2}-\d{2}$/', $iso) ? substr($iso, 8, 2).'/'.substr($iso, 5, 2).'/'.substr($iso, 0, 4) : $iso;
    }

    private function visit(string $recipeId, array $stack): array
    {
        if (isset($this->memo[$recipeId])) {
            return $this->memo[$recipeId];
        }
        $recipe = $this->ctx['recipes'][$recipeId] ?? null;
        if (! $recipe) {
            throw new DomainError('recipe_not_found', "Ricetta {$recipeId} non trovata nel contesto di calcolo.");
        }
        $this->visits++;
        if ($this->visits > ($this->ctx['maxNodes'] ?? self::DEFAULT_MAX_NODES)) {
            throw new DomainError('too_complex', 'La struttura delle ricette supera il limite di complessità ammesso.');
        }
        $stack[] = $recipeId;
        $result = $this->compute($recipe, $stack);
        $this->memo[$recipeId] = $result;

        return $result;
    }

    private static function dedupe(array $issues): array
    {
        $seen = [];
        $out = [];
        foreach ($issues as $i) {
            $k = $i['severity'].'|'.$i['code'].'|'.$i['message'].'|'.implode('>', $i['path']);
            if (isset($seen[$k])) {
                continue;
            }
            $seen[$k] = true;
            $out[] = $i;
        }

        return $out;
    }

    private static function sumCosts(array $lines): Dec
    {
        return Dec::sum(array_map(fn ($l) => $l['cost'], array_values(array_filter($lines, fn ($l) => $l['cost'] !== null))));
    }

    private function compute(array $recipe, array $stack): array
    {
        $ctx = $this->ctx;
        $issues = [];
        $here = [$recipe['title']];
        $issue = function (string $code, string $message, string $severity = 'error', ?array $ref = null) use (&$issues, $here): void {
            $i = ['code' => $code, 'message' => $message, 'severity' => $severity, 'path' => $here];
            if ($ref !== null) {
                $i['ref'] = $ref;
            }
            $issues[] = $i;
        };

        /* ---------------- ingredienti diretti e semilavorati ---------------- */
        $ingredientLines = [];
        $subrecipeLines = [];
        $subExpanded = [];

        foreach ($recipe['components'] as $c) {
            $ref = ['type' => 'component', 'id' => $c['id']];
            $hasIng = ! empty($c['ingredientId']);
            $hasRec = ! empty($c['recipeId']);
            if ($hasIng === $hasRec) {
                $issue('invalid_component', 'Ogni componente deve riferirsi a un ingrediente oppure a una ricetta, non a entrambi né a nessuno.', 'error', $ref);

                continue;
            }
            /** @var Dec $qty */
            $qty = $c['quantity'];
            if ($qty->lte(0)) {
                $issue('invalid_quantity', 'Quantità mancante o pari a zero: il componente non è valorizzato.', 'error', $ref);
            }

            if ($hasIng) {
                $ing = $ctx['ingredients'][$c['ingredientId']] ?? null;
                $line = [
                    'componentId' => $c['id'],
                    'ingredientId' => $c['ingredientId'],
                    'code' => $ing['code'] ?? null,
                    'name' => $ing['name'] ?? 'Ingrediente non disponibile',
                    'quantity' => $qty,
                    'unit' => $c['unit'],
                    'netBaseQuantity' => null,
                    'grossBaseQuantity' => null,
                    'baseUnit' => null,
                    'edibleYield' => $ing['edibleYield'] ?? null,
                    'unitPrice' => null,
                    'priceId' => $ing['priceId'] ?? null,
                    'cost' => null,
                    'zeroPrice' => false,
                ];
                if (! $ing) {
                    $ingredientLines[] = $line;
                    $issue('missing_ingredient', 'Ingrediente non trovato o non accessibile.', 'error', $ref);

                    continue;
                }
                try {
                    $u = Calculators::ingredientUsageCost($ing, $qty, $c['unit']);
                    $line['netBaseQuantity'] = $u['netBaseQuantity'];
                    $line['grossBaseQuantity'] = $u['grossBaseQuantity'];
                    $line['baseUnit'] = $u['baseUnit'];
                    $line['unitPrice'] = $u['unitPrice'];
                    if ($u['unitPrice'] === null) {
                        $issue('missing_price', "{$ing['name']}: nessun prezzo valido alla data ".self::itDate($ctx['date']).'.', 'error', ['type' => 'ingredient', 'id' => $ing['id']]);
                    } else {
                        $line['zeroPrice'] = $u['unitPrice']->isZero();
                        if ($line['zeroPrice']) {
                            $issue('zero_price', "{$ing['name']}: prezzo esplicitamente pari a zero.", 'info', ['type' => 'ingredient', 'id' => $ing['id']]);
                        }
                        if ($qty->gt(0)) {
                            $line['cost'] = $u['cost'];
                        }
                    }
                } catch (UnitConversionError $e) {
                    $issue('unit_conversion', "{$ing['name']}: {$e->getMessage()}", 'error', $ref);
                } catch (DomainError $e) {
                    $issue($e->errorCode, "{$ing['name']}: {$e->getMessage()}", 'error', $ref);
                }
                $ingredientLines[] = $line;

                continue;
            }

            /* semilavorato */
            $subId = $c['recipeId'];
            $subInput = $ctx['recipes'][$subId] ?? null;
            $line = [
                'componentId' => $c['id'],
                'recipeId' => $subId,
                'revisionId' => $subInput['revisionId'] ?? null,
                'code' => $subInput['code'] ?? null,
                'name' => $subInput['title'] ?? 'Ricetta non disponibile',
                'quantity' => $qty,
                'unit' => $c['unit'],
                'unitCost' => null,
                'basis' => null,
                'fraction' => null,
                'cost' => null,
                'sub' => null,
            ];
            if (! $subInput) {
                $subrecipeLines[] = $line;
                $issue('missing_subrecipe', 'Sottoricetta non trovata o non accessibile.', 'error', $ref);

                continue;
            }
            if (in_array($subId, $stack, true)) {
                $subrecipeLines[] = $line;
                $issue('cycle', "Ciclo rilevato: {$subInput['title']} contiene direttamente o indirettamente {$recipe['title']}.", 'error', $ref);
                $issues[count($issues) - 1]['path'] = [$recipe['title'], $subInput['title']];

                continue;
            }
            if (count($stack) >= ($ctx['maxDepth'] ?? self::DEFAULT_MAX_DEPTH)) {
                $subrecipeLines[] = $line;
                $issue('max_depth', 'Superato il numero massimo di livelli di annidamento.', 'error', $ref);

                continue;
            }

            $sub = $this->visit($subId, $stack);
            $line['sub'] = $sub;
            // Si propagano errori e avvisi sui costi; non le note sulla resa della sottoricetta.
            foreach ($sub['issues'] as $si) {
                if ($si['severity'] === 'info' || in_array($si['code'], self::LOCAL_ONLY, true)) {
                    continue;
                }
                $si['path'] = array_merge([$recipe['title']], $si['path']);
                $issues[] = $si;
            }

            try {
                $qtyDim = Units::dimensionOf($c['unit']);
                $denominator = null;
                $qtyBase = null;
                if ($qtyDim === 'mass' && $sub['finalWeightKg'] !== null && $sub['finalWeightKg']->gt(0)) {
                    $line['basis'] = 'weight';
                    $denominator = $sub['finalWeightKg'];
                    $qtyBase = Units::toBase($qty, $c['unit']);
                } elseif ($sub['finalUnit'] !== null && $sub['finalQuantity'] !== null && $sub['finalQuantity']->gt(0) && Units::dimensionOf($sub['finalUnit']) === $qtyDim) {
                    $line['basis'] = 'yield';
                    $denominator = Units::toBase($sub['finalQuantity'], $sub['finalUnit']);
                    $qtyBase = Units::convertToDimension($qty, $c['unit'], $qtyDim);
                }
                // In JavaScript un Decimal è sempre "vero": il controllo riguarda solo l'assenza del valore.
                if ($denominator === null || $qtyBase === null) {
                    $issue(
                        'incompatible_subrecipe_unit',
                        "{$sub['title']}: impossibile dosare in {$c['unit']}. Dichiara il peso finale netto della sottoricetta oppure usa l'unità della sua resa.",
                        'error',
                        $ref,
                    );
                    $subrecipeLines[] = $line;

                    continue;
                }
                $line['unitCost'] = $sub['total']->div($denominator);
                $line['fraction'] = $qtyBase->div($denominator);
                if ($qty->gt(0)) {
                    $line['cost'] = $sub['total']->times($line['fraction']);
                    $subExpanded[] = [
                        'ingredients' => $sub['expanded']['ingredients']->times($line['fraction']),
                        'energy' => $sub['expanded']['energy']->times($line['fraction']),
                        'labor' => $sub['expanded']['labor']->times($line['fraction']),
                    ];
                }
            } catch (UnitConversionError $e) {
                $issue('unit_conversion', "{$sub['title']}: {$e->getMessage()}", 'error', $ref);
            }
            $subrecipeLines[] = $line;
        }

        /* ---------------------------- strumenti ---------------------------- */
        $equipmentLines = [];
        foreach ($recipe['equipmentUses'] as $u) {
            $ref = ['type' => 'equipment_use', 'id' => $u['id']];
            $eq = $ctx['equipment'][$u['equipmentId']] ?? null;
            $line = [
                'useId' => $u['id'],
                'equipmentId' => $u['equipmentId'],
                'name' => $eq['name'] ?? 'Strumento non disponibile',
                'phaseId' => $u['phaseId'] ?? null,
                'segment' => $u['segment'],
                'minutes' => $u['minutes'],
                'share' => $u['share'],
                'sources' => [],
                'fullCost' => null,
                'cost' => null,
                'manual' => false,
            ];
            if (! $eq) {
                $equipmentLines[] = $line;
                $issue('missing_equipment', 'Strumento non trovato o non accessibile.', 'error', $ref);

                continue;
            }
            if ($u['minutes']->lte(0)) {
                $equipmentLines[] = $line;
                $issue('invalid_minutes', "{$eq['name']}: durata d'uso mancante o pari a zero.", 'error', $ref);

                continue;
            }
            if ($u['share']->lte(0) || $u['share']->gt(1)) {
                $equipmentLines[] = $line;
                $issue('invalid_share', "{$eq['name']}: quota di imputazione fuori intervallo (0–100%].", 'error', $ref);

                continue;
            }
            $energy = Calculators::energyForUse([
                'equipment' => $eq,
                'segment' => $u['segment'],
                'minutes' => $u['minutes'],
                'sources' => $u['sources'] ?? null,
                'measuredElectricKwh' => $u['measuredElectricKwh'] ?? null,
                'measuredGasQuantity' => $u['measuredGasQuantity'] ?? null,
                'measuredGasUnit' => $u['measuredGasUnit'] ?? null,
                'tariffs' => $ctx['tariffs'],
            ]);
            $line['sources'] = $energy['sources'];
            $line['manual'] = $energy['manual'];
            foreach ($energy['issues'] as $ei) {
                $issue($ei['code'], $ei['message'], 'error', $ref);
            }
            if ($energy['manual']) {
                $line['fullCost'] = Dec::zero();
                $line['cost'] = Dec::zero();
                $equipmentLines[] = $line;

                continue;
            }
            $valued = array_values(array_filter($energy['sources'], fn ($s) => $s['cost'] !== null));
            if (count($valued) > 0) {
                $line['fullCost'] = Dec::sum(array_map(fn ($s) => $s['cost'], $valued));
                $line['cost'] = $line['fullCost']->times($u['share']);
            }
            if ($u['share']->lt(1)) {
                $issue('shared_equipment', "{$eq['name']}: imputato il {$u['share']->times(100)->toFixed()}% del costo d'uso (quota dichiarata).", 'info', $ref);
            }
            foreach ($energy['sources'] as $s) {
                if ($s['estimated'] && $s['cost'] !== null) {
                    $issue('estimated_energy', "{$eq['name']}: consumo stimato da potenza e coefficiente, non misurato.", 'info', $ref);
                    break;
                }
            }
            $equipmentLines[] = $line;
        }

        /* ---------------------------- manodopera ---------------------------- */
        $laborLines = [];
        foreach ($recipe['laborAssignments'] as $a) {
            $ref = ['type' => 'labor', 'id' => $a['id']];
            $emp = $ctx['employees'][$a['employeeId']] ?? null;
            $line = [
                'assignmentId' => $a['id'],
                'employeeId' => $a['employeeId'],
                'name' => $emp['name'] ?? 'Dipendente non disponibile',
                'phaseId' => $a['phaseId'] ?? null,
                'activeMinutes' => $a['activeMinutes'],
                'share' => $a['share'],
                'costPerMinute' => null,
                'basis' => null,
                'cost' => null,
            ];
            if (! $emp) {
                $laborLines[] = $line;
                $issue('missing_labor_cost', 'Costo del lavoro non configurato alla data per il dipendente assegnato.', 'error', $ref);

                continue;
            }
            if ($a['activeMinutes']->lte(0)) {
                $laborLines[] = $line;
                $issue('invalid_minutes', "{$emp['name']}: minuti attivi mancanti o pari a zero.", 'error', $ref);

                continue;
            }
            if ($a['share']->lte(0) || $a['share']->gt(1)) {
                $laborLines[] = $line;
                $issue('invalid_share', "{$emp['name']}: quota di imputazione fuori intervallo (0–100%].", 'error', $ref);

                continue;
            }
            try {
                $rates = Calculators::employeeRates($emp);
                $line['costPerMinute'] = $rates['costPerMinute'];
                $line['basis'] = $rates['basis'];
                $line['cost'] = Calculators::laborCost($a['activeMinutes'], $rates['costPerMinute'], $a['share']);
                if ($rates['basis'] === 'gross_only') {
                    $issue('gross_only', "{$emp['name']}: costo calcolato sul solo lordo, senza oneri aziendali inseriti.", 'warning', $ref);
                }
            } catch (DomainError $e) {
                $issue($e->errorCode, "{$emp['name']}: {$e->getMessage()}", 'error', $ref);
            }
            $laborLines[] = $line;
        }

        /* ----------------------------- totali ----------------------------- */
        $directIngredients = self::sumCosts($ingredientLines);
        $subrecipes = self::sumCosts($subrecipeLines);
        $energySum = self::sumCosts($equipmentLines);
        $labor = self::sumCosts($laborLines);
        $total = $directIngredients->plus($subrecipes)->plus($energySum)->plus($labor);

        $expanded = [
            'ingredients' => $directIngredients->plus(Dec::sum(array_column($subExpanded, 'ingredients'))),
            'energy' => $energySum->plus(Dec::sum(array_column($subExpanded, 'energy'))),
            'labor' => $labor->plus(Dec::sum(array_column($subExpanded, 'labor'))),
        ];

        $finalWeightKg = $recipe['finalWeightKg'] !== null && $recipe['finalWeightKg']->gt(0) ? $recipe['finalWeightKg'] : null;
        $portions = $recipe['portions'] !== null && $recipe['portions']->gt(0) ? $recipe['portions'] : null;
        $rref = ['type' => 'recipe', 'id' => $recipe['id']];
        if (! $finalWeightKg) {
            $issue('missing_final_weight', 'Peso finale netto non dichiarato: costo al kg non calcolabile.', 'warning', $rref);
        }
        if (! $portions) {
            $issue('missing_portions', 'Numero di porzioni non dichiarato: costo per porzione non calcolabile.', 'warning', $rref);
        }
        if ($recipe['finalQuantity'] === null || $recipe['finalQuantity']->lte(0) || ! $recipe['finalUnit']) {
            $issue('missing_yield', 'Resa finale non dichiarata.', 'warning', $rref);
        }

        $finalQtyBase = $recipe['finalQuantity'] !== null && $recipe['finalUnit'] && $recipe['finalQuantity']->gt(0)
            ? Units::toBase($recipe['finalQuantity'], $recipe['finalUnit']) : null;
        $complete = true;
        foreach ($issues as $i) {
            if ($i['severity'] === 'error') {
                $complete = false;
                break;
            }
        }

        return [
            'recipeId' => $recipe['id'],
            'revisionId' => $recipe['revisionId'],
            'revisionNumber' => $recipe['revisionNumber'] ?? null,
            'code' => $recipe['code'],
            'title' => $recipe['title'],
            'date' => $ctx['date'],
            'complete' => $complete,
            'issues' => self::dedupe($issues),
            'ingredientLines' => $ingredientLines,
            'subrecipeLines' => $subrecipeLines,
            'equipmentLines' => $equipmentLines,
            'laborLines' => $laborLines,
            'directIngredients' => $directIngredients,
            'subrecipes' => $subrecipes,
            'energy' => $energySum,
            'labor' => $labor,
            'total' => $total,
            'expanded' => $expanded,
            'finalQuantity' => $recipe['finalQuantity'],
            'finalUnit' => $recipe['finalUnit'],
            'finalWeightKg' => $finalWeightKg,
            'portions' => $portions,
            'portionWeightKg' => $finalWeightKg && $portions ? $finalWeightKg->div($portions) : null,
            'costPerKg' => $finalWeightKg ? $total->div($finalWeightKg) : null,
            'costPerPortion' => $portions ? $total->div($portions) : null,
            'costPerYieldUnit' => $finalQtyBase ? $total->div($finalQtyBase) : null,
            'machineMinutes' => Dec::sum(array_map(fn ($u) => $u['minutes'], $recipe['equipmentUses'])),
            'personMinutes' => Dec::sum(array_map(fn ($a) => $a['activeMinutes'], $recipe['laborAssignments'])),
            'declaredDurationMinutes' => $recipe['declaredDurationMinutes'],
        ];
    }
}
