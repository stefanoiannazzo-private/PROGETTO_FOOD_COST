<?php

namespace Tests\Feature;

use App\Support\Clock;
use Illuminate\Support\Facades\DB;
use Tests\ApiClient;
use Tests\TestCase;

/** NUOVO — Coefficiente di redditività: calcolo, fonti dei costi fissi, permessi, isolamento. */
class ProfitabilityTest extends TestCase
{
    private string $company;

    private ApiClient $a;

    private string $pizza;

    protected function setUp(): void
    {
        parent::setUp();
        $this->company = $this->createCompany('Pizzeria Test');
        $this->addMember($this->company, $this->createUser('admin@pz.test', 'Admin'), 'admin');
        $this->addMember($this->company, $this->createUser('resp@pz.test', 'Resp'), 'manager', ['salaries.read']);
        $this->addMember($this->company, $this->createUser('op@pz.test', 'Op'), 'operator');
        $this->a = $this->loginAs('admin@pz.test');
        // pizza: 10 porzioni, 2 kg di farina a 5 €/kg = 10 € + forno 0,5 kWh × 2 € = 1 € → 1,10 € variabili a pizza; manodopera esclusa
        $ing = $this->ok($this->a->post('/api/ingredients', ['code' => 'FAR', 'name' => 'Farina', 'packageContent' => '1', 'packageUnit' => 'kg', 'usageUnit' => 'g', 'initialPrice' => ['packagePrice' => '5', 'validFrom' => '2026-01-01']]))['id'];
        $luce = $this->ok($this->a->post('/api/tariffs', ['name' => 'Luce', 'kind' => 'electricity', 'unit' => 'kwh', 'firstVersion' => ['mode' => 'direct', 'pricePerUnit' => '2', 'validFrom' => '2026-01-01']]))['id'];
        $forno = $this->ok($this->a->post('/api/equipment', ['code' => 'F', 'name' => 'Forno', 'powerType' => 'electric', 'electricPowerKw' => '1', 'usageCoefficient' => '1', 'electricTariffId' => $luce]))['id'];
        $emp = $this->ok($this->a->post('/api/employees', ['code' => 'D1', 'firstName' => 'Mario', 'lastName' => 'Rossi', 'firstCost' => ['validFrom' => '2026-01-01', 'grossMonthly' => '2000', 'extraMonthly' => '200', 'contributionsMode' => 'amount', 'contributionsValue' => '400', 'productiveHours' => '160']]))['id'];
        $this->pizza = $this->ok($this->a->post('/api/recipes', ['code' => 'MARG', 'title' => 'Pizza margherita', 'status' => 'active', 'revision' => [
            'portions' => '10', 'finalWeightKg' => '3',
            'components' => [['kind' => 'ingredient', 'ingredientId' => $ing, 'quantity' => '2', 'unit' => 'kg']],
            'equipmentUses' => [['equipmentId' => $forno, 'minutes' => '30']],
            'labor' => [['employeeId' => $emp, 'activeMinutes' => '60']],
        ]]))['id'];
    }

    private function cost(array $b): string
    {
        return $this->ok($this->a->post('/api/profitability/fixed-costs', $b))['id'];
    }

    private function dish(array $r, string $code): array
    {
        return collect($r['dishes'])->firstWhere('code', $code);
    }

    public function test_calcolo_completo(): void
    {
        $this->cost(['name' => 'Affitto locale', 'category' => 'rent', 'amount' => '2400', 'period' => 'monthly', 'validFrom' => '2026-01-01']);
        $this->cost(['name' => 'Rate forno', 'category' => 'leasing', 'amount' => '4800', 'period' => 'yearly', 'validFrom' => '2026-01-01', 'validTo' => '2099-12-31']);
        $this->cost(['name' => 'Vecchio finanziamento', 'category' => 'loan', 'amount' => '999', 'period' => 'monthly', 'validFrom' => '2020-01-01', 'validTo' => '2025-12-31']);
        $this->ok($this->a->put("/api/profitability/prices/{$this->pizza}", ['menuPrice' => '7.70', 'vatPercent' => '10']));
        $this->ok($this->a->put('/api/profitability/settings', ['closedWeekdays' => [1], 'includeStaff' => true, 'referenceRecipeId' => $this->pizza]));

        $r = $this->ok($this->a->get('/api/profitability'));
        $this->assertSame(6, $r['openDaysPerWeek']);
        $this->assertSame([1], $r['settings']['closedWeekdays']);
        // personale: 2000 + 200 extra + 400 oneri = 2600 €/mese
        $this->assertSame('2600', $r['staff']['monthly']);
        // 2400 + 400 (4800/12) + 2600 = 5400 €/mese; il finanziamento scaduto non conta
        $this->assertSame('5400', $r['totals']['monthly']);
        $this->assertSame('1246.1538', $r['totals']['weekly']);
        $this->assertSame('207.6923', $r['totals']['perOpenDay']);
        $this->assertSame(['active', 'active', 'ended'], collect($r['fixedCosts'])->sortBy('name')->pluck('status')->values()->all());
        $this->assertSame('ended', collect($r['fixedCosts'])->firstWhere('name', 'Vecchio finanziamento')['status']);

        $d = $this->dish($r, 'MARG');
        $this->assertSame('7.70', $d['menuPrice']);
        $this->assertSame('7', $d['netPrice']);          // 7,70 / 1,10
        $this->assertSame('1.1', $d['variableCost']);     // (10 + 1) / 10, senza manodopera
        $this->assertSame('5.9', $d['margin']);
        // 1246,15 / 5,9 = 211,2 → 212 a settimana; 207,69 / 5,9 = 35,2 → 36 per giorno di apertura
        $this->assertSame([212, 36, 916], [$d['perWeek'], $d['perOpenDay'], $d['perMonth']]);
        $this->assertNull($d['issue']);
    }

    public function test_personale_escludibile_e_quote_fisse_bollette(): void
    {
        $gas = $this->ok($this->a->post('/api/tariffs', ['name' => 'Gas', 'kind' => 'gas', 'unit' => 'smc', 'firstVersion' => [
            'mode' => 'bill', 'validFrom' => '2026-02-01', 'periodFrom' => '2026-01-01', 'periodTo' => '2026-01-31', 'consumption' => '100', 'consumptionUnit' => 'smc', 'vatBasis' => 'net',
            'components' => [
                ['label' => 'Materia prima', 'amount' => '80', 'kind' => 'variable', 'include' => true],
                ['label' => 'Quota fissa inclusa', 'amount' => '10', 'kind' => 'fixed', 'include' => true],
                ['label' => 'Canone escluso', 'amount' => '31', 'kind' => 'fixed', 'include' => false],
            ],
        ]]));
        $this->assertNotEmpty($gas['id']);
        $this->ok($this->a->put('/api/profitability/settings', ['closedWeekdays' => [], 'includeStaff' => false, 'referenceRecipeId' => null]));
        $r = $this->ok($this->a->get('/api/profitability'));
        // solo la voce fissa NON inclusa nel prezzo unitario: 31 € su 31 giorni → 30,4375 € al mese medio
        $this->assertSame([['bill', 'Quote fisse · Gas', '30.4375']], array_map(fn ($l) => [$l['source'], $l['label'], $l['monthly']], $r['lines']));
        $this->assertFalse($r['staff']['included']);
        $this->assertSame('2600', $r['staff']['monthly']);
    }

    public function test_casi_senza_risposta(): void
    {
        $r = $this->ok($this->a->get('/api/profitability'));
        $this->assertSame('missing_price', $this->dish($r, 'MARG')['issue']);
        $this->assertSame('1.1', $this->dish($r, 'MARG')['variableCost']);
        $this->ok($this->a->put("/api/profitability/prices/{$this->pizza}", ['menuPrice' => '1.10', 'vatPercent' => '10']));
        $this->assertSame('no_margin', $this->dish($this->ok($this->a->get('/api/profitability')), 'MARG')['issue']);
        // prezzo rimosso
        $this->ok($this->a->put("/api/profitability/prices/{$this->pizza}", ['menuPrice' => null, 'vatPercent' => '10']));
        $this->assertNull($this->dish($this->ok($this->a->get('/api/profitability')), 'MARG')['menuPrice']);
    }

    public function test_validazioni(): void
    {
        $this->assertSame(422, $this->a->put('/api/profitability/settings', ['closedWeekdays' => [1, 2, 3, 4, 5, 6, 7], 'includeStaff' => true, 'referenceRecipeId' => null])->status);
        $this->assertSame(422, $this->a->put('/api/profitability/settings', ['closedWeekdays' => [8], 'includeStaff' => true, 'referenceRecipeId' => null])->status);
        $bad = $this->a->post('/api/profitability/fixed-costs', ['name' => 'X', 'category' => 'rent', 'amount' => '1.000,00', 'period' => 'monthly', 'validFrom' => '2026-01-01', 'validTo' => '2025-01-01']);
        $this->assertSame(422, $bad->status);
        $this->assertArrayHasKey('amount', $bad->body['error']['details']['fields']);
        $this->assertSame(422, $this->a->post('/api/profitability/fixed-costs', ['name' => 'X', 'category' => 'rent', 'amount' => '100', 'period' => 'monthly', 'validFrom' => '2026-01-01', 'validTo' => '2025-01-01'])->status);
        $this->assertSame(422, $this->a->put("/api/profitability/prices/{$this->pizza}", ['menuPrice' => '-1', 'vatPercent' => '10'])->status);
    }

    public function test_modifica_ed_eliminazione_costo_fisso(): void
    {
        $id = $this->cost(['name' => 'Affitto', 'category' => 'rent', 'amount' => '1000', 'period' => 'monthly', 'validFrom' => '2026-01-01']);
        $this->ok($this->a->put("/api/profitability/fixed-costs/{$id}", ['name' => 'Affitto', 'category' => 'rent', 'amount' => '1200', 'period' => 'monthly', 'validFrom' => '2026-01-01', 'notes' => 'rinnovo']));
        $this->ok($this->a->put('/api/profitability/settings', ['closedWeekdays' => [], 'includeStaff' => false, 'referenceRecipeId' => null]));
        $this->assertSame('1200', $this->ok($this->a->get('/api/profitability'))['totals']['monthly']);
        $this->ok($this->a->del("/api/profitability/fixed-costs/{$id}"));
        $this->assertSame('0', $this->ok($this->a->get('/api/profitability'))['totals']['monthly']);
        $this->assertSame(404, $this->a->del("/api/profitability/fixed-costs/{$id}")->status);
    }

    public function test_solo_amministratore(): void
    {
        $id = $this->cost(['name' => 'Affitto', 'category' => 'rent', 'amount' => '1000', 'period' => 'monthly', 'validFrom' => '2026-01-01']);
        // anche un responsabile con il permesso sulle retribuzioni non lo vede
        foreach (['resp@pz.test', 'op@pz.test'] as $email) {
            $c = $this->loginAs($email);
            $this->assertSame(403, $c->get('/api/profitability')->status, $email);
            $this->assertSame(403, $c->post('/api/profitability/fixed-costs', ['name' => 'X', 'category' => 'rent', 'amount' => '1', 'period' => 'monthly', 'validFrom' => '2026-01-01'])->status);
            $this->assertSame(403, $c->del("/api/profitability/fixed-costs/{$id}")->status);
            $this->assertSame(403, $c->put("/api/profitability/prices/{$this->pizza}", ['menuPrice' => '9', 'vatPercent' => '10'])->status);
        }
        $this->assertSame(401, $this->client()->get('/api/profitability')->status);
        // il prezzo non compare nelle risposte delle ricette (nessun impatto sulle API dell'originale)
        $this->ok($this->a->put("/api/profitability/prices/{$this->pizza}", ['menuPrice' => '9', 'vatPercent' => '10']));
        $this->assertStringNotContainsString('menu', json_encode($this->ok($this->loginAs('resp@pz.test')->get("/api/recipes/{$this->pizza}"))));
    }

    public function test_isolamento_tra_aziende(): void
    {
        $id = $this->cost(['name' => 'Affitto', 'category' => 'rent', 'amount' => '1000', 'period' => 'monthly', 'validFrom' => '2026-01-01']);
        $other = $this->createCompany('Altra');
        $this->addMember($other, $this->createUser('altro@pz.test', 'Altro'), 'admin');
        $b = $this->loginAs('altro@pz.test');
        $r = $this->ok($b->get('/api/profitability'));
        $this->assertSame([], $r['fixedCosts']);
        $this->assertSame([], $r['dishes']);
        $this->assertSame(404, $b->put("/api/profitability/fixed-costs/{$id}", ['name' => 'X', 'category' => 'rent', 'amount' => '1', 'period' => 'monthly', 'validFrom' => '2026-01-01'])->status);
        $this->assertSame(404, $b->del("/api/profitability/fixed-costs/{$id}")->status);
        $this->assertSame(404, $b->put("/api/profitability/prices/{$this->pizza}", ['menuPrice' => '1', 'vatPercent' => '10'])->status);
        $this->assertSame(422, $b->put('/api/profitability/settings', ['closedWeekdays' => [], 'includeStaff' => true, 'referenceRecipeId' => $this->pizza])->status);
        $this->assertSame(1, DB::table('fixed_costs')->count());
    }

    public function test_eliminare_la_ricetta_rimuove_prezzo_e_riferimento(): void
    {
        $this->ok($this->a->put("/api/profitability/prices/{$this->pizza}", ['menuPrice' => '9', 'vatPercent' => '10']));
        $this->ok($this->a->put('/api/profitability/settings', ['closedWeekdays' => [], 'includeStaff' => true, 'referenceRecipeId' => $this->pizza]));
        $this->ok($this->a->del("/api/recipes/{$this->pizza}"));
        $this->assertSame(0, DB::table('recipe_prices')->count());
        $this->assertNull($this->ok($this->a->get('/api/profitability'))['settings']['referenceRecipeId']);
        $this->assertNotEmpty(Clock::today());
    }
}
