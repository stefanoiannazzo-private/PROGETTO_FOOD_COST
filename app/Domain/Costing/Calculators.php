<?php

declare(strict_types=1);

namespace App\Domain\Costing;

/**
 * Calcolatori elementari (port 1:1 di calculators.ts).
 * Gli input sono array associativi con le stesse chiavi dei tipi TypeScript originali; i numeri sono Dec.
 */
final class Calculators
{
    /* ============================ Ingredienti ============================ */

    /** Prezzo normalizzato per unità di base (€/kg, €/l o €/pz) a partire dalla confezione. */
    public static function normalizedPrice(array $ing): ?Dec
    {
        if ($ing['packagePrice'] === null) {
            return null;
        }
        $contentBase = Units::convertToDimension($ing['packageContent'], $ing['packageUnit'], Units::dimensionOf($ing['packageUnit']));
        if ($contentBase->lte(0)) {
            throw new DomainError('invalid_package_content', 'Il contenuto della confezione deve essere maggiore di zero.');
        }

        return $ing['packagePrice']->div($contentBase);
    }

    /**
     * Costo dell'utilizzo di un ingrediente. Quantità di ricetta netta: acquistata = netta / resa edibile.
     *
     * @return array{netBaseQuantity: Dec, grossBaseQuantity: Dec, baseUnit: string, unitPrice: ?Dec, cost: ?Dec}
     */
    public static function ingredientUsageCost(array $ing, Dec $quantity, string $unit): array
    {
        if ($ing['edibleYield']->lte(0) || $ing['edibleYield']->gt(1)) {
            throw new DomainError('invalid_yield', "Resa edibile non valida per {$ing['name']}: deve essere maggiore di 0 e al massimo 100%.");
        }
        $dimension = Units::dimensionOf($ing['packageUnit']);
        $net = Units::convertToDimension($quantity, $unit, $dimension, [
            'densityKgPerL' => $ing['densityKgPerL'] ?? null,
            'unitWeightKg' => $ing['unitWeightKg'] ?? null,
        ]);
        $gross = $net->div($ing['edibleYield']);
        $unitPrice = self::normalizedPrice($ing);

        return [
            'netBaseQuantity' => $net,
            'grossBaseQuantity' => $gross,
            'baseUnit' => Units::BASE_UNIT[$dimension],
            'unitPrice' => $unitPrice,
            'cost' => $unitPrice === null ? null : $gross->times($unitPrice),
        ];
    }

    /* ============================ Manodopera ============================ */

    /**
     * Costi del dipendente. Novità rispetto all'originale: 'extraMonthly' (voce aggiuntiva della retribuzione,
     * facoltativa) si somma al lordo mensile prima di ogni altro calcolo. Assente o null = nessun effetto.
     *
     * @return array{grossHourly: Dec, companyMonthly: Dec, companyHourly: Dec, costPerMinute: Dec, contributions: Dec, basis: string}
     */
    public static function employeeRates(array $e): array
    {
        if ($e['productiveHours']->lte(0)) {
            throw new DomainError('invalid_hours', 'Le ore mensili produttive devono essere maggiori di zero.');
        }
        if ($e['grossMonthly']->lt(0)) {
            throw new DomainError('invalid_gross', 'Il lordo mensile non può essere negativo.');
        }
        $gross = $e['grossMonthly'];
        if (($e['extraMonthly'] ?? null) !== null) {
            $gross = $gross->plus($e['extraMonthly']);
        }
        $contributions = Dec::zero();
        if ($e['contributionsMode'] === 'amount') {
            $contributions = $e['contributionsValue'] ?? Dec::zero();
        } elseif ($e['contributionsMode'] === 'percent') {
            $contributions = $gross->times($e['contributionsValue'] ?? Dec::zero())->div(100);
        }
        $other = $e['otherMonthlyCosts'] ?? Dec::zero();
        $companyMonthly = $gross->plus($contributions)->plus($other);
        $companyHourly = $companyMonthly->div($e['productiveHours']);
        $onlyGross = $e['contributionsMode'] === 'none' && $other->isZero();

        return [
            'grossHourly' => $gross->div($e['productiveHours']),
            'companyMonthly' => $companyMonthly,
            'companyHourly' => $companyHourly,
            'costPerMinute' => $companyHourly->div(Dec::sixty()),
            'contributions' => $contributions,
            'basis' => $onlyGross ? 'gross_only' : 'company_cost',
        ];
    }

    /** Costo = minuti attivi × costo al minuto × quota. */
    public static function laborCost(Dec $activeMinutes, Dec $costPerMinute, ?Dec $share = null): Dec
    {
        return $activeMinutes->times($costPerMinute)->times($share ?? Dec::one());
    }

    /* ============================== Energia ============================== */

    /** kWh = kW × minuti / 60 × coefficiente. */
    public static function electricConsumptionKwh(Dec $powerKw, Dec $minutes, Dec $coefficient): Dec
    {
        return $powerKw->times($minutes)->div(Dec::sixty())->times($coefficient);
    }

    /** consumo = portata oraria × minuti / 60 [× fattore di carico]. */
    public static function gasConsumption(Dec $flowPerHour, Dec $minutes, ?Dec $loadFactor = null): Dec
    {
        $base = $flowPerHour->times($minutes)->div(Dec::sixty());

        return $loadFactor !== null ? $base->times($loadFactor) : $base;
    }

    /** Porta un consumo nell'unità della tariffa usando solo coefficienti configurati. */
    public static function convertGasToTariffUnit(Dec $quantity, string $from, array $tariff): Dec
    {
        if ($from === $tariff['unit']) {
            return $quantity;
        }
        $m3ToSmc = isset($tariff['m3ToSmc']) && $tariff['m3ToSmc'] !== null && $tariff['m3ToSmc']->gt(0) ? $tariff['m3ToSmc'] : null;
        $smcToKwh = isset($tariff['smcToKwh']) && $tariff['smcToKwh'] !== null && $tariff['smcToKwh']->gt(0) ? $tariff['smcToKwh'] : null;
        $to = $tariff['unit'];
        if ($from === 'm3' && $to === 'smc' && $m3ToSmc) {
            return $quantity->times($m3ToSmc);
        }
        if ($from === 'smc' && $to === 'm3' && $m3ToSmc) {
            return $quantity->div($m3ToSmc);
        }
        if ($from === 'smc' && $to === 'kwh' && $smcToKwh) {
            return $quantity->times($smcToKwh);
        }
        if ($from === 'm3' && $to === 'kwh' && $m3ToSmc && $smcToKwh) {
            return $quantity->times($m3ToSmc)->times($smcToKwh);
        }
        if ($from === 'kwh' && $to === 'smc' && $smcToKwh) {
            return $quantity->div($smcToKwh);
        }
        if ($from === 'kwh' && $to === 'm3' && $m3ToSmc && $smcToKwh) {
            return $quantity->div($smcToKwh)->div($m3ToSmc);
        }
        throw new DomainError(
            'gas_unit_mismatch',
            "La tariffa \"{$tariff['name']}\" è in €/".self::unitLabel($to).' ma il consumo è in '.self::unitLabel($from).': configura il coefficiente di conversione sulla tariffa.',
        );
    }

    public static function unitLabel(string $u): string
    {
        return $u === 'kwh' ? 'kWh' : ($u === 'm3' ? 'm³' : 'Smc');
    }

    private static function coefficientFor(string $segment, array $el): ?Dec
    {
        if ($segment === 'preheat' && ($el['preheatCoefficient'] ?? null) !== null) {
            return $el['preheatCoefficient'];
        }
        if ($segment === 'hold' && ($el['holdCoefficient'] ?? null) !== null) {
            return $el['holdCoefficient'];
        }

        return $el['usageCoefficient'] ?? null;
    }

    /**
     * Fonti energetiche di un uso strumento. Non applica la quota di imputazione.
     *
     * @param  array  $req  equipment, segment, minutes, sources?, measuredElectricKwh?, measuredGasQuantity?, measuredGasUnit?, tariffs (array id => tariff)
     * @return array{sources: list<array>, issues: list<array{code: string, message: string}>, manual: bool}
     */
    public static function energyForUse(array $req): array
    {
        $eq = $req['equipment'];
        $issues = [];
        if ($eq['powerType'] === 'manual') {
            return ['sources' => [], 'issues' => $issues, 'manual' => true];
        }
        $reqSources = $req['sources'] ?? null;
        $wanted = match ($eq['powerType']) {
            'electric' => ['electric'],
            'gas' => ['gas'],
            default => $reqSources ? $reqSources : ['electric', 'gas'],
        };
        $tariffs = $req['tariffs'];
        $sources = [];

        foreach ($wanted as $source) {
            $detail = [
                'source' => $source,
                'estimated' => true,
                'consumption' => null,
                'consumptionUnit' => null,
                'billedConsumption' => null,
                'tariffId' => null,
                'tariffUnit' => null,
                'tariffPrice' => null,
                'coefficient' => null,
                'cost' => null,
            ];

            if ($source === 'electric') {
                $el = $eq['electric'] ?? null;
                if (! $el) {
                    $issues[] = ['code' => 'missing_electric_params', 'message' => "{$eq['name']}: parametri elettrici non configurati."];
                    $sources[] = $detail;

                    continue;
                }
                $detail['consumptionUnit'] = 'kwh';
                if (($req['measuredElectricKwh'] ?? null) !== null) {
                    $detail['consumption'] = $req['measuredElectricKwh'];
                    $detail['estimated'] = false;
                } else {
                    $coeff = self::coefficientFor($req['segment'], $el);
                    $detail['coefficient'] = $coeff;
                    $power = $el['powerKw'] ?? null;
                    if ($power === null || $power->lte(0)) {
                        $issues[] = ['code' => 'missing_power', 'message' => "{$eq['name']}: potenza nominale (kW) mancante."];
                        $sources[] = $detail;

                        continue;
                    }
                    if ($coeff === null || $coeff->lte(0) || $coeff->gt(1)) {
                        $issues[] = ['code' => 'missing_coefficient', 'message' => "{$eq['name']}: coefficiente di utilizzo mancante o fuori intervallo (0–1]."];
                        $sources[] = $detail;

                        continue;
                    }
                    $detail['consumption'] = self::electricConsumptionKwh($power, $req['minutes'], $coeff);
                }
                $tid = $el['tariffId'] ?? null;
                $tariff = $tid ? ($tariffs[$tid] ?? null) : null;
                if (! $tariff) {
                    $issues[] = ['code' => 'missing_tariff', 'message' => "{$eq['name']}: tariffa elettrica non configurata o non valida alla data."];
                    $sources[] = $detail;

                    continue;
                }
                $detail['tariffId'] = $tariff['id'];
                $detail['tariffUnit'] = $tariff['unit'];
                $detail['tariffPrice'] = $tariff['pricePerUnit'];
                if ($tariff['kind'] !== 'electricity' || $tariff['unit'] !== 'kwh') {
                    $issues[] = ['code' => 'tariff_unit_mismatch', 'message' => "{$eq['name']}: la tariffa elettrica deve essere in €/kWh."];
                    $sources[] = $detail;

                    continue;
                }
                $detail['billedConsumption'] = $detail['consumption'];
                $detail['cost'] = $detail['consumption']->times($tariff['pricePerUnit']);
                $sources[] = $detail;
            } else {
                $gas = $eq['gas'] ?? null;
                if (! $gas) {
                    $issues[] = ['code' => 'missing_gas_params', 'message' => "{$eq['name']}: parametri gas non configurati."];
                    $sources[] = $detail;

                    continue;
                }
                $load = $gas['loadFactor'] ?? null;
                if (($req['measuredGasQuantity'] ?? null) !== null) {
                    if (! ($req['measuredGasUnit'] ?? null)) {
                        $issues[] = ['code' => 'missing_measured_unit', 'message' => "{$eq['name']}: unità del consumo gas misurato mancante."];
                        $sources[] = $detail;

                        continue;
                    }
                    $detail['consumption'] = $req['measuredGasQuantity'];
                    $detail['consumptionUnit'] = $req['measuredGasUnit'];
                    $detail['estimated'] = false;
                } elseif ($gas['mode'] === 'flow') {
                    $flow = $gas['flowPerHour'] ?? null;
                    if ($flow === null || $flow->lte(0) || ! ($gas['flowUnit'] ?? null)) {
                        $issues[] = ['code' => 'missing_gas_flow', 'message' => "{$eq['name']}: portata gas oraria o relativa unità mancante."];
                        $sources[] = $detail;

                        continue;
                    }
                    $detail['coefficient'] = $load;
                    $detail['consumption'] = self::gasConsumption($flow, $req['minutes'], $load);
                    $detail['consumptionUnit'] = $gas['flowUnit'];
                } else {
                    $power = $gas['powerKw'] ?? null;
                    if ($power === null || $power->lte(0)) {
                        $issues[] = ['code' => 'missing_power', 'message' => "{$eq['name']}: potenza gas (kW) mancante."];
                        $sources[] = $detail;

                        continue;
                    }
                    $detail['coefficient'] = $load;
                    $detail['consumption'] = self::electricConsumptionKwh($power, $req['minutes'], $load ?? Dec::one());
                    $detail['consumptionUnit'] = 'kwh';
                }
                $tid = $gas['tariffId'] ?? null;
                $tariff = $tid ? ($tariffs[$tid] ?? null) : null;
                if (! $tariff) {
                    $issues[] = ['code' => 'missing_tariff', 'message' => "{$eq['name']}: tariffa gas non configurata o non valida alla data."];
                    $sources[] = $detail;

                    continue;
                }
                $detail['tariffId'] = $tariff['id'];
                $detail['tariffUnit'] = $tariff['unit'];
                $detail['tariffPrice'] = $tariff['pricePerUnit'];
                if ($tariff['kind'] !== 'gas') {
                    $issues[] = ['code' => 'tariff_unit_mismatch', 'message' => "{$eq['name']}: la tariffa associata al gas non è una tariffa gas."];
                    $sources[] = $detail;

                    continue;
                }
                try {
                    $detail['billedConsumption'] = self::convertGasToTariffUnit($detail['consumption'], $detail['consumptionUnit'], $tariff);
                    $detail['cost'] = $detail['billedConsumption']->times($tariff['pricePerUnit']);
                } catch (DomainError $e) {
                    $issues[] = ['code' => $e->errorCode, 'message' => "{$eq['name']}: {$e->getMessage()}"];
                }
                $sources[] = $detail;
            }
        }

        return ['sources' => $sources, 'issues' => $issues, 'manual' => false];
    }
}
