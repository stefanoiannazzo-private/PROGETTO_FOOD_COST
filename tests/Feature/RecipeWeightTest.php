<?php

namespace Tests\Feature;

use Tests\TestCase;

/** NUOVO — Peso totale degli ingredienti: calcolato e usato come peso finale quando quello dopo cottura non è indicato. */
class RecipeWeightTest extends TestCase
{
    public function test_peso_dagli_ingredienti_e_peso_dopo_cottura(): void
    {
        $c = $this->createCompany('Forno Pesi');
        $this->addMember($c, $this->createUser('a@pesi.test', 'A'), 'admin');
        $a = $this->loginAs('a@pesi.test');
        $ing = fn (string $name, array $extra = []) => $this->ok($a->post('/api/ingredients', [
            'name' => $name, 'category' => 'Base', 'supplier' => 'Forn', 'purchaseUnit' => 'kg', 'packageContent' => '1', 'packageUnit' => 'kg', 'usageUnit' => 'g',
            'initialPrice' => ['packagePrice' => '2.00', 'validFrom' => '2026-01-01'], ...$extra,
        ]))['id'];
        $farina = $ing('Farina');
        $zucchero = $ing('Zucchero');
        $uova = $ing('Uova', ['purchaseUnit' => 'confezione', 'packageContent' => '30', 'packageUnit' => 'pz', 'usageUnit' => 'pz']);

        $rev = ['portions' => '6', 'components' => [
            ['kind' => 'ingredient', 'ingredientId' => $farina, 'quantity' => '1', 'unit' => 'kg'],
            ['kind' => 'ingredient', 'ingredientId' => $zucchero, 'quantity' => '200', 'unit' => 'g'],
        ]];
        $p = $this->ok($a->post('/api/recipes/preview', ['title' => 'Frolla', 'revision' => $rev]));
        $this->assertSame('1.2', $p['ingredientsWeightKg']);
        $this->assertSame('1.2', $p['finalWeightKg']);
        $this->assertSame('ingredients', $p['finalWeightSource']);
        $this->assertSame('2', $p['costPerKg']); // 2,40 € / 1,2 kg
        $this->assertNotContains('missing_final_weight', array_column($p['issues'], 'code'));
        $this->assertNotContains('missing_yield', array_column($p['issues'], 'code'));

        // peso dopo cottura indicato: prevale
        $p = $this->ok($a->post('/api/recipes/preview', ['title' => 'Frolla', 'revision' => [...$rev, 'finalWeightKg' => '1']]));
        $this->assertSame(['1', 'declared', '1.2'], [$p['finalWeightKg'], $p['finalWeightSource'], $p['ingredientsWeightKg']]);

        // uova a pezzi senza peso al pezzo: peso non calcolabile, si dice quale manca
        $p = $this->ok($a->post('/api/recipes/preview', ['title' => 'Frolla', 'revision' => [...$rev, 'components' => [...$rev['components'], ['kind' => 'ingredient', 'ingredientId' => $uova, 'quantity' => '3', 'unit' => 'pz']]]]));
        $this->assertNull($p['finalWeightKg']);
        $this->assertSame(['Uova'], $p['ingredientsWeightMissing']);
        $miss = array_values(array_filter($p['issues'], fn ($i) => $i['code'] === 'missing_final_weight'))[0];
        $this->assertStringContainsString('manca il peso di Uova', $miss['message']);

        // un semilavorato senza peso dichiarato si può dosare a peso grazie al peso degli ingredienti
        $frolla = $this->ok($a->post('/api/recipes', ['title' => 'Frolla', 'revision' => $rev]))['id'];
        $p = $this->ok($a->post('/api/recipes/preview', ['title' => 'Crostata', 'revision' => ['components' => [['kind' => 'recipe', 'recipeId' => $frolla, 'quantity' => '600', 'unit' => 'g']]]]));
        $this->assertTrue($p['complete']);
        $this->assertSame('1.2', rtrim(rtrim($p['subrecipeLines'][0]['cost'], '0'), '.')); // 0,6 kg × 2 €/kg
        $this->assertSame('0.6', $p['ingredientsWeightKg']);
    }
}
