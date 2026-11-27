<?php

namespace Tests\Feature;

use Illuminate\Support\Facades\DB;
use Tests\TestCase;

/** NUOVO — area Ordini: configurazione di postazioni, menu, sale e tavoli; ruoli cameriere e cucina. */
class OrderSetupTest extends TestCase
{
    private string $company;

    protected function setUp(): void
    {
        parent::setUp();
        $this->company = $this->createCompany('Trattoria');
        $this->addMember($this->company, $this->createUser('admin@o.test', 'Admin'), 'admin');
        $this->addMember($this->company, $this->createUser('cam@o.test', 'Cameriere'), 'waiter');
        $this->addMember($this->company, $this->createUser('cuoco@o.test', 'Cuoco'), 'kitchen');
    }

    public function test_solo_chi_configura_vede_la_configurazione(): void
    {
        $this->assertSame(403, $this->loginAs('cam@o.test')->get('/api/orders/setup')->status);
        $this->assertSame(403, $this->loginAs('cuoco@o.test')->post('/api/orders/setup/stations', ['name' => 'X'])->status);
        $r = $this->ok($this->loginAs('admin@o.test')->get('/api/orders/setup'));
        $this->assertSame([], $r['sections']);
        $this->assertStringContainsString('/menu/', $r['settings']['publicUrl']);
        // i nuovi ruoli non vedono costi né ricette da modificare
        $cam = $this->ok($this->loginAs('cam@o.test')->get('/api/auth/me'));
        $this->assertSame(['orders.take'], $cam['permissions']);
        $this->assertSame(['orders.kitchen', 'recipes.read'], $this->ok($this->loginAs('cuoco@o.test')->get('/api/auth/me'))['permissions']);
    }

    public function test_menu_da_ricette_e_prodotti_pronti(): void
    {
        $a = $this->loginAs('admin@o.test');
        $kitchen = $this->ok($a->post('/api/orders/setup/stations', ['name' => 'Cucina', 'kind' => 'kitchen']))['id'];
        $bar = $this->ok($a->post('/api/orders/setup/stations', ['name' => 'Bancone', 'kind' => 'bar']))['id'];
        $pizze = $this->ok($a->post('/api/orders/setup/sections', ['name' => 'Pizze', 'stationId' => $kitchen]))['id'];
        $bevande = $this->ok($a->post('/api/orders/setup/sections', ['name' => 'Bevande', 'stationId' => $bar, 'isDrinks' => true]))['id'];

        $recipe = $this->ok($a->post('/api/recipes', ['title' => 'Margherita', 'status' => 'active', 'revision' => ['components' => []]]))['id'];
        $coca = $this->ok($a->post('/api/ingredients', ['code' => 'COCA', 'name' => 'Coca-Cola 33cl', 'category' => 'Bibite', 'supplier' => 'Bevande srl', 'purchaseUnit' => 'pezzo', 'packageContent' => '1', 'packageUnit' => 'pz', 'usageUnit' => 'pz', 'initialPrice' => ['packagePrice' => '0.80', 'validFrom' => '2026-01-01']]))['id'];

        $src = $this->ok($a->get('/api/orders/setup/sources?q=marg'));
        $this->assertSame('Margherita', $src['recipes'][0]['name']);

        $m = $this->ok($a->post('/api/orders/setup/items', ['sectionId' => $pizze, 'sourceType' => 'recipe', 'recipeId' => $recipe, 'price' => '7,50']))['id'];
        $this->ok($a->post('/api/orders/setup/items', ['sectionId' => $bevande, 'sourceType' => 'ingredient', 'ingredientId' => $coca, 'name' => 'Coca-Cola', 'price' => '3']));
        // il prezzo della ricetta è lo stesso della Redditività
        $this->assertSame('7.50', DB::table('recipe_prices')->where('recipe_id', $recipe)->value('menu_price'));
        // niente voci libere: serve una ricetta o un prodotto dell'azienda
        $this->assertSame(422, $a->post('/api/orders/setup/items', ['sectionId' => $pizze, 'sourceType' => 'recipe', 'price' => '5'])->status);
        $other = $this->createCompany('Altro');
        $alien = DB::table('ingredients')->insertGetId(['id' => $x = (string) \Illuminate\Support\Str::uuid()] + $this->fakeIngredient($other)) ?: $x;
        $this->assertSame(422, $a->post('/api/orders/setup/items', ['sectionId' => $pizze, 'sourceType' => 'ingredient', 'ingredientId' => $x, 'price' => '5'])->status);

        $r = $this->ok($a->get('/api/orders/setup'));
        $coke = collect($r['items'])->firstWhere('name', 'Coca-Cola');
        $this->assertSame(['1', 'pz', '0.8'], [$coke['portionQty'], $coke['portionUnit'], rtrim(rtrim((string) $coke['unitCost'], '0'), '.')]);

        // esaurito: lo segna anche la cucina
        $this->ok($this->loginAs('cuoco@o.test')->patch("/api/orders/setup/items/{$m}/availability", ['isAvailable' => false]));
        $this->assertSame(0, (int) DB::table('menu_items')->where('id', $m)->value('is_available'));
        $this->assertSame(403, $this->loginAs('cam@o.test')->patch("/api/orders/setup/items/{$m}/availability", ['isAvailable' => true])->status);

        // una sezione con piatti non si elimina
        $this->assertSame(409, $a->del("/api/orders/setup/sections/{$pizze}")->status);
    }

    public function test_sala_con_nome_doppio_rifiutata(): void
    {
        $a = $this->loginAs('admin@o.test');
        $s1 = $this->ok($a->post('/api/orders/setup/areas', ['name' => 'Sala 1']))['id'];
        $dup = $a->post('/api/orders/setup/areas', ['name' => ' sala 1 ']);
        $this->assertSame(422, $dup->status);
        $this->assertSame('Esiste già una sala con questo nome.', $dup->body['error']['details']['fields']['name']);
        $s2 = $this->ok($a->post('/api/orders/setup/areas', ['name' => 'Dehors']))['id'];
        $this->assertSame(422, $a->put("/api/orders/setup/areas/{$s2}", ['name' => 'SALA 1'])->status);
        $this->ok($a->put("/api/orders/setup/areas/{$s1}", ['name' => 'Sala 1'])); // stesso nome sulla stessa sala: ok
        $this->assertSame(1, DB::table('dining_areas')->where('name', 'Sala 1')->count());
    }

    public function test_tavoli_singoli_e_a_intervallo(): void
    {
        $a = $this->loginAs('admin@o.test');
        $sala = $this->ok($a->post('/api/orders/setup/areas', ['name' => 'Sala interna']))['id'];
        $this->assertCount(10, $this->ok($a->post('/api/orders/setup/tables', ['from' => 1, 'to' => 10, 'seats' => 4, 'areaId' => $sala]))['ids']);
        $this->ok($a->post('/api/orders/setup/tables', ['label' => '12B', 'seats' => 2]));
        $dup = $a->post('/api/orders/setup/tables', ['from' => 9, 'to' => 11, 'seats' => 4]);
        $this->assertSame(422, $dup->status);
        $this->assertStringContainsString('9, 10', $dup->body['error']['message']);
        $tables = $this->ok($a->get('/api/orders/setup'))['tables'];
        $this->assertSame(['1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '12B'], array_column($tables, 'label'));
        $this->assertStringContainsString('/menu/t/', $tables[0]['qrUrl']);
    }

    public function test_impostazioni_menu_digitale(): void
    {
        $a = $this->loginAs('admin@o.test');
        $bad = $a->put('/api/orders/setup/settings', ['publicMode' => 'optional', 'coverCharge' => '2']);
        $this->assertSame(422, $bad->status);
        $this->ok($a->put('/api/orders/setup/settings', ['publicMode' => 'optional', 'giftText' => 'Caffè offerto', 'coverCharge' => '2']));
        $s = $this->ok($a->get('/api/orders/setup'))['settings'];
        $this->assertSame(['optional', 'Caffè offerto', false], [$s['publicMode'], $s['giftText'], $s['guestOrdering']]);
    }

    private function fakeIngredient(string $company): array
    {
        return ['company_id' => $company, 'code' => 'X1', 'name' => 'Alieno', 'category' => 'X', 'supplier' => 'X', 'package_content' => 1, 'package_unit' => 'pz', 'usage_unit' => 'pz', 'purchase_unit' => 'pezzo', 'edible_yield' => 1, 'created_at' => now(), 'updated_at' => now()];
    }
}
