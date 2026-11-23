<?php

namespace Tests\Feature;

use Tests\TestCase;

/** NUOVO — suggerimenti del modulo prodotto: fornitori già usati e agenti con il loro fornitore. */
class IngredientSuggestionsTest extends TestCase
{
    public function test_fornitori_e_agenti_per_azienda(): void
    {
        $c = $this->createCompany('Osteria');
        $this->addMember($c, $this->createUser('a@ost.test', 'A'), 'admin');
        $this->addMember($c, $this->createUser('o@ost.test', 'O'), 'operator');
        $a = $this->loginAs('a@ost.test');
        $mk = fn (string $code, ?string $sup, ?string $agent, string $from = '2026-01-01') => $this->ok($a->post('/api/ingredients', [
            'code' => $code, 'name' => $code, 'category' => 'Carne', 'supplier' => $sup, 'purchaseUnit' => 'pezzo', 'packageContent' => '3.2', 'packageUnit' => 'kg', 'usageUnit' => 'g',
            'initialPrice' => ['packagePrice' => '45', 'validFrom' => $from, 'agentName' => $agent],
        ]));
        $mk('GIR', 'Macelleria Rossi', 'Mario Bianchi');
        $mk('FES', 'Macelleria Rossi', 'Mario Bianchi', '2026-03-01');
        $mk('UOV', 'Cascina Verdi', 'Luca Neri');
        $mk('SAL', null, null);

        $this->assertSame(['Cascina Verdi', 'Macelleria Rossi'], $this->ok($a->get('/api/ingredients/suppliers'))['data']);
        $this->assertSame([
            ['name' => 'Luca Neri', 'supplier' => 'Cascina Verdi', 'lastUsed' => '2026-01-01'],
            ['name' => 'Mario Bianchi', 'supplier' => 'Macelleria Rossi', 'lastUsed' => '2026-03-01'],
        ], $this->ok($a->get('/api/ingredients/agents'))['data']);

        // un'altra azienda non vede nulla
        $x = $this->createCompany('Altra');
        $this->addMember($x, $this->createUser('x@alt.test', 'X'), 'admin');
        $this->assertSame([], $this->ok($this->loginAs('x@alt.test')->get('/api/ingredients/suppliers'))['data']);
    }
}
