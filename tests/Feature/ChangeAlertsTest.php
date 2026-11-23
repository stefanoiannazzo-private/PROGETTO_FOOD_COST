<?php

namespace Tests\Feature;

use Illuminate\Support\Facades\DB;
use Tests\ApiClient;
use Tests\TestCase;

/** NUOVO — Avvisi di variazione: prezzi, semilavorati, utenze; spariscono quando l'utente apre la scheda. */
class ChangeAlertsTest extends TestCase
{
    private ApiClient $a;

    private ApiClient $b;

    private string $farina;

    private string $impasto;

    private string $pizza;

    protected function setUp(): void
    {
        parent::setUp();
        $c = $this->createCompany('Pizzeria Avvisi');
        $this->addMember($c, $this->createUser('a@avv.test', 'Anna'), 'admin');
        $this->addMember($c, $this->createUser('b@avv.test', 'Bruno'), 'admin');
        $this->addMember($c, $this->createUser('o@avv.test', 'Op'), 'operator');
        $this->a = $this->loginAs('a@avv.test');
        $this->b = $this->loginAs('b@avv.test');
        $this->farina = $this->ok($this->a->post('/api/ingredients', [
            'name' => 'Farina 00', 'category' => 'Farine', 'supplier' => 'Molino', 'purchaseUnit' => 'kg', 'packageContent' => '1', 'packageUnit' => 'kg', 'usageUnit' => 'g',
            'initialPrice' => ['packagePrice' => '1.00', 'validFrom' => '2026-01-01'],
        ]))['id'];
        $this->impasto = $this->ok($this->a->post('/api/recipes', ['title' => 'Impasto', 'revision' => ['portions' => '1', 'finalWeightKg' => '1', 'components' => [['kind' => 'ingredient', 'ingredientId' => $this->farina, 'quantity' => '1', 'unit' => 'kg']]]]))['id'];
        $this->pizza = $this->ok($this->a->post('/api/recipes', ['title' => 'Pizza', 'revision' => ['portions' => '4', 'components' => [['kind' => 'recipe', 'recipeId' => $this->impasto, 'quantity' => '1', 'unit' => 'kg']]]]))['id'];
    }

    public function test_nuovo_prezzo_segnala_prodotto_e_ricette_anche_indirette(): void
    {
        $this->assertSame([], $this->ok($this->b->get('/api/alerts'))['recipes']);
        $this->ok($this->a->post("/api/ingredients/{$this->farina}/prices", ['packagePrice' => '1.20', 'validFrom' => '2026-02-01', 'source' => 'Listino Molino']));

        $u = $this->ok($this->b->get('/api/alerts'));
        $this->assertEqualsCanonicalizing([$this->impasto, $this->pizza], array_column($u['recipes'], 'id'));
        $this->assertSame([$this->farina], array_column($u['ingredients'], 'id'));

        $r = $this->ok($this->b->get("/api/recipes/{$this->pizza}"));
        $ch = $r['changes'][0];
        $this->assertStringContainsString('Prezzo di Farina 00: 1,00 → 1,20 € al kg (+20,0%)', $ch['lines'][0]);
        $this->assertSame('Listino Molino', $ch['source']);
        $this->assertSame('1', rtrim(rtrim($ch['before'], '0'), '.'));
        $this->assertSame('1.2', rtrim(rtrim($ch['after'], '0'), '.'));
        $this->assertSame('0.3', rtrim(rtrim($ch['afterPortion'], '0'), '.'));
        $this->assertSame('Anna', $ch['createdBy']);
        $ing = $this->ok($this->b->get("/api/ingredients/{$this->farina}"));
        $this->assertStringContainsString('Prezzo: 1,00 → 1,20 €', $ing['changes'][0]['lines'][0]);

        // aprire la scheda la segna come vista solo per quell'utente
        $this->ok($this->b->post('/api/alerts/seen', ['type' => 'recipe', 'id' => $this->pizza]));
        $this->assertSame([$this->impasto], array_column($this->ok($this->b->get('/api/alerts'))['recipes'], 'id'));
        $this->assertSame([], $this->ok($this->b->get("/api/recipes/{$this->pizza}"))['changes']);
        // chi ha inserito il prezzo dalla scheda prodotto non riceve l'avviso sul prodotto, ma sulle ricette sì
        $ua = $this->ok($this->a->get('/api/alerts'));
        $this->assertSame([], $ua['ingredients']);
        $this->assertCount(2, $ua['recipes']);
        // segna tutte
        $this->assertSame(2, $this->ok($this->a->post('/api/alerts/seen', ['type' => 'recipe']))['count']);
        $this->assertSame([], $this->ok($this->a->get('/api/alerts'))['recipes']);

        // una nuova variazione dopo la visita torna a segnalare
        $this->ok($this->a->post("/api/ingredients/{$this->farina}/prices", ['packagePrice' => '1.10', 'validFrom' => '2026-03-01']));
        $this->assertCount(2, $this->ok($this->a->get('/api/alerts'))['recipes']);
        $this->assertStringContainsString('(−8,3%)', $this->ok($this->b->get("/api/recipes/{$this->pizza}"))['changes'][0]['lines'][0]);
    }

    public function test_prezzo_futuro_non_segnala_le_ricette_e_operatore_senza_costi_non_vede(): void
    {
        $this->ok($this->a->post("/api/ingredients/{$this->farina}/prices", ['packagePrice' => '5.00', 'validFrom' => '2099-01-01']));
        $this->assertSame([], $this->ok($this->b->get('/api/alerts'))['recipes']);
        $this->assertSame([], $this->ok($this->b->get('/api/alerts'))['ingredients']);

        $this->ok($this->a->post("/api/ingredients/{$this->farina}/prices", ['packagePrice' => '2.00', 'validFrom' => '2026-05-01']));
        $op = $this->loginAs('o@avv.test');
        $this->assertSame(['recipes' => [], 'ingredients' => []], $this->ok($op->get('/api/alerts')));
        $this->assertSame([], $this->ok($op->get("/api/recipes/{$this->pizza}"))['changes']);
    }

    public function test_semilavorato_modificato_segnala_solo_chi_lo_usa(): void
    {
        $rev = $this->ok($this->a->get("/api/recipes/{$this->impasto}"));
        $this->ok($this->a->request('PUT', "/api/recipes/{$this->impasto}", [
            'code' => $rev['code'], 'title' => 'Impasto', 'lockVersion' => $rev['lockVersion'],
            'revision' => ['portions' => '1', 'finalWeightKg' => '1', 'components' => [['kind' => 'ingredient', 'ingredientId' => $this->farina, 'quantity' => '2', 'unit' => 'kg']]],
        ]));
        $u = $this->ok($this->b->get('/api/alerts'));
        $this->assertSame([$this->pizza], array_column($u['recipes'], 'id'));
        $this->assertSame('Semilavorato «Impasto» modificato', $this->ok($this->b->get("/api/recipes/{$this->pizza}"))['changes'][0]['lines'][0]);
    }

    public function test_utenza_cambiata_segnala_le_ricette_con_strumenti(): void
    {
        $luce = $this->ok($this->a->post('/api/tariffs', ['name' => 'Luce', 'kind' => 'electricity', 'unit' => 'kwh']))['id'];
        $this->ok($this->a->post("/api/tariffs/{$luce}/versions", ['mode' => 'direct', 'pricePerUnit' => '0.30', 'validFrom' => '2026-01-01']));
        $forno = $this->ok($this->a->post('/api/equipment', ['name' => 'Forno', 'powerType' => 'electric', 'electricPowerKw' => '10', 'usageCoefficient' => '0.5', 'electricTariffId' => $luce]))['id'];
        $rev = $this->ok($this->a->get("/api/recipes/{$this->pizza}"));
        $this->ok($this->a->request('PUT', "/api/recipes/{$this->pizza}", [
            'code' => $rev['code'], 'title' => 'Pizza', 'lockVersion' => $rev['lockVersion'],
            'revision' => ['portions' => '4', 'components' => [['kind' => 'recipe', 'recipeId' => $this->impasto, 'quantity' => '1', 'unit' => 'kg']],
                'equipmentUses' => [['equipmentId' => $forno, 'segment' => 'work', 'minutes' => '60']]],
        ]));
        $this->ok($this->b->post('/api/alerts/seen', ['type' => 'recipe']));
        $this->ok($this->a->post("/api/tariffs/{$luce}/versions", ['mode' => 'direct', 'pricePerUnit' => '0.33', 'validFrom' => '2026-06-01']));
        $u = $this->ok($this->b->get('/api/alerts'));
        $this->assertSame([$this->pizza], array_column($u['recipes'], 'id'));
        $this->assertStringContainsString('Utenza Luce: 0,3000 → 0,3300 €/kWh (+10,0%)', $this->ok($this->b->get("/api/recipes/{$this->pizza}"))['changes'][0]['lines'][0]);
        $this->assertGreaterThan(0, DB::table('change_alerts')->count());
    }
}
