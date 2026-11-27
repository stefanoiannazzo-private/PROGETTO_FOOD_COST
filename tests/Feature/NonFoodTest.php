<?php

namespace Tests\Feature;

use Tests\TestCase;

/** NUOVO — prodotti non alimentari: niente peso del pezzo per la loro categoria, eccezione sul singolo prodotto. */
class NonFoodTest extends TestCase
{
    public function test_categoria_e_eccezione(): void
    {
        $c = $this->createCompany('Pizzeria');
        $this->addMember($c, $this->createUser('a@pz.test', 'A'), 'admin');
        $a = $this->loginAs('a@pz.test');
        $mk = fn (string $code, string $cat) => $this->ok($a->post('/api/ingredients', [
            'code' => $code, 'name' => $code, 'category' => $cat, 'supplier' => 'X', 'purchaseUnit' => 'confezione',
            'packageContent' => '1', 'packageUnit' => 'pz', 'usageUnit' => 'pz',
        ]))['id'];
        $box = $mk('BOX', 'Materiale di consumo');       // riconosciuta dal nome
        $legna = $mk('LEGNA', 'Bancali');                 // non riconosciuta: la segnerà il titolare
        $mozz = $mk('MOZZ', 'Latticini');

        $list = fn () => collect($this->ok($a->get('/api/ingredients?pageSize=50'))['data'])->keyBy('code');
        $this->assertFalse($list()['BOX']['needsWeight']);
        $this->assertTrue($list()['BOX']['nonFood']);
        $this->assertTrue($list()['LEGNA']['needsWeight']);
        $this->assertSame(2, $this->ok($a->get('/api/ingredients'))['meta']['missingWeight']);

        $cats = collect($this->ok($a->get('/api/ingredients/category-settings'))['data'])->keyBy('name');
        $this->assertTrue($cats['Materiale di consumo']['nonFood']);
        $this->assertTrue($cats['Materiale di consumo']['auto']);
        $this->assertFalse($cats['Bancali']['nonFood']);

        $this->ok($a->put('/api/ingredients/category-settings', ['name' => 'Bancali', 'nonFood' => true]));
        $this->assertFalse($list()['LEGNA']['needsWeight']);
        $missing = $this->ok($a->get('/api/ingredients?weight=missing'));
        $this->assertSame(['MOZZ'], array_column($missing['data'], 'code'));
        $this->assertSame(1, $missing['meta']['missingWeight']);

        // eccezione sul singolo prodotto
        $d = $this->ok($a->get("/api/ingredients/{$mozz}"));
        $this->assertNull($d['nonFoodOverride']);
        $this->ok($a->patch("/api/ingredients/{$mozz}", [
            'code' => 'MOZZ', 'name' => 'MOZZ', 'category' => 'Latticini', 'supplier' => 'X', 'purchaseUnit' => 'confezione', 'packageContent' => '1', 'packageUnit' => 'pz',
            'usageUnit' => 'pz', 'lockVersion' => $d['lockVersion'], 'nonFood' => true,
        ]));
        $this->assertTrue($this->ok($a->get("/api/ingredients/{$mozz}"))['nonFoodOverride']);
        $this->assertSame(0, $this->ok($a->get('/api/ingredients'))['meta']['missingWeight']);

        // la categoria tolta torna alimentare anche se il nome la farebbe riconoscere
        $this->ok($a->put('/api/ingredients/category-settings', ['name' => 'Materiale di consumo', 'nonFood' => false]));
        $this->assertTrue($list()['BOX']['needsWeight']);
        // l'operatore non può cambiare le categorie
        $this->addMember($c, $this->createUser('o@pz.test', 'O'), 'operator');
        $this->assertSame(403, $this->loginAs('o@pz.test')->put('/api/ingredients/category-settings', ['name' => 'Bancali', 'nonFood' => false])->status);
    }
}
