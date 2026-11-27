<?php

namespace Tests\Feature;

use Illuminate\Support\Facades\DB;
use Tests\TestCase;

/** NUOVO — area Ordini: tavoli, comande con portate e VIA, cucina e bancone, unione tavoli, chiusura, PIN e tablet di servizio. */
class OrderServiceTest extends TestCase
{
    private string $company;

    private array $ids = [];

    protected function setUp(): void
    {
        parent::setUp();
        $this->company = $this->createCompany('Trattoria');
        $this->addMember($this->company, $this->createUser('admin@s.test', 'Anna Admin'), 'admin');
        $this->addMember($this->company, $this->createUser('cam@s.test', 'Marco Cameriere'), 'waiter');
        $this->addMember($this->company, $this->createUser('cuoco@s.test', 'Carla Cuoca'), 'kitchen');
        $this->createUser('super@s.test', 'Super', true);
        $a = $this->loginAs('admin@s.test');
        $k = $this->ok($a->post('/api/orders/setup/stations', ['name' => 'Cucina']))['id'];
        $b = $this->ok($a->post('/api/orders/setup/stations', ['name' => 'Bancone', 'kind' => 'bar']))['id'];
        $primi = $this->ok($a->post('/api/orders/setup/sections', ['name' => 'Primi', 'stationId' => $k]))['id'];
        $secondi = $this->ok($a->post('/api/orders/setup/sections', ['name' => 'Secondi', 'stationId' => $k]))['id'];
        $bev = $this->ok($a->post('/api/orders/setup/sections', ['name' => 'Bevande', 'stationId' => $b, 'isDrinks' => true]))['id'];
        $r1 = $this->ok($a->post('/api/recipes', ['title' => 'Carbonara', 'status' => 'active', 'revision' => ['components' => []]]))['id'];
        $r2 = $this->ok($a->post('/api/recipes', ['title' => 'Tagliata', 'status' => 'active', 'revision' => ['components' => []]]))['id'];
        $acqua = $this->ok($a->post('/api/ingredients', ['code' => 'ACQ', 'name' => 'Acqua 75cl', 'category' => 'Bibite', 'supplier' => 'X', 'purchaseUnit' => 'pezzo', 'packageContent' => '1', 'packageUnit' => 'pz', 'usageUnit' => 'pz', 'initialPrice' => ['packagePrice' => '0.30', 'validFrom' => '2026-01-01']]))['id'];
        $this->ids = [
            'carbonara' => $this->ok($a->post('/api/orders/setup/items', ['sectionId' => $primi, 'sourceType' => 'recipe', 'recipeId' => $r1, 'price' => '12']))['id'],
            'tagliata' => $this->ok($a->post('/api/orders/setup/items', ['sectionId' => $secondi, 'sourceType' => 'recipe', 'recipeId' => $r2, 'price' => '18']))['id'],
            'acqua' => $this->ok($a->post('/api/orders/setup/items', ['sectionId' => $bev, 'sourceType' => 'ingredient', 'ingredientId' => $acqua, 'price' => '2.50']))['id'],
            'kitchen' => $k, 'bar' => $b,
        ];
        $this->ok($a->post('/api/orders/setup/tables', ['from' => 1, 'to' => 8, 'seats' => 4]));
        $this->ok($a->put('/api/orders/setup/settings', ['publicMode' => 'open', 'coverCharge' => '2']));
        foreach (DB::table('dining_tables')->where('company_id', $this->company)->get() as $t) {
            $this->ids['t'.$t->label] = $t->id;
        }
    }

    public function test_servizio_completo_con_vie_e_postazioni(): void
    {
        $cam = $this->loginAs('cam@s.test');
        $this->assertSame(403, $cam->get('/api/orders/kitchen')->status);
        $s = $this->ok($cam->post('/api/orders/sessions', ['tableIds' => [$this->ids['t3']], 'covers' => 2]));
        $this->assertSame(409, $this->loginAs('admin@s.test')->post('/api/orders/sessions', ['tableIds' => [$this->ids['t3']], 'covers' => 4])->status, 'stesso tavolo aperto due volte');

        $s = $this->ok($cam->post("/api/orders/sessions/{$s['id']}/send", ['items' => [
            ['menuItemId' => $this->ids['carbonara'], 'qty' => 2, 'course' => 1, 'notes' => 'una senza pepe'],
            ['menuItemId' => $this->ids['tagliata'], 'qty' => 2, 'course' => 2],
            ['menuItemId' => $this->ids['acqua'], 'qty' => 1, 'course' => 2], // bevanda: parte subito comunque
        ]]));
        $this->assertSame(2, $s['heldCourse']);
        $this->assertEquals(['carbonara' => 'sent', 'tagliata' => 'held', 'acqua' => 'sent'], $this->statuses($s));

        $kitchen = $this->loginAs('cuoco@s.test');
        $k = $this->ok($kitchen->get("/api/orders/kitchen?stations={$this->ids['kitchen']}"));
        $this->assertSame([['3', 1, 'new'], ['3', 2, 'held']], array_map(fn ($t) => [$t['table'], $t['course'], $t['status']], $k['tickets']));
        $this->assertSame('una senza pepe', $k['tickets'][0]['items'][0]['notes']);
        $bar = $this->ok($kitchen->get("/api/orders/kitchen?stations={$this->ids['bar']}"));
        $this->assertSame([[0, 'Acqua 75cl']], array_map(fn ($t) => [$t['course'], $t['items'][0]['name']], $bar['tickets']));

        // la cucina prepara e segna pronto: in sala si vede
        $first = array_column($k['tickets'][0]['items'], 'id');
        $this->ok($kitchen->post('/api/orders/kitchen/status', ['ids' => $first, 'status' => 'ready']));
        $floor = $this->ok($cam->get('/api/orders/floor'));
        $this->assertSame(1, $floor['sessions'][0]['ready']);
        $this->ok($cam->post("/api/orders/sessions/{$s['id']}/served"));

        // VIA della seconda portata
        $s = $this->ok($cam->post("/api/orders/sessions/{$s['id']}/go"));
        $this->assertSame('sent', $this->statuses($s)['tagliata']);
        $this->assertNull($s['heldCourse']);
        $this->assertSame(409, $cam->post("/api/orders/sessions/{$s['id']}/go")->status);

        // chiusura: i piatti già in cucina contano come serviti anche senza «pronto»
        $closed = $this->ok($cam->post("/api/orders/sessions/{$s['id']}/close"));
        // 2×12 + 2×18 + 2,50 + coperto 2×2 = 66,50
        $this->assertSame('66.50', $closed['bill']['total']);
        $this->assertSame('4.00', $closed['bill']['coverTotal']);
        $this->assertNull(collect($this->ok($cam->get('/api/orders/floor'))['tables'])->firstWhere('label', '3')['sessionId'], 'tavolo di nuovo libero');
        $this->assertSame('Marco Cameriere', DB::table('users')->where('id', DB::table('order_items')->value('waiter_id'))->value('name'));
        $this->assertNotNull(DB::table('order_items')->where('name', 'Acqua 75cl')->value('unit_cost'), 'costo del momento registrato');
    }

    public function test_chiusura_con_portata_mai_partita(): void
    {
        $cam = $this->loginAs('cam@s.test');
        $s = $this->ok($cam->post('/api/orders/sessions', ['tableIds' => [$this->ids['t2']], 'covers' => 1]));
        $this->ok($cam->post("/api/orders/sessions/{$s['id']}/send", ['items' => [['menuItemId' => $this->ids['carbonara'], 'qty' => 1, 'course' => 1], ['menuItemId' => $this->ids['tagliata'], 'qty' => 1, 'course' => 2]]]));
        $r = $cam->post("/api/orders/sessions/{$s['id']}/close");
        $this->assertSame(409, $r->status);
        $this->assertStringContainsString('1 piatto in attesa del VIA', $r->body['error']['message']);
        $bill = $this->ok($cam->post("/api/orders/sessions/{$s['id']}/close", ['force' => true]))['bill'];
        $this->assertSame('14.00', $bill['total'], 'solo la carbonara (12) + 1 coperto (2)');
        $this->assertSame(['served', 'cancelled'], DB::table('order_items')->orderBy('course')->pluck('status')->all());
    }

    public function test_unione_tavoli_e_esauriti(): void
    {
        $cam = $this->loginAs('cam@s.test');
        $five = $this->ok($cam->post('/api/orders/sessions', ['tableIds' => [$this->ids['t5']], 'covers' => 4]));
        $six = $this->ok($cam->post('/api/orders/sessions', ['tableIds' => [$this->ids['t6']], 'covers' => 6]));
        $this->ok($cam->post("/api/orders/sessions/{$six['id']}/send", ['items' => [['menuItemId' => $this->ids['acqua'], 'qty' => 3]]]));
        $merged = $this->ok($cam->post("/api/orders/sessions/{$five['id']}/tables", ['tableIds' => [$this->ids['t6']]]));
        $this->assertSame(['5-6', 10, 1], [$merged['label'], $merged['covers'], count($merged['items'])]);
        $this->assertSame('cancelled', DB::table('table_sessions')->where('id', $six['id'])->value('status'));
        // tavolata nuova su 7 e 8 insieme
        $big = $this->ok($cam->post('/api/orders/sessions', ['tableIds' => [$this->ids['t8'], $this->ids['t7']], 'covers' => 10]));
        $this->assertSame('7-8', $big['label']);
        $this->assertSame('7', $this->ok($cam->del("/api/orders/sessions/{$big['id']}/tables/{$this->ids['t8']}"))['label']);

        $this->ok($this->loginAs('cuoco@s.test')->patch("/api/orders/setup/items/{$this->ids['carbonara']}/availability", ['isAvailable' => false]));
        $r = $cam->post("/api/orders/sessions/{$five['id']}/send", ['items' => [['menuItemId' => $this->ids['carbonara'], 'qty' => 1]]]);
        $this->assertSame(409, $r->status);
        $this->assertStringContainsString('Carbonara', $r->body['error']['message']);
    }

    public function test_tablet_di_servizio_con_pin(): void
    {
        $a = $this->loginAs('admin@s.test');
        $marco = DB::table('users')->where('email', 'cam@s.test')->value('id');
        $this->ok($a->put("/api/orders/staff/{$marco}/pin", ['pin' => '4321']));
        $this->assertSame(422, $a->put('/api/orders/pin', ['pin' => '4321'])->status, 'PIN già usato');
        $this->assertSame(422, $a->post('/api/orders/device/enable', ['password' => 'sbagliata'])->status);
        $this->ok($a->post('/api/orders/device/enable', ['password' => self::PASSWORD]));

        $me = $this->ok($a->get('/api/auth/me'));
        $this->assertSame([true, 'service', ['orders.kitchen', 'orders.take']], [$me['serviceDevice'], $me['role'], $me['permissions']]);
        $this->assertSame(403, $a->get('/api/orders/setup')->status, 'niente configurazione dal tablet');
        $this->assertSame(403, $a->get('/api/profitability')->status, 'niente costi dal tablet');

        $s = $a->post('/api/orders/sessions', ['tableIds' => [$this->ids['t1']], 'covers' => 2]);
        $this->assertSame(422, $s->status, 'serve il PIN');
        $this->assertSame(422, $a->post('/api/orders/sessions', ['tableIds' => [$this->ids['t1']], 'covers' => 2, 'pin' => '0000'])->status);
        $s = $this->ok($a->post('/api/orders/sessions', ['tableIds' => [$this->ids['t1']], 'covers' => 2, 'pin' => '4321']));
        $this->ok($a->post("/api/orders/sessions/{$s['id']}/send", ['items' => [['menuItemId' => $this->ids['carbonara'], 'qty' => 1]], 'pin' => '4321']));
        $this->assertSame($marco, DB::table('order_items')->value('waiter_id'), 'l’ordine è di chi ha messo il PIN');
        $this->assertSame('Marco Cameriere', $this->ok($a->post('/api/orders/device/whoami', ['pin' => '4321']))['name']);

        $this->assertSame(422, $a->post('/api/orders/device/disable', ['password' => 'no'])->status);
        $this->ok($a->post('/api/orders/device/disable', ['password' => self::PASSWORD]));
        $this->assertFalse($this->ok($a->get('/api/auth/me'))['serviceDevice']);
    }

    private function statuses(array $s): array
    {
        $out = [];
        foreach ($s['items'] as $i) {
            $out[strtolower(explode(' ', $i['name'])[0])] = $i['status'];
        }

        return $out;
    }
}
