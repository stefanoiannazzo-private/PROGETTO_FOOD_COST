<?php

namespace Tests\Feature;

use App\Auth\Crypto;
use Illuminate\Support\Facades\DB;
use Tests\TestCase;

/** Port di apps/api/test/auth-tenancy.test.ts */
class AuthTenancyTest extends TestCase
{
    private string $companyA;

    private string $companyB;

    protected function setUp(): void
    {
        parent::setUp();
        $this->companyA = $this->createCompany('Trattoria A');
        $this->companyB = $this->createCompany('Pasticceria B');
        $this->addMember($this->companyA, $this->createUser('admin.a@example.test', 'Admin A'), 'admin');
        $this->addMember($this->companyA, $this->createUser('resp.a@example.test', 'Responsabile A'), 'manager');
        $this->addMember($this->companyA, $this->createUser('op.a@example.test', 'Operatore A'), 'operator');
        $this->addMember($this->companyB, $this->createUser('admin.b@example.test', 'Admin B'), 'admin');
        $multi = $this->createUser('multi@example.test', 'Consulente');
        $this->addMember($this->companyA, $multi, 'manager');
        $this->addMember($this->companyB, $multi, 'operator');
    }

    private static function token(string $link): string
    {
        parse_str((string) parse_url($link, PHP_URL_QUERY), $q);

        return $q['token'];
    }

    // --- Autenticazione ---

    public function test_rifiuta_credenziali_errate_con_messaggio_generico(): void
    {
        $c = $this->client();
        $r = $c->post('/api/auth/login', ['email' => 'admin.a@example.test', 'password' => 'sbagliata']);
        $this->assertSame(401, $r->status);
        $this->assertSame('Email o password non corrette.', $r->body['error']['message']);
        $r2 = $c->post('/api/auth/login', ['email' => 'nessuno@example.test', 'password' => 'sbagliata']);
        $this->assertSame($r->body['error']['message'], $r2->body['error']['message']);
    }

    public function test_login_profilo_e_logout(): void
    {
        $c = $this->loginAs('admin.a@example.test');
        $me = $this->ok($c->get('/api/auth/me'));
        $this->assertSame('Trattoria A', $me['company']['name']);
        $this->assertContains('salaries.read', $me['permissions']);
        $this->ok($c->post('/api/auth/logout'));
        $this->assertSame(401, $c->get('/api/auth/me')->status);
    }

    public function test_limita_i_tentativi_di_login(): void
    {
        config(['foodcost.login_rate_limit' => 3, 'foodcost.rate_limit_in_tests' => true]);
        $c = $this->client();
        $codes = [];
        for ($i = 0; $i < 5; $i++) {
            $codes[] = $c->post('/api/auth/login', ['email' => 'x@example.test', 'password' => 'y'])->status;
        }
        $this->assertSame([401, 401, 401, 429, 429], $codes);
    }

    public function test_csrf_e_origini_estranee_respinte(): void
    {
        $c = $this->loginAs('admin.a@example.test');
        $this->assertSame(403, $c->request('POST', '/api/ingredients', ['name' => 'X'], false)->status);
        $this->assertSame(403, $c->request('POST', '/api/ingredients', ['name' => 'X'], true, 'https://sito-malevolo.example')->status);
    }

    public function test_utente_con_piu_aziende_deve_selezionare(): void
    {
        $c = $this->loginAs('multi@example.test');
        $me = $this->ok($c->get('/api/auth/me'));
        $this->assertNull($me['company']);
        $this->assertCount(2, $me['companies']);
        $this->assertSame(409, $c->get('/api/ingredients')->status);
        $this->ok($c->post('/api/auth/company', ['companyId' => $this->companyB]));
        $me2 = $this->ok($c->get('/api/auth/me'));
        $this->assertSame($this->companyB, $me2['company']['id']);
        $this->assertSame('operator', $me2['role']);
    }

    public function test_non_si_seleziona_azienda_non_propria(): void
    {
        $c = $this->loginAs('admin.a@example.test');
        $this->assertSame(403, $c->post('/api/auth/company', ['companyId' => $this->companyB])->status);
    }

    public function test_recupero_password_monouso(): void
    {
        $anon = $this->client();
        $r = $this->ok($anon->post('/api/auth/password/forgot', ['email' => 'op.a@example.test']));
        $token = self::token($r['devLink']);
        $unknown = $this->ok($anon->post('/api/auth/password/forgot', ['email' => 'sconosciuto@example.test']));
        $this->assertSame($r['message'], $unknown['message']);
        $this->assertSame(422, $anon->post('/api/auth/password/reset', ['token' => $token, 'password' => 'corta'])->status);
        $this->ok($anon->post('/api/auth/password/reset', ['token' => $token, 'password' => 'Nuova-password-sicura']));
        $this->assertSame(422, $anon->post('/api/auth/password/reset', ['token' => $token, 'password' => 'Altra-password-sicura'])->status);
        $login = $this->client()->post('/api/auth/login', ['email' => 'op.a@example.test', 'password' => 'Nuova-password-sicura']);
        $this->assertSame(200, $login->status);
    }

    // --- Utenti, inviti e ruoli ---

    public function test_invito_accettazione_ruolo_e_disattivazione(): void
    {
        $admin = $this->loginAs('admin.a@example.test');
        $inv = $this->ok($admin->post('/api/users/invitations', ['email' => 'nuovo@example.test', 'name' => 'Nuovo Cuoco', 'role' => 'operator', 'extraPermissions' => ['costs.read']]));
        $this->assertSame('outbox', $inv['mail']);
        $token = self::token($inv['inviteLink']);
        $anon = $this->client();
        $info = $this->ok($anon->get("/api/auth/invitations/{$token}"));
        $this->assertSame('Trattoria A', $info['company']);
        $this->assertFalse($info['existingUser']);
        $me = $this->ok($anon->post('/api/auth/invitations/accept', ['token' => $token, 'password' => 'Password-nuovo-1']));
        $this->assertSame('operator', $me['role']);
        $this->assertContains('costs.read', $me['permissions']);

        $list = $this->ok($admin->get('/api/users'));
        $m = collect($list['data'])->firstWhere('email', 'nuovo@example.test');
        $this->ok($admin->patch("/api/users/{$m['id']}", ['role' => 'manager']));
        $this->ok($admin->patch("/api/users/{$m['id']}", ['isActive' => false]));
        $this->assertSame(401, $anon->get('/api/ingredients')->status);
    }

    public function test_non_si_rimuove_ultimo_admin(): void
    {
        $admin = $this->loginAs('admin.b@example.test');
        $list = $this->ok($admin->get('/api/users'));
        $self = collect($list['data'])->firstWhere('isSelf', true);
        $r = $admin->patch("/api/users/{$self['id']}", ['role' => 'manager']);
        $this->assertSame(409, $r->status);
        $this->assertSame('last_admin', $r->body['error']['code']);
    }

    public function test_solo_admin_gestiscono_utenti(): void
    {
        $manager = $this->loginAs('resp.a@example.test');
        $this->assertSame(403, $manager->get('/api/users')->status);
        $this->assertSame(403, $manager->post('/api/users/invitations', ['email' => 'x@example.test', 'name' => 'X Y', 'role' => 'admin'])->status);
    }

    // --- Isolamento tra aziende ---

    /** @return array{0:string,1:string} */
    private function seedA(): array
    {
        $a = $this->loginAs('admin.a@example.test');
        $ingA = $this->ok($a->post('/api/ingredients', ['code' => 'FAR', 'name' => 'Farina 00', 'packageContent' => 25, 'packageUnit' => 'kg', 'usageUnit' => 'g', 'initialPrice' => ['packagePrice' => '20', 'validFrom' => '2026-01-01']]))['id'];
        $recipeA = $this->ok($a->post('/api/recipes', ['title' => 'Pane', 'revision' => ['components' => [['kind' => 'ingredient', 'ingredientId' => $ingA, 'quantity' => '1', 'unit' => 'kg']]]]))['id'];

        return [$ingA, $recipeA];
    }

    public function test_b_non_vede_ne_modifica_dati_di_a(): void
    {
        [$ingA, $recipeA] = $this->seedA();
        $b = $this->loginAs('admin.b@example.test');
        $this->assertSame(404, $b->get("/api/ingredients/{$ingA}")->status);
        $this->assertSame(404, $b->get("/api/recipes/{$recipeA}")->status);
        $this->assertSame(404, $b->patch("/api/ingredients/{$ingA}", ['code' => 'FAR', 'name' => 'Hack', 'packageContent' => 1, 'packageUnit' => 'kg', 'usageUnit' => 'g', 'lockVersion' => 1])->status);
        $this->assertSame(404, $b->post("/api/ingredients/{$ingA}/prices", ['packagePrice' => '1', 'validFrom' => '2026-02-01'])->status);
        $this->assertSame(404, $b->post("/api/recipes/{$recipeA}/snapshots", ['expectedRevisionId' => $recipeA])->status);
        $this->assertCount(0, $this->ok($b->get('/api/ingredients'))['data']);
    }

    public function test_b_non_usa_riferimenti_di_a(): void
    {
        [$ingA, $recipeA] = $this->seedA();
        $b = $this->loginAs('admin.b@example.test');
        $r1 = $b->post('/api/recipes', ['title' => 'Furto', 'revision' => ['components' => [['kind' => 'ingredient', 'ingredientId' => $ingA, 'quantity' => '1', 'unit' => 'kg']]]]);
        $this->assertSame(422, $r1->status);
        $this->assertSame('invalid_reference', $r1->body['error']['code']);
        $r2 = $b->post('/api/recipes', ['title' => 'Furto 2', 'revision' => ['components' => [['kind' => 'recipe', 'recipeId' => $recipeA, 'quantity' => '1', 'unit' => 'kg']]]]);
        $this->assertSame(422, $r2->status);
        $this->assertSame(404, $b->post('/api/recipes/preview', ['recipeId' => $recipeA, 'revision' => new \stdClass])->status);
    }

    // --- Permessi su costi e retribuzioni ---

    /** @return array{0:string,1:string} */
    private function seedLabor(): array
    {
        $a = $this->loginAs('admin.a@example.test');
        $emp = $this->ok($a->post('/api/employees', ['code' => 'D1', 'firstName' => 'Mario', 'lastName' => 'Rossi', 'jobTitle' => 'Cuoco', 'firstCost' => ['validFrom' => '2026-01-01', 'grossMonthly' => '2400', 'contributionsMode' => 'none', 'productiveHours' => '160']]));
        $recipeId = $this->ok($a->post('/api/recipes', ['title' => 'Brodo', 'revision' => ['finalWeightKg' => '1', 'labor' => [['employeeId' => $emp['id'], 'activeMinutes' => '12', 'sharePercent' => '100']]]]))['id'];

        return [$emp['id'], $recipeId];
    }

    public function test_admin_vede_retribuzioni(): void
    {
        [, $recipeId] = $this->seedLabor();
        $a = $this->loginAs('admin.a@example.test');
        $this->assertSame('0.25', $this->ok($a->get('/api/employees'))['data'][0]['cost']['costPerMinute']);
        $r = $this->ok($a->get("/api/recipes/{$recipeId}"));
        $this->assertSame('3', $r['valuation']['laborLines'][0]['cost']);
        $this->assertSame('3', $r['valuation']['labor']);
    }

    public function test_responsabile_non_vede_retribuzioni(): void
    {
        [$employeeId, $recipeId] = $this->seedLabor();
        $m = $this->loginAs('resp.a@example.test');
        $list = $this->ok($m->get('/api/employees'));
        $this->assertSame('Mario Rossi', $list['data'][0]['name']);
        $this->assertArrayNotHasKey('cost', $list['data'][0]);
        $this->assertStringNotContainsString('2400', json_encode($list));
        $this->assertArrayNotHasKey('costs', $this->ok($m->get("/api/employees/{$employeeId}")));
        $r = $this->ok($m->get("/api/recipes/{$recipeId}"));
        $this->assertSame('3', $r['valuation']['labor']);
        $this->assertNull($r['valuation']['laborLines'][0]['cost']);
        $this->assertNull($r['valuation']['laborLines'][0]['costPerMinute']);
        $this->assertSame(403, $m->post("/api/employees/{$employeeId}/costs", ['validFrom' => '2026-03-01', 'grossMonthly' => '1', 'contributionsMode' => 'none', 'productiveHours' => '1'])->status);
    }

    public function test_operatore_non_vede_costi(): void
    {
        [, $recipeId] = $this->seedLabor();
        $this->seedA();
        $o = $this->loginAs('op.a@example.test');
        $r = $this->ok($o->get("/api/recipes/{$recipeId}"));
        $this->assertNull($r['valuation']);
        $this->assertCount(1, $r['revision']['labor']);
        $this->assertNull($this->ok($o->get('/api/ingredients'))['data'][0]['price']);
        $this->assertSame(404, $o->get('/api/employees')->status);
        $this->assertSame(403, $o->post('/api/recipes', ['title' => 'X', 'revision' => new \stdClass])->status);
    }

    public function test_numeri_solo_normalizzati(): void
    {
        [$employeeId] = $this->seedLabor();
        $a = $this->loginAs('admin.a@example.test');
        foreach (['2.400,00', '1.234.567', '2 400', '€ 2400'] as $bad) {
            $r = $a->post("/api/employees/{$employeeId}/costs", ['validFrom' => '2026-05-01', 'grossMonthly' => $bad, 'contributionsMode' => 'none', 'productiveHours' => '160']);
            $this->assertSame(422, $r->status, $bad);
        }
        $r = $a->post("/api/employees/{$employeeId}/costs", ['validFrom' => '2026-05-01', 'grossMonthly' => '2.400,00', 'contributionsMode' => 'none', 'productiveHours' => '160']);
        $this->assertMatchesRegularExpression('/non è un numero valido/', $r->body['error']['details']['fields']['grossMonthly']);
        $this->assertSame(200, $a->post("/api/employees/{$employeeId}/costs", ['validFrom' => '2026-05-01', 'grossMonthly' => '2400,50', 'contributionsMode' => 'none', 'productiveHours' => '160'])->status);
    }

    public function test_audit_senza_importi_retributivi(): void
    {
        [$employeeId] = $this->seedLabor();
        $a = $this->loginAs('admin.a@example.test');
        $a->post("/api/employees/{$employeeId}/costs", ['validFrom' => '2026-05-01', 'grossMonthly' => '2400,50', 'contributionsMode' => 'none', 'productiveHours' => '160', 'extraMonthly' => '150']);
        $rows = DB::table('audit_logs')->where('entity_type', 'employee_cost')->pluck('details');
        $this->assertGreaterThan(0, $rows->count());
        $this->assertStringNotContainsString('2400', json_encode($rows));
        $this->assertStringNotContainsString('150', json_encode($rows));
    }
}
