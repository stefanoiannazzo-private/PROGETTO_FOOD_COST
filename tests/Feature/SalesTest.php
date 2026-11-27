<?php

namespace Tests\Feature;

use Carbon\Carbon;
use Illuminate\Support\Facades\DB;
use Tests\TestCase;

/** NUOVO — vendite registrate: statistiche e avanzamento settimanale verso il pareggio in Redditività. */
class SalesTest extends TestCase
{
    protected function tearDown(): void
    {
        Carbon::setTestNow();
        parent::tearDown();
    }

    public function test_statistiche_e_pareggio_settimanale(): void
    {
        Carbon::setTestNow('2026-11-25 11:00:00'); // mercoledì
        $company = $this->createCompany('Bar');
        $this->addMember($company, $this->createUser('admin@v.test', 'Admin'), 'admin');
        $this->addMember($company, $this->createUser('cam@v.test', 'Cam'), 'waiter');
        $a = $this->loginAs('admin@v.test');
        $bar = $this->ok($a->post('/api/orders/setup/stations', ['name' => 'Bancone', 'kind' => 'bar']))['id'];
        $sec = $this->ok($a->post('/api/orders/setup/sections', ['name' => 'Bevande', 'stationId' => $bar, 'isDrinks' => true]))['id'];
        $acqua = $this->ok($a->post('/api/ingredients', ['code' => 'ACQ', 'name' => 'Acqua', 'category' => 'Bibite', 'supplier' => 'X', 'purchaseUnit' => 'pezzo', 'packageContent' => '1', 'packageUnit' => 'pz', 'usageUnit' => 'pz', 'initialPrice' => ['packagePrice' => '0.30', 'validFrom' => '2026-01-01']]))['id'];
        $item = $this->ok($a->post('/api/orders/setup/items', ['sectionId' => $sec, 'sourceType' => 'ingredient', 'ingredientId' => $acqua, 'price' => '2.20', 'vatPercent' => '10']))['id'];
        $this->ok($a->post('/api/orders/setup/tables', ['label' => '1', 'seats' => 4]));
        $table = DB::table('dining_tables')->where('company_id', $company)->value('id');
        $this->ok($a->post('/api/profitability/fixed-costs', ['name' => 'Affitto', 'category' => 'rent', 'amount' => '130', 'period' => 'weekly', 'validFrom' => '2026-01-01']));
        $this->ok($a->put('/api/profitability/settings', ['closedWeekdays' => [], 'includeStaff' => false, 'referenceRecipeId' => null]));

        $before = $this->ok($a->get('/api/profitability'))['week'];
        $this->assertSame([false, 130.0, 130.0], [$before['hasSales'], (float) $before['fixedWeekly'], (float) $before['gap']]);

        $cam = $this->loginAs('cam@v.test');
        $s = $this->ok($cam->post('/api/orders/sessions', ['tableIds' => [$table], 'covers' => 4]));
        $this->ok($cam->post("/api/orders/sessions/{$s['id']}/send", ['items' => [['menuItemId' => $item, 'qty' => 10]]]));
        DB::table('order_items')->update(['status' => 'ready', 'created_at' => '2026-11-25 11:00:00', 'sent_at' => '2026-11-25 11:00:00', 'ready_at' => '2026-11-25 11:06:00']);
        $this->ok($cam->post("/api/orders/sessions/{$s['id']}/close"));
        DB::table('table_sessions')->update(['opened_at' => '2026-11-25 11:00:00', 'closed_at' => '2026-11-25 11:50:00']);

        // 10 × (2,20 / 1,10 − 0,30) = 10 × 1,70 = 17 → mancano 113 € (130 − 17)
        $week = $this->ok($a->get('/api/profitability'))['week'];
        $this->assertSame([17.0, 113.0, 10, 4], [(float) $week['contribution'], (float) $week['gap'], $week['dishesSold'], $week['covers']]);

        $st = $this->ok($a->get('/api/sales/stats?from=2026-11-23&to=2026-11-29'));
        $this->assertSame(['22.00', 1, 4, '5.50', 10, '17.00', 50, 6], [
            $st['kpis']['revenue'], $st['kpis']['tables'], $st['kpis']['covers'], $st['kpis']['perCover'], $st['kpis']['dishes'],
            $st['kpis']['margin'], $st['kpis']['avgTableMinutes'], $st['kpis']['avgPrepMinutes'],
        ]);
        $this->assertSame(['Acqua', 10, '22.00', '1.70'], [$st['items'][0]['name'], $st['items'][0]['qty'], $st['items'][0]['revenue'], $st['items'][0]['marginPerDish']]);
        $this->assertSame(10, $st['byHour'][12]['qty'], 'ore 12 italiane');
        $this->assertSame('22.00', $st['byWeekday'][2]['revenue'], 'mercoledì');
        $this->assertSame('Cam', $st['waiters'][0]['name']);

        $this->assertSame(403, $cam->get('/api/sales/stats?from=2026-11-23&to=2026-11-29')->status);
    }
}
