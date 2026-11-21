<?php

namespace Tests\Feature;

use Illuminate\Support\Facades\DB;
use Tests\ApiClient;
use Tests\TestCase;

/**
 * Port di apps/api/test/performance.test.ts: 5.000 ingredienti con prezzi e 300 ricette annidate.
 * I limiti di tempo sono gli stessi dell'originale. Un unico test perché i dati di volume
 * vengono preparati una sola volta (nell'originale: beforeAll condiviso).
 */
class PerformanceTest extends TestCase
{
    /** @var array<string,int> */
    private array $timings = [];

    private function timed(string $label, callable $fn, int $runs = 5): mixed
    {
        $samples = [];
        $result = null;
        for ($i = 0; $i < $runs; $i++) {
            $t0 = hrtime(true);
            $result = $fn();
            $samples[] = (hrtime(true) - $t0) / 1e6;
        }
        sort($samples);
        $this->timings[$label] = (int) round($samples[intdiv(count($samples), 2)]);

        return $result;
    }

    public function test_velocita_con_volumi_realistici(): void
    {
        $c = $this->createCompany('Volumi');
        $this->addMember($c, $this->createUser('perf@example.test', 'Perf'), 'admin');
        $a = $this->loginAs('perf@example.test');
        DB::statement('SET SESSION cte_max_recursion_depth = 10000');
        DB::insert("INSERT INTO ingredients (id, company_id, code, name, category, package_content, package_unit, usage_unit, created_at, updated_at)
            WITH RECURSIVE g(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM g WHERE n < 5000)
            SELECT UUID(), ?, CONCAT('P-', n), CONCAT('Articolo ', n), CONCAT('Categoria ', n % 20), 1 + (n % 10), 'kg', 'g', UTC_TIMESTAMP(3), UTC_TIMESTAMP(3) FROM g", [$c]);
        DB::insert("INSERT INTO ingredient_prices (id, company_id, ingredient_id, package_price, package_content, package_unit, valid_from, created_at)
            SELECT UUID(), company_id, id, ROUND(1 + RAND() * 40, 2), package_content, package_unit, v.d, UTC_TIMESTAMP(3)
            FROM ingredients, (SELECT DATE '2025-01-01' d UNION ALL SELECT DATE '2026-01-01' UNION ALL SELECT DATE '2026-06-01') v WHERE company_id = ?", [$c]);
        $ings = DB::table('ingredients')->where('company_id', $c)->limit(300)->pluck('id')->all();
        $bases = [];
        for ($i = 0; $i < 100; $i++) {
            $bases[] = $this->ok($a->post('/api/recipes', ['code' => "B{$i}", 'title' => "Base {$i}", 'status' => 'active', 'revision' => ['finalWeightKg' => '3', 'components' => array_map(fn ($k) => ['kind' => 'ingredient', 'ingredientId' => $ings[($i * 3 + $k) % count($ings)], 'quantity' => '500', 'unit' => 'g'], [0, 1, 2, 3])]]))['id'];
        }
        for ($i = 0; $i < 200; $i++) {
            $this->ok($a->post('/api/recipes', ['code' => "R{$i}", 'title' => "Piatto {$i}", 'status' => 'active', 'revision' => ['finalWeightKg' => '2', 'portions' => '8', 'components' => [
                ['kind' => 'recipe', 'recipeId' => $bases[$i % 100], 'quantity' => '400', 'unit' => 'g'],
                ['kind' => 'recipe', 'recipeId' => $bases[($i * 7) % 100], 'quantity' => '300', 'unit' => 'g'],
                ['kind' => 'ingredient', 'ingredientId' => $ings[$i % count($ings)], 'quantity' => '200', 'unit' => 'g'],
            ]]]));
        }

        // elenco ingredienti: pagina, ricerca e filtro su 5.000 articoli
        $page = $this->timed('ingredienti_pagina', fn () => $a->get('/api/ingredients?page=40&pageSize=50&sort=name'));
        $this->assertSame(5000, $page->body['meta']['total']);
        $this->timed('ingredienti_ricerca', fn () => $a->get('/api/ingredients?q=articolo%2042&pageSize=25'));
        $this->timed('ingredienti_categoria', fn () => $a->get('/api/ingredients?category=Categoria%207&pageSize=25'));

        // elenco ricette con costi: primo calcolo e poi cache
        $t0 = hrtime(true);
        $a->get('/api/recipes?pageSize=50');
        $this->timings['ricette_primo_calcolo'] = (int) round((hrtime(true) - $t0) / 1e6);
        $list = $this->timed('ricette_da_cache', fn () => $a->get('/api/recipes?pageSize=50&sort=title'));
        $this->assertNotEmpty($list->body['data'][0]['cost']);

        // scheda ricetta annidata e anteprima dall'editor
        $id = $a->get('/api/recipes?q=piatto%2017&pageSize=1')->body['data'][0]['id'];
        $detail = $this->timed('scheda_ricetta', fn () => $a->get("/api/recipes/{$id}"));
        $comps = array_map(fn ($x) => ['kind' => $x['kind'], 'ingredientId' => $x['ingredientId'] ?? null, 'recipeId' => $x['recipeId'] ?? null, 'quantity' => $x['quantity'], 'unit' => $x['unit']], $detail->body['revision']['components']);
        $prev = $this->timed('anteprima_editor', fn () => $a->post('/api/recipes/preview', ['recipeId' => $id, 'revision' => ['finalWeightKg' => '2', 'components' => $comps]]));
        $this->assertSame(200, $prev->status, json_encode($prev->body));

        // nuovo prezzo: invalida solo le ricette interessate
        $ing = $a->get('/api/ingredients?q=articolo%205&pageSize=1&sort=code');
        $r = $this->timed('nuovo_prezzo_e_propagazione', fn () => $a->post("/api/ingredients/{$ing->body['data'][0]['id']}/prices", ['packagePrice' => (string) (10 + mt_rand() / mt_getrandmax()), 'validFrom' => '2026-0'.random_int(1, 9).'-1'.random_int(0, 8)]), 1);
        $this->assertSame(200, $r->status, json_encode($r->body));
        $t0 = hrtime(true);
        $a->get('/api/dashboard');
        $this->timings['dashboard_dopo_modifica'] = (int) round((hrtime(true) - $t0) / 1e6);

        fwrite(STDERR, "\nTempi mediani (ms): ".json_encode($this->timings)."\n");
        $this->assertLessThan(400, $this->timings['ingredienti_pagina']);
        $this->assertLessThan(400, $this->timings['ingredienti_ricerca']);
        $this->assertLessThan(400, $this->timings['ricette_da_cache']);
        $this->assertLessThan(400, $this->timings['scheda_ricetta']);
        $this->assertLessThan(400, $this->timings['anteprima_editor']);
        $this->assertLessThan(1500, $this->timings['dashboard_dopo_modifica']);
    }
}
