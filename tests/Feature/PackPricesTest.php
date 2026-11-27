<?php

namespace Tests\Feature;

use Tests\TestCase;

/** NUOVO — confezione corretta dopo l'inserimento (cartone da 24 bottiglie registrato «per 1 pz»): i prezzi si allineano. */
class PackPricesTest extends TestCase
{
    private function setUpWater(): array
    {
        $c = $this->createCompany('Bar');
        $this->addMember($c, $this->createUser('a@bar.test', 'A'), 'admin');
        $a = $this->loginAs('a@bar.test');
        $id = $this->ok($a->post('/api/ingredients', [
            'code' => 'ACQ', 'name' => 'Acqua Ferrarelle 50cl', 'category' => 'Bevande', 'supplier' => 'Cicogna', 'purchaseUnit' => 'confezione',
            'packageContent' => '1', 'packageUnit' => 'pz', 'usageUnit' => 'pz', 'unitWeightKg' => '0.5', 'densityKgPerL' => '1',
            'initialPrice' => ['packagePrice' => '12.06', 'validFrom' => '2026-11-23'],
        ]))['id'];

        return [$a, $id];
    }

    private function body(array $d, array $extra = []): array
    {
        return [...[
            'code' => $d['code'], 'name' => $d['name'], 'category' => $d['category'], 'supplier' => $d['supplier'], 'purchaseUnit' => $d['purchaseUnit'],
            'packageContent' => '24', 'packageUnit' => 'pz', 'usageUnit' => 'pz', 'edibleYieldPercent' => $d['edibleYieldPercent'],
            'densityKgPerL' => $d['densityKgPerL'], 'unitWeightKg' => $d['unitWeightKg'], 'lockVersion' => $d['lockVersion'],
        ], ...$extra];
    }

    public function test_correzione_insieme_alla_confezione(): void
    {
        [$a, $id] = $this->setUpWater();
        $d = $this->ok($a->get("/api/ingredients/{$id}"));
        $this->assertSame(12.06, (float) $d['currentPrice']['unitPrice']);
        $r = $this->ok($a->patch("/api/ingredients/{$id}", $this->body($d, ['updatePrices' => true])));
        $this->assertSame(1, $r['repricedPrices']);
        $d = $this->ok($a->get("/api/ingredients/{$id}"));
        $this->assertEqualsWithDelta(0.5025, (float) $d['currentPrice']['unitPrice'], 0.0001);
        $this->assertSame(12.06, (float) $d['currentPrice']['package_price']);
    }

    public function test_allineamento_dopo_il_salvataggio(): void
    {
        [$a, $id] = $this->setUpWater();
        $d = $this->ok($a->get("/api/ingredients/{$id}"));
        $this->assertSame(0, $this->ok($a->patch("/api/ingredients/{$id}", $this->body($d)))['repricedPrices']);
        $this->assertSame(12.06, (float) $this->ok($a->get("/api/ingredients/{$id}"))['currentPrice']['unitPrice']);
        $this->assertSame(1, $this->ok($a->post("/api/ingredients/{$id}/prices/align", ['fromContent' => '1', 'fromUnit' => 'pz']))['updated']);
        $this->assertEqualsWithDelta(0.5025, (float) $this->ok($a->get("/api/ingredients/{$id}"))['currentPrice']['unitPrice'], 0.0001);
        // unità di un'altra grandezza: rifiutata
        $this->assertSame(422, $a->post("/api/ingredients/{$id}/prices/align", ['fromContent' => '1', 'fromUnit' => 'kg'])->status);
    }
}
