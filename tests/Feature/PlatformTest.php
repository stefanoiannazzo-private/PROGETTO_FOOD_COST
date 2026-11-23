<?php

namespace Tests\Feature;

use Illuminate\Support\Facades\DB;
use Tests\ApiClient;
use Tests\TestCase;

/** NUOVO (non presente nell'originale): console SaaS del superadmin, agente sui prezzi, voce extra della retribuzione. */
class PlatformTest extends TestCase
{
    private string $trattoria;

    private string $osteria;

    protected function setUp(): void
    {
        parent::setUp();
        $this->trattoria = $this->createCompany('Trattoria');
        $this->osteria = $this->createCompany('Osteria');
        $this->createUser('super@example.test', 'Super Admin', true);
        $this->addMember($this->trattoria, $this->createUser('admin.t@example.test', 'Admin T'), 'admin');
        $this->addMember($this->trattoria, $this->createUser('resp.t@example.test', 'Resp T'), 'manager');
        $this->addMember($this->osteria, $this->createUser('admin.o@example.test', 'Admin O'), 'admin');
    }

    /** Ricetta "Lasagna" con un solo ingrediente a prezzo dato (costo = prezzo × kg usati). */
    private function lasagna(ApiClient $c, string $title, string $price, string $agent, string $weight): string
    {
        $ing = $this->ok($c->post('/api/ingredients', ['code' => 'MOZ', 'name' => 'Mozzarella', 'supplier' => 'Caseificio Rossi', 'packageContent' => '1', 'packageUnit' => 'kg', 'usageUnit' => 'g',
            'initialPrice' => ['packagePrice' => $price, 'validFrom' => '2026-01-01', 'agentName' => $agent]]))['id'];

        return $this->ok($c->post('/api/recipes', ['title' => $title, 'status' => 'active', 'revision' => ['finalWeightKg' => $weight, 'portions' => '4', 'components' => [['kind' => 'ingredient', 'ingredientId' => $ing, 'quantity' => '1', 'unit' => 'kg']]]]))['id'];
    }

    public function test_solo_il_superadmin_accede_alla_console(): void
    {
        $this->assertSame(401, $this->client()->get('/api/platform/overview')->status);
        $admin = $this->loginAs('admin.t@example.test');
        foreach (['/api/platform/overview', '/api/platform/companies', '/api/platform/recipes', '/api/platform/ingredients', '/api/platform/comparison-groups'] as $url) {
            $this->assertSame(403, $admin->get($url)->status, $url);
        }
        $this->assertSame(403, $admin->post('/api/platform/companies', ['name' => 'X', 'adminName' => 'Y Z', 'adminEmail' => 'y@example.test'])->status);
        $this->ok($this->loginAs('super@example.test')->get('/api/platform/overview'));
    }

    public function test_nuovo_tenant_con_invito_al_suo_amministratore(): void
    {
        $s = $this->loginAs('super@example.test');
        $r = $this->ok($s->post('/api/platform/companies', ['name' => 'Pizzeria Nuova', 'adminName' => 'Gino Pizza', 'adminEmail' => 'Gino@Example.test']));
        parse_str((string) parse_url($r['invitation']['inviteLink'], PHP_URL_QUERY), $q);
        $me = $this->ok($this->client()->post('/api/auth/invitations/accept', ['token' => $q['token'], 'password' => 'Password-gino-1']));
        $this->assertSame('admin', $me['role']);
        $this->assertSame('Pizzeria Nuova', $me['company']['name']);
        // il superadmin non diventa membro del nuovo tenant
        $this->assertSame(0, DB::table('memberships')->where('company_id', $r['id'])->join('users', 'users.id', '=', 'memberships.user_id')->where('users.email', 'super@example.test')->count());
        $names = array_column($this->ok($s->get('/api/platform/companies'))['data'], 'name');
        $this->assertContains('Pizzeria Nuova', $names);
    }

    public function test_vede_le_ricette_di_tutti_e_le_confronta(): void
    {
        $t = $this->lasagna($this->loginAs('admin.t@example.test'), 'Lasagna al forno', '10', 'Bianchi', '2');
        $o = $this->lasagna($this->loginAs('admin.o@example.test'), 'Lasagne della casa', '12', 'Verdi', '2');
        $s = $this->loginAs('super@example.test');
        $list = $this->ok($s->get('/api/platform/recipes?q=lasagn'));
        $this->assertSame(['Osteria', 'Trattoria'], collect($list['data'])->pluck('company')->sort()->values()->all());

        $g = $this->ok($s->post('/api/platform/comparison-groups', ['name' => 'Lasagne', 'recipeIds' => [$t, $o]]));
        $cmp = $this->ok($s->get("/api/platform/comparison-groups/{$g['id']}"));
        $this->assertCount(2, $cmp['recipes']);
        $this->assertSame('5', $cmp['stats']['costPerKg']['min']);
        $this->assertSame('6', $cmp['stats']['costPerKg']['max']);
        $this->assertSame('20', $cmp['stats']['costPerKg']['spreadPercent']);
        $this->assertSame('100', $cmp['recipes'][0]['breakdown']['ingredientsPercent']);
        // i dati dei ristoratori non vengono toccati: nessuna ricetta copiata o modificata
        $this->assertSame(2, DB::table('recipes')->count());
        $this->assertSame(422, $s->post('/api/platform/comparison-groups', ['name' => 'X', 'recipeIds' => ['00000000-0000-4000-8000-000000000000']])->status);
    }

    public function test_statistiche_prezzi_per_fornitore_e_agente(): void
    {
        $this->lasagna($this->loginAs('admin.t@example.test'), 'A', '10', 'Bianchi', '2');
        $this->lasagna($this->loginAs('admin.o@example.test'), 'B', '12', 'Verdi', '2');
        $s = $this->loginAs('super@example.test');
        $this->assertSame(422, $s->get('/api/platform/price-stats')->status);
        $st = $this->ok($s->get('/api/platform/price-stats?product=mozzarella&supplier=rossi'));
        $this->assertCount(2, $st['points']);
        $byAgent = collect($st['summary']['byAgent'])->keyBy('label');
        $this->assertSame('10', $byAgent['Bianchi']['avg']);
        $this->assertSame('12', $byAgent['Verdi']['avg']);
        $prod = $st['summary']['byProduct'][0];
        $this->assertSame(['Mozzarella', 'kg', 2, '10', '12', '11', '20'], [$prod['label'], $prod['baseUnit'], $prod['count'], $prod['min'], $prod['max'], $prod['avg'], $prod['spreadPercent']]);
        $onlyVerdi = $this->ok($s->get('/api/platform/price-stats?agent=verdi'));
        $this->assertSame(['Osteria'], array_column($onlyVerdi['points'], 'company'));
    }

    public function test_agente_salvato_sul_prezzo_e_visibile_al_ristoratore(): void
    {
        $a = $this->loginAs('admin.t@example.test');
        $id = $this->ok($a->post('/api/ingredients', ['name' => 'Burro', 'packageContent' => '1', 'packageUnit' => 'kg', 'usageUnit' => 'g', 'initialPrice' => ['packagePrice' => '9', 'validFrom' => '2026-01-01']]))['id'];
        $this->ok($a->post("/api/ingredients/{$id}/prices", ['packagePrice' => '8.5', 'validFrom' => '2026-03-01', 'agentName' => 'Mario Agente']));
        $this->assertSame('Mario Agente', DB::table('ingredient_prices')->where('ingredient_id', $id)->where('valid_from', '2026-03-01')->value('agent_name'));
        $this->assertNull(DB::table('ingredient_prices')->where('ingredient_id', $id)->where('valid_from', '2026-01-01')->value('agent_name'));
        $this->assertStringContainsString('Mario Agente', json_encode($this->ok($a->get("/api/ingredients/{$id}"))));
    }

    public function test_modalita_assistenza_registrata(): void
    {
        $s = $this->loginAs('super@example.test');
        $this->ok($s->post('/api/auth/company', ['companyId' => $this->osteria]));
        $me = $this->ok($s->get('/api/auth/me'));
        $this->assertTrue($me['assist']);
        $this->assertSame('admin', $me['role']);
        $this->assertSame('Osteria', $me['company']['name']);
        $this->assertSame(1, DB::table('audit_logs')->where('company_id', $this->osteria)->where('action', 'assist_started')->count());
        // un amministratore normale non può farlo
        $this->assertSame(403, $this->loginAs('admin.t@example.test')->post('/api/auth/company', ['companyId' => $this->osteria])->status);
    }

    public function test_voce_extra_della_retribuzione(): void
    {
        $a = $this->loginAs('admin.t@example.test');
        $emp = $this->ok($a->post('/api/employees', ['code' => 'D1', 'firstName' => 'Mario', 'lastName' => 'Rossi', 'firstCost' => ['validFrom' => '2026-01-01', 'grossMonthly' => '2400', 'extraMonthly' => '600', 'contributionsMode' => 'percent', 'contributionsValue' => '10', 'productiveHours' => '160']]));
        // (2400 + 600) × 1,10 = 3300 €/mese → 20,625 €/h → 0,34375 €/min
        $list = $this->ok($a->get('/api/employees'));
        $this->assertSame('0.34375', $list['data'][0]['cost']['costPerMinute']);
        $detail = $this->ok($a->get("/api/employees/{$emp['id']}"));
        $this->assertSame('600', rtrim(rtrim((string) $detail['costs'][0]['extraMonthly'], '0'), '.'));
        $r = $this->ok($a->post('/api/recipes', ['title' => 'Brodo', 'revision' => ['finalWeightKg' => '1', 'labor' => [['employeeId' => $emp['id'], 'activeMinutes' => '16', 'sharePercent' => '100']]]]));
        $this->assertSame('5.5', $this->ok($a->get("/api/recipes/{$r['id']}"))['valuation']['labor']);
        // il responsabile vede solo il costo aggregato, mai la voce extra
        $m = $this->ok($this->loginAs('resp.t@example.test')->get('/api/employees'));
        $this->assertStringNotContainsString('600', json_encode($m));
        $this->assertStringNotContainsString('extraMonthly', json_encode($m));
        // il superadmin vede le retribuzioni (in modalità assistenza)
        $s = $this->loginAs('super@example.test');
        $this->ok($s->post('/api/auth/company', ['companyId' => $this->trattoria]));
        $this->assertSame('0.34375', $this->ok($s->get('/api/employees'))['data'][0]['cost']['costPerMinute']);
        // valore extra non valido
        $bad = $a->post("/api/employees/{$emp['id']}/costs", ['validFrom' => '2026-05-01', 'grossMonthly' => '2400', 'extraMonthly' => '-1', 'contributionsMode' => 'none', 'productiveHours' => '160']);
        $this->assertSame(422, $bad->status);
    }

    public function test_link_di_invito_sempre_visibile_e_invio_su_richiesta(): void
    {
        config(['foodcost.dev_expose_tokens' => false]);
        $outbox = storage_path('app/outbox');
        $count = fn () => count(glob($outbox.'/*bar.mario@example.test.eml') ?: []);
        $before = $count();
        $s = $this->loginAs('super@example.test');
        // senza invio: il link c'è, nessuna email
        $r = $this->ok($s->post('/api/platform/companies', ['name' => 'Bar Mario', 'adminName' => 'Mario Bar', 'adminEmail' => 'bar.mario@example.test']));
        $inv = $r['invitation'];
        $this->assertSame(['skipped', 'bar.mario@example.test'], [$inv['mail'], $inv['email']]);
        $this->assertStringContainsString('/invito?token=', $inv['inviteLink']);
        $this->assertSame($before, $count());
        $token = substr($inv['inviteLink'], strpos($inv['inviteLink'], 'token=') + 6);

        // invio su richiesta, solo con il token giusto
        $this->assertSame(422, $s->post("/api/platform/invitations/{$inv['id']}/send", ['token' => str_repeat('x', 40)])->status);
        $this->assertSame('outbox', $this->ok($s->post("/api/platform/invitations/{$inv['id']}/send", ['token' => $token]))['mail']);
        $this->assertSame($before + 1, $count());
        $this->assertSame(403, $this->loginAs('admin.t@example.test')->post("/api/platform/invitations/{$inv['id']}/send", ['token' => $token])->status);

        // nuovo link: il vecchio non vale più, il nuovo sì
        $renew = $this->ok($s->post("/api/platform/invitations/{$inv['id']}/renew"));
        $this->assertNotSame($inv['inviteLink'], $renew['inviteLink']);
        $this->assertSame(422, $s->post("/api/platform/invitations/{$inv['id']}/send", ['token' => $token])->status);
        $list = collect($this->ok($s->get('/api/platform/companies'))['data'])->firstWhere('name', 'Bar Mario');
        $this->assertSame($inv['id'], $list['pendingAdminInvitations'][0]['id']);

        // con l'opzione attiva l'email parte subito
        $r = $this->ok($s->post('/api/platform/companies', ['name' => 'Bar Due', 'adminName' => 'Luigi Due', 'adminEmail' => 'bar.mario@example.test', 'sendEmail' => true]));
        $this->assertSame('outbox', $r['invitation']['mail']);
        $this->assertArrayHasKey('inviteLink', $r['invitation']);
    }
}
