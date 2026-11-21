<?php

namespace Tests\Feature;

use App\Support\Clock;
use Tests\ApiClient;
use Tests\TestCase;

/**
 * Port di apps/api/test/costing-flow.test.ts.
 * Nell'originale i test di un blocco condividono lo stato in sequenza; qui ogni test
 * parte da un database pulito e ricostruisce i prerequisiti con gli stessi passi.
 */
class CostingFlowTest extends TestCase
{
    private ApiClient $a;

    /** @var array<string,string> */
    private array $ids = [];

    protected function setUp(): void
    {
        parent::setUp();
        $c = $this->createCompany('Gastronomia Test');
        $this->addMember($c, $this->createUser('admin@example.test', 'Admin'), 'admin');
        $this->a = $this->loginAs('admin@example.test');
        $ing = fn (string $k, array $b) => $this->ids[$k] = $this->ok($this->a->post('/api/ingredients', $b))['id'];
        $ing('carne', ['code' => 'CARNE', 'name' => 'Carne macinata', 'packageContent' => '1', 'packageUnit' => 'kg', 'usageUnit' => 'g', 'initialPrice' => ['packagePrice' => '8', 'validFrom' => '2026-01-01']]);
        $ing('pomodoro', ['code' => 'POM', 'name' => 'Pomodoro pelato', 'packageContent' => '2.5', 'packageUnit' => 'kg', 'usageUnit' => 'g', 'initialPrice' => ['packagePrice' => '5', 'validFrom' => '2026-01-01']]);
        $ing('sfoglia', ['code' => 'SFO', 'name' => 'Sfoglia fresca', 'packageContent' => '1', 'packageUnit' => 'kg', 'usageUnit' => 'g', 'initialPrice' => ['packagePrice' => '8', 'validFrom' => '2026-01-01']]);
        $this->ids['luce'] = $this->ok($this->a->post('/api/tariffs', ['name' => 'Luce', 'kind' => 'electricity', 'unit' => 'kwh', 'firstVersion' => ['mode' => 'direct', 'pricePerUnit' => '0.5', 'validFrom' => '2026-01-01']]))['id'];
        $this->ids['forno'] = $this->ok($this->a->post('/api/equipment', ['code' => 'FORNO', 'name' => 'Forno', 'powerType' => 'electric', 'electricPowerKw' => '5', 'usageCoefficient' => '0.8', 'electricTariffId' => $this->ids['luce']]))['id'];
        $this->ids['mario'] = $this->ok($this->a->post('/api/employees', ['code' => 'D1', 'firstName' => 'Mario', 'lastName' => 'Rossi', 'firstCost' => ['validFrom' => '2026-01-01', 'grossMonthly' => '2400', 'contributionsMode' => 'none', 'productiveHours' => '160']]))['id'];
    }

    private function raguRevision(): array
    {
        return [
            'finalQuantity' => '5', 'finalUnit' => 'kg', 'finalWeightKg' => '5',
            'phases' => [['key' => 'f1', 'name' => 'Rosolatura e cottura']],
            'components' => [
                ['kind' => 'ingredient', 'ingredientId' => $this->ids['carne'], 'quantity' => '2000', 'unit' => 'g'],
                ['kind' => 'ingredient', 'ingredientId' => $this->ids['pomodoro'], 'quantity' => '2', 'unit' => 'kg'],
            ],
            'equipmentUses' => [['phaseKey' => 'f1', 'equipmentId' => $this->ids['forno'], 'segment' => 'work', 'minutes' => '60', 'sharePercent' => '100']],
            'labor' => [['phaseKey' => 'f1', 'employeeId' => $this->ids['mario'], 'activeMinutes' => '48', 'sharePercent' => '100']],
        ];
    }

    private function ragu(): void
    {
        $this->ids['ragu'] = $this->ok($this->a->post('/api/recipes', ['code' => 'RAGU', 'title' => 'Ragù', 'status' => 'active', 'revision' => $this->raguRevision()]))['id'];
    }

    private function lasagna(): void
    {
        $this->ids['lasagna'] = $this->ok($this->a->post('/api/recipes', [
            'code' => 'LAS', 'title' => 'Lasagna', 'status' => 'active',
            'revision' => [
                'finalQuantity' => '8', 'finalUnit' => 'pz', 'finalWeightKg' => '2.4', 'portions' => '8',
                'components' => [
                    ['kind' => 'recipe', 'recipeId' => $this->ids['ragu'], 'quantity' => '600', 'unit' => 'g'],
                    ['kind' => 'ingredient', 'ingredientId' => $this->ids['sfoglia'], 'quantity' => '1', 'unit' => 'kg'],
                ],
                'equipmentUses' => [['equipmentId' => $this->ids['forno'], 'segment' => 'work', 'minutes' => '30', 'sharePercent' => '100']],
                'labor' => [['employeeId' => $this->ids['mario'], 'activeMinutes' => '24', 'sharePercent' => '100']],
            ],
        ]))['id'];
    }

    private function base(): void
    {
        $this->ragu();
        $this->lasagna();
    }

    /** snapshot + nuovo prezzo (passi del test "snapshot, nuovo prezzo…") */
    private function snapshotAndPrice(): string
    {
        $las = $this->ok($this->a->get("/api/recipes/{$this->ids['lasagna']}"));
        $snap = $this->ok($this->a->post("/api/recipes/{$this->ids['lasagna']}/snapshots", ['label' => 'Listino autunno', 'expectedRevisionId' => $las['revision']['id']]));
        $price = $this->ok($this->a->post("/api/ingredients/{$this->ids['carne']}/prices", ['packagePrice' => '9', 'validFrom' => Clock::today(), 'source' => 'Fattura fornitore']));
        $this->ids['snap'] = $snap['id'];

        return json_encode([$snap, $price]);
    }

    // --- Percorso ragù → lasagna ---

    public function test_ragu_34_euro_per_lotto(): void
    {
        $this->ragu();
        $v = $this->ok($this->a->get("/api/recipes/{$this->ids['ragu']}"))['valuation'];
        $this->assertTrue($v['complete']);
        $this->assertSame(['20', '2', '12', '34', '6.8'], [$v['directIngredients'], $v['energy'], $v['labor'], $v['total'], $v['costPerKg']]);
        $this->assertSame('60', $v['machineMinutes']);
        $this->assertSame('48', $v['personMinutes']);
    }

    public function test_lasagna_con_600g_di_ragu(): void
    {
        $this->base();
        $v = $this->ok($this->a->get("/api/recipes/{$this->ids['lasagna']}"))['valuation'];
        $this->assertSame('4.08', $v['subrecipeLines'][0]['cost']);
        $this->assertSame('19.08', $v['total']);
        $this->assertSame('7.95', $v['costPerKg']);
        $this->assertSame('2.385', $v['costPerPortion']);
        $this->assertSame('10.4', $v['expanded']['ingredients']);
        $this->assertSame('34', $v['subrecipeLines'][0]['sub']['total']);
    }

    public function test_elenco_ricette_mostra_costi(): void
    {
        $this->base();
        $las = collect($this->ok($this->a->get('/api/recipes?sort=title'))['data'])->firstWhere('code', 'LAS');
        $this->assertTrue($las['cost']['complete']);
        $this->assertSame('19.08', $las['cost']['total']);
        $this->assertSame('7.95', $las['cost']['costPerKg']);
    }

    public function test_impedisce_cicli(): void
    {
        $this->base();
        $ragu = $this->ok($this->a->get("/api/recipes/{$this->ids['ragu']}"));
        $rev = $this->raguRevision();
        $rev['components'][] = ['kind' => 'recipe', 'recipeId' => $this->ids['lasagna'], 'quantity' => '100', 'unit' => 'g'];
        $r = $this->a->put("/api/recipes/{$this->ids['ragu']}", ['code' => 'RAGU', 'title' => 'Ragù', 'status' => 'active', 'lockVersion' => $ragu['lockVersion'], 'revision' => $rev]);
        $this->assertSame(409, $r->status);
        $this->assertSame('cycle', $r->body['error']['code']);
        $this->assertSame(['Ragù', 'Lasagna', 'Ragù'], $r->body['error']['details']['path']);
        $self = $this->a->put("/api/recipes/{$this->ids['ragu']}", ['code' => 'RAGU', 'title' => 'Ragù', 'lockVersion' => $ragu['lockVersion'], 'revision' => array_merge($this->raguRevision(), ['components' => [['kind' => 'recipe', 'recipeId' => $this->ids['ragu'], 'quantity' => '1', 'unit' => 'kg']]])]);
        $this->assertSame(409, $self->status);
        $opts = $this->ok($this->a->get("/api/recipes/options?exclude={$this->ids['ragu']}"));
        $this->assertNotContains('LAS', array_column($opts['data'], 'code'));
    }

    public function test_snapshot_prezzo_propagazione_confronto(): void
    {
        $this->base();
        [$snap, $price] = json_decode($this->snapshotAndPrice(), true);
        $this->assertSame('19.08', $snap['total']);
        $codes = array_column($price['affectedRecipes'], 'code');
        sort($codes);
        $this->assertSame(['LAS', 'RAGU'], $codes);
        $after = $this->ok($this->a->get("/api/recipes/{$this->ids['lasagna']}"));
        $this->assertSame('4.32', $after['valuation']['subrecipeLines'][0]['cost']);
        $this->assertSame('19.32', $after['valuation']['total']);
        $this->assertSame('19.08', $after['comparison']['snapshotTotal']);
        $this->assertSame('0.24', $after['comparison']['deltaTotal']);
        $this->assertMatchesRegularExpression('/semilavorato Ragù/', implode(' ', $after['comparison']['reasons']));
        $stored = $this->ok($this->a->get("/api/snapshots/{$snap['id']}"));
        $this->assertSame('19.08', $stored['data']['total']);
        $this->assertSame('8', $stored['data']['subrecipeLines'][0]['sub']['ingredientLines'][0]['unitPrice']);
        $past = $this->ok($this->a->get("/api/recipes/{$this->ids['lasagna']}/valuation?date=2026-06-01"));
        $this->assertSame('19.08', $past['total']);
    }

    public function test_nuova_revisione_non_altera_snapshot(): void
    {
        $this->base();
        $this->snapshotAndPrice();
        $snapId = $this->ok($this->a->get("/api/recipes/{$this->ids['lasagna']}"))['snapshots'][0]['id'];
        $ragu = $this->ok($this->a->get("/api/recipes/{$this->ids['ragu']}"));
        $rev = $this->raguRevision();
        $rev['components'][0]['quantity'] = '2500';
        $saved = $this->ok($this->a->put("/api/recipes/{$this->ids['ragu']}", ['code' => 'RAGU', 'title' => 'Ragù', 'status' => 'active', 'lockVersion' => $ragu['lockVersion'], 'revision' => $rev]));
        $this->assertSame(2, $saved['revisionNumber']);
        $this->assertSame(['LAS'], array_column($saved['affectedRecipes'], 'code'));
        $stored = $this->ok($this->a->get("/api/snapshots/{$snapId}"));
        $this->assertSame('19.08', $stored['data']['total']);
        $this->assertSame(1, $stored['data']['subrecipeLines'][0]['sub']['revisionNumber']);
        $now = $this->ok($this->a->get("/api/recipes/{$this->ids['lasagna']}"));
        $this->assertSame(2, $now['valuation']['subrecipeLines'][0]['sub']['revisionNumber']);
        $revs = $this->ok($this->a->get("/api/recipes/{$this->ids['ragu']}/revisions"))['data'];
        $this->assertSame([2, 1], array_column($revs, 'number'));
        $r1 = $this->ok($this->a->get("/api/recipes/{$this->ids['ragu']}/revisions/{$revs[1]['id']}"));
        $this->assertSame('2000.0000', $r1['components'][0]['quantity']);
    }

    public function test_salvataggi_concorrenti(): void
    {
        $this->base();
        $ragu = $this->ok($this->a->get("/api/recipes/{$this->ids['ragu']}"));
        $this->ok($this->a->put("/api/recipes/{$this->ids['ragu']}", ['code' => 'RAGU', 'title' => 'Ragù', 'lockVersion' => $ragu['lockVersion'], 'revision' => $this->raguRevision()]));
        $stale = $this->a->put("/api/recipes/{$this->ids['ragu']}", ['code' => 'RAGU', 'title' => 'Ragù', 'lockVersion' => $ragu['lockVersion'], 'revision' => $this->raguRevision()]);
        $this->assertSame(409, $stale->status);
        $this->assertSame('stale', $stale->body['error']['code']);
        $this->assertSame(409, $this->a->post("/api/recipes/{$this->ids['ragu']}/snapshots", ['expectedRevisionId' => $ragu['revision']['id']])->status);
    }

    // --- Editor ricette ---

    public function test_bozza_incompleta(): void
    {
        $r = $this->ok($this->a->post('/api/recipes', ['title' => 'Torta in bozza', 'revision' => ['components' => [['kind' => 'ingredient', 'ingredientId' => $this->ids['sfoglia'], 'quantity' => null, 'unit' => 'g']], 'labor' => [['employeeId' => $this->ids['mario'], 'activeMinutes' => null]]]]));
        $v = $this->ok($this->a->get("/api/recipes/{$r['id']}"))['valuation'];
        $this->assertFalse($v['complete']);
        $codes = array_column($v['issues'], 'code');
        foreach (['invalid_quantity', 'invalid_minutes', 'missing_final_weight'] as $c) {
            $this->assertContains($c, $codes);
        }
        $this->assertNull($v['costPerKg']);
    }

    public function test_ingrediente_al_volo_e_anteprima(): void
    {
        $this->ragu();
        $created = $this->ok($this->a->post('/api/ingredients', ['name' => 'Parmigiano', 'packageContent' => '1', 'packageUnit' => 'kg', 'usageUnit' => 'g', 'initialPrice' => ['packagePrice' => '20', 'validFrom' => '2026-01-01']]));
        $this->assertMatchesRegularExpression('/^ING-\d{5}$/', $created['code']);
        $preview = $this->ok($this->a->post('/api/recipes/preview', ['title' => 'Prova', 'revision' => ['finalWeightKg' => '0.5', 'components' => [['kind' => 'ingredient', 'ingredientId' => $created['id'], 'quantity' => '150', 'unit' => 'g'], ['kind' => 'recipe', 'recipeId' => $this->ids['ragu'], 'quantity' => '500', 'unit' => 'g']]]]));
        $this->assertSame('3', $preview['ingredientLines'][0]['cost']);
        $this->assertSame('Ragù', $preview['subrecipeLines'][0]['name']);
    }

    public function test_duplicazione(): void
    {
        $this->base();
        $this->snapshotAndPrice();
        $dup = $this->ok($this->a->post("/api/recipes/{$this->ids['lasagna']}/duplicate"));
        $copy = $this->ok($this->a->get("/api/recipes/{$dup['id']}"));
        $this->assertSame('Copia di Lasagna', $copy['title']);
        $this->assertSame('draft', $copy['status']);
        $this->assertCount(0, $copy['snapshots']);
        $this->assertCount(2, $copy['revision']['components']);
        $orig = $this->ok($this->a->get("/api/recipes/{$this->ids['lasagna']}"));
        $this->assertGreaterThan(0, count($orig['snapshots']));
        $this->assertSame('LAS', $orig['code']);
    }

    public function test_ingrediente_usato_solo_archiviabile(): void
    {
        $this->base();
        $this->assertSame(409, $this->a->del("/api/ingredients/{$this->ids['sfoglia']}")->status);
        $this->ok($this->a->post("/api/ingredients/{$this->ids['sfoglia']}/archive"));
        $this->assertTrue($this->ok($this->a->get("/api/recipes/{$this->ids['lasagna']}"))['valuation']['complete']);
        $this->ok($this->a->post("/api/ingredients/{$this->ids['sfoglia']}/restore"));
    }

    // --- Prezzi, utenze e strumenti ---

    public function test_prezzo_stessa_data_e_futuro(): void
    {
        $dup = $this->a->post("/api/ingredients/{$this->ids['pomodoro']}/prices", ['packagePrice' => '5', 'validFrom' => '2026-01-01']);
        $this->assertSame(409, $dup->status);
        $this->assertSame('duplicate_price', $dup->body['error']['code']);
        $this->ok($this->a->post("/api/ingredients/{$this->ids['pomodoro']}/prices", ['packagePrice' => '50', 'validFrom' => '2099-01-01']));
        $d = $this->ok($this->a->get("/api/ingredients/{$this->ids['pomodoro']}"));
        $this->assertSame('5.000000', $d['currentPrice']['package_price']);
        $this->assertTrue($d['prices'][0]['future']);
    }

    public function test_unita_incompatibili(): void
    {
        $r = $this->a->post('/api/ingredients', ['name' => 'Olio', 'packageContent' => '1', 'packageUnit' => 'l', 'usageUnit' => 'g']);
        $this->assertSame(422, $r->status);
        $this->assertNotEmpty($r->body['error']['details']['fields']['densityKgPerL'] ?? null);
        $this->ok($this->a->post('/api/ingredients', ['name' => 'Olio', 'packageContent' => '1', 'packageUnit' => 'l', 'usageUnit' => 'g', 'densityKgPerL' => '0.92']));
    }

    public function test_tariffa_da_bolletta(): void
    {
        $body = ['mode' => 'bill', 'validFrom' => '2026-02-01', 'periodFrom' => '2026-01-01', 'periodTo' => '2026-01-31', 'consumption' => '1000', 'consumptionUnit' => 'kwh', 'vatBasis' => 'net', 'components' => [
            ['label' => 'Energia', 'amount' => '250', 'kind' => 'variable', 'include' => true],
            ['label' => 'Quota fissa', 'amount' => '50', 'kind' => 'fixed', 'include' => true],
        ]];
        $p = $this->ok($this->a->post('/api/tariffs/bill-preview', $body));
        $this->assertSame('0.3', $p['pricePerUnit']);
        $this->assertSame('0.25', $p['variableOnlyPricePerUnit']);
        $this->assertTrue($p['includesFixed']);
        $this->assertSame(422, $this->a->post("/api/tariffs/{$this->ids['luce']}/versions", array_merge($body, ['consumptionUnit' => 'm3']))->status);
        $this->ok($this->a->post("/api/tariffs/{$this->ids['luce']}/versions", $body));
        $this->assertCount(2, $this->ok($this->a->get("/api/tariffs/{$this->ids['luce']}"))['versions']);
    }

    public function test_elettricita_solo_kwh(): void
    {
        $this->assertSame(422, $this->a->post('/api/tariffs', ['name' => 'Errata', 'kind' => 'electricity', 'unit' => 'm3'])->status);
    }

    public function test_gas_m3_senza_coefficiente(): void
    {
        $gas = $this->ok($this->a->post('/api/tariffs', ['name' => 'Gas', 'kind' => 'gas', 'unit' => 'smc', 'firstVersion' => ['mode' => 'direct', 'pricePerUnit' => '1.2', 'validFrom' => '2026-01-01']]));
        $eq = $this->ok($this->a->post('/api/equipment', ['name' => 'Piastra', 'powerType' => 'gas', 'gasMode' => 'flow', 'gasFlowPerHour' => '2', 'gasFlowUnit' => 'm3', 'gasTariffId' => $gas['id']]));
        $this->assertMatchesRegularExpression('/coefficiente di conversione/', implode(' ', $eq['warnings']));
        $r = $this->ok($this->a->post('/api/recipes', ['title' => 'Piastrata', 'revision' => ['equipmentUses' => [['equipmentId' => $eq['id'], 'minutes' => '15']]]]));
        $v = $this->ok($this->a->get("/api/recipes/{$r['id']}"))['valuation'];
        $this->assertFalse($v['complete']);
        $this->assertContains('gas_unit_mismatch', array_column($v['issues'], 'code'));
        $ver = $this->ok($this->a->post("/api/tariffs/{$gas['id']}/versions", ['mode' => 'direct', 'pricePerUnit' => '1.2', 'validFrom' => '2026-02-01', 'm3ToSmc' => '1']));
        $this->assertContains($r['id'], array_column($ver['affectedRecipes'], 'id'));
        $v2 = $this->ok($this->a->get("/api/recipes/{$r['id']}"))['valuation'];
        $this->assertTrue($v2['complete']);
        $this->assertSame('0.6', $v2['energy']);
    }

    public function test_dashboard(): void
    {
        $this->base();
        $this->ok($this->a->post('/api/recipes', ['title' => 'Torta in bozza', 'revision' => ['components' => [['kind' => 'ingredient', 'ingredientId' => $this->ids['sfoglia'], 'quantity' => null, 'unit' => 'g']]]]));
        $dash = $this->ok($this->a->get('/api/dashboard'));
        $this->assertSame(2, $dash['counts']['recipes']['active']);
        $this->assertGreaterThanOrEqual(1, $dash['costs']['incompleteCount']);
        $this->assertGreaterThan(0, count($dash['costs']['incomplete'][0]['issues']));
    }
}
