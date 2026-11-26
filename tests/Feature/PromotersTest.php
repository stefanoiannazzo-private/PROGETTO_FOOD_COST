<?php

namespace Tests\Feature;

use Illuminate\Support\Facades\DB;
use Tests\TestCase;

/** NUOVO — promotori e codici promo (referral). */
class PromotersTest extends TestCase
{
    private string $trattoria;

    protected function setUp(): void
    {
        parent::setUp();
        $this->trattoria = $this->createCompany('Trattoria');
        $this->createUser('super@example.test', 'Super Admin', true);
        $this->addMember($this->trattoria, $this->createUser('admin.t@example.test', 'Mario Rossi'), 'admin');
    }

    private function token(string $link): string
    {
        parse_str((string) parse_url($link, PHP_URL_QUERY), $q);

        return $q['token'];
    }

    public function test_solo_il_superadmin_gestisce_i_promotori(): void
    {
        $this->assertSame(401, $this->client()->get('/api/platform/promoters')->status);
        $a = $this->loginAs('admin.t@example.test');
        $this->assertSame(403, $a->get('/api/platform/promoters')->status);
        $this->assertSame(403, $a->post('/api/platform/promoters', ['name' => 'X'])->status);
        $this->assertSame(403, $a->get('/api/platform/users')->status);
    }

    public function test_codice_generato_personalizzato_e_univoco(): void
    {
        $s = $this->loginAs('super@example.test');
        $auto = $this->ok($s->post('/api/platform/promoters', ['name' => 'Giulia Bianchi', 'phone' => '333 1234567']));
        $this->assertMatchesRegularExpression('/^GIULIA\d{2}$/', $auto['code']);
        $mine = $this->ok($s->post('/api/platform/promoters', ['name' => 'Luca Verdi', 'code' => ' luca-chef ']));
        $this->assertSame('LUCA-CHEF', $mine['code']);
        $dup = $s->post('/api/platform/promoters', ['name' => 'Altro', 'code' => 'Luca-Chef']);
        $this->assertSame(422, $dup->status);
        $this->assertArrayHasKey('code', $dup->body['error']['details']['fields']);
        $this->assertSame(422, $s->post('/api/platform/promoters', ['name' => 'Altro', 'code' => 'a!'])->status);
        $this->assertSame(422, $s->post('/api/platform/promoters', [])->status);
    }

    public function test_promotore_collegato_a_un_utente_del_portale(): void
    {
        $s = $this->loginAs('super@example.test');
        $u = $this->ok($s->get('/api/platform/users?q=mario'))['data'][0];
        $this->assertSame(['Trattoria'], $u['companies']);
        $p = $this->ok($s->post('/api/platform/promoters', ['userId' => $u['id']]));
        $this->assertSame('Mario Rossi', $p['name']);
        $this->assertSame($p['code'], $this->ok($s->get('/api/platform/users?q=mario'))['data'][0]['promoterCode']);
        $row = $this->ok($s->get("/api/platform/promoters/{$p['id']}"));
        $this->assertSame('admin.t@example.test', $row['user']['email']);
        $this->assertSame(['Trattoria'], $row['user']['companies']);
    }

    public function test_codice_alla_creazione_azienda_e_classifica(): void
    {
        $s = $this->loginAs('super@example.test');
        $p = $this->ok($s->post('/api/platform/promoters', ['name' => 'Giulia', 'code' => 'GIULIA']));
        $bad = $s->post('/api/platform/companies', ['name' => 'Pizzeria', 'adminName' => 'Gino Pizza', 'adminEmail' => 'gino@example.test', 'promoCode' => 'NONESISTE']);
        $this->assertSame(422, $bad->status);
        $this->assertArrayHasKey('promoCode', $bad->body['error']['details']['fields']);
        $this->assertSame(0, DB::table('companies')->where('name', 'Pizzeria')->count(), 'con codice errato non si crea nulla');

        $c = $this->ok($s->post('/api/platform/companies', ['name' => 'Pizzeria', 'adminName' => 'Gino Pizza', 'adminEmail' => 'gino@example.test', 'promoCode' => 'giulia']));
        $row = collect($this->ok($s->get('/api/platform/companies'))['data'])->firstWhere('id', $c['id']);
        $this->assertSame(['id' => $p['id'], 'name' => 'Giulia', 'code' => 'GIULIA'], $row['promoter']);

        $list = $this->ok($s->get('/api/platform/promoters'));
        $g = collect($list['data'])->firstWhere('code', 'GIULIA');
        $this->assertSame([1, 0, 0], [$g['companies'], $g['active'], $g['inUse']]);
        $this->assertSame(1, $list['totals']['referred']);

        // l'amministratore accetta: l'azienda diventa attiva; con una ricetta diventa «in uso»
        $gino = $this->client();
        $this->ok($gino->post('/api/auth/invitations/accept', ['token' => $this->token($c['invitation']['inviteLink']), 'password' => 'Password-gino-1']));
        $this->ok($gino->post('/api/recipes', ['title' => 'Margherita', 'status' => 'draft', 'revision' => ['components' => []]]));
        $g = collect($this->ok($s->get('/api/platform/promoters'))['data'])->firstWhere('code', 'GIULIA');
        $this->assertSame([1, 1, 1], [$g['companies'], $g['active'], $g['inUse']]);
        $detail = $this->ok($s->get("/api/platform/promoters/{$p['id']}"));
        $this->assertSame('Pizzeria', $detail['referredCompanies'][0]['name']);
        $this->assertSame('platform', $detail['referredCompanies'][0]['via']);
    }

    public function test_codice_inserito_dal_ristoratore_nell_invito(): void
    {
        $s = $this->loginAs('super@example.test');
        $this->ok($s->post('/api/platform/promoters', ['name' => 'Luca', 'code' => 'LUCA10']));
        $c = $this->ok($s->post('/api/platform/companies', ['name' => 'Osteria', 'adminName' => 'Ada Osti', 'adminEmail' => 'ada@example.test']));
        $token = $this->token($c['invitation']['inviteLink']);
        $this->assertTrue($this->ok($this->client()->get("/api/auth/invitations/{$token}"))['askPromo']);

        $ada = $this->client();
        $bad = $ada->post('/api/auth/invitations/accept', ['token' => $token, 'password' => 'Password-ada-12', 'promoCode' => 'SBAGLIATO']);
        $this->assertSame(422, $bad->status);
        $this->assertSame(0, DB::table('users')->where('email', 'ada@example.test')->count(), 'nessun account con codice errato');
        $this->ok($ada->post('/api/auth/invitations/accept', ['token' => $token, 'password' => 'Password-ada-12', 'promoCode' => 'luca10']));
        $co = DB::table('companies')->where('id', $c['id'])->first();
        $this->assertSame(['LUCA10', 'invite'], [$co->promo_code, $co->referred_via]);

        // ai successivi invitati della stessa azienda il codice non si chiede più
        $inv = $this->ok($ada->post('/api/users/invitations', ['email' => 'bea@example.test', 'name' => 'Bea', 'role' => 'operator']));
        $this->assertFalse($this->ok($this->client()->get('/api/auth/invitations/'.$this->token($inv['inviteLink'])))['askPromo']);
    }

    public function test_codice_disattivato_e_correzione_del_superadmin(): void
    {
        $s = $this->loginAs('super@example.test');
        $p = $this->ok($s->post('/api/platform/promoters', ['name' => 'Giulia', 'code' => 'GIULIA']));
        $this->ok($s->patch("/api/platform/promoters/{$p['id']}", ['isActive' => false]));
        $this->assertSame(422, $s->post('/api/platform/companies', ['name' => 'Bar', 'adminName' => 'Bar Man', 'adminEmail' => 'bar@example.test', 'promoCode' => 'GIULIA'])->status);
        $this->ok($s->patch("/api/platform/promoters/{$p['id']}", ['isActive' => true, 'code' => 'GIULIA-2026']));

        $this->ok($s->patch("/api/platform/companies/{$this->trattoria}", ['promoCode' => 'giulia-2026']));
        $this->assertSame($p['id'], DB::table('companies')->where('id', $this->trattoria)->value('promoter_id'));
        $this->ok($s->patch("/api/platform/companies/{$this->trattoria}", ['promoCode' => null]));
        $this->assertNull(DB::table('companies')->where('id', $this->trattoria)->value('promoter_id'));
    }
}
