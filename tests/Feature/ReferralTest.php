<?php

namespace Tests\Feature;

use Illuminate\Support\Facades\DB;
use Tests\TestCase;

/** NUOVO — codice tollerante, link del ristoratore, richieste di attivazione, elenco colleghi senza dati interni. */
class ReferralTest extends TestCase
{
    private string $trattoria;

    protected function setUp(): void
    {
        parent::setUp();
        $this->trattoria = $this->createCompany('Trattoria');
        $this->createUser('super@example.test', 'Super Admin', true);
        $this->addMember($this->trattoria, $this->createUser('mario@example.test', 'Mario Rossi'), 'admin');
        $this->addMember($this->trattoria, $this->createUser('cuoco@example.test', 'Carlo Cuoco'), 'operator');
    }

    public function test_codice_tollerante_agli_errori_di_battitura(): void
    {
        $s = $this->loginAs('super@example.test');
        $this->ok($s->post('/api/platform/promoters', ['name' => 'Mario', 'code' => 'MARIO-10']));
        foreach (['mario-10', ' Mario 10 ', 'MARIO10', 'mar1o-1O', 'MARI0.10'] as $typed) {
            $r = $this->ok($this->client()->get('/api/public/promo/'.rawurlencode($typed)));
            $this->assertSame(['valid' => true, 'code' => 'MARIO-10'], $r, $typed);
        }
        $this->assertFalse($this->ok($this->client()->get('/api/public/promo/MARIA10'))['valid']);
        // un codice che si confonde con uno esistente non si può creare
        $dup = $s->post('/api/platform/promoters', ['name' => 'Altro', 'code' => 'MAR1O1O']);
        $this->assertSame(422, $dup->status);
    }

    public function test_il_ristoratore_crea_il_suo_link_e_vede_solo_lo_stato_dei_colleghi(): void
    {
        $cuoco = $this->loginAs('cuoco@example.test');
        $this->assertFalse($this->ok($cuoco->get('/api/referral'))['canCreate']);
        $this->assertSame(403, $cuoco->post('/api/referral', [])->status);

        $m = $this->loginAs('mario@example.test');
        $this->assertTrue($this->ok($m->get('/api/referral'))['canCreate']);
        $mine = $this->ok($m->post('/api/referral', []));
        $code = $mine['promoter']['code'];
        $this->assertMatchesRegularExpression('/^MARIO\d{2}$/', $code);
        $this->assertStringEndsWith('/registrati?promo='.$code, $mine['promoter']['link']);
        $this->assertSame($code, $this->ok($m->post('/api/referral', []))['promoter']['code'], 'una sola volta');

        // il collega apre il link e invia la richiesta (codice scritto in minuscolo)
        $this->ok($this->client()->post('/api/public/signup-requests', ['businessName' => 'Pizzeria Luigi', 'contactName' => 'Luigi Bianchi', 'email' => 'Luigi@Example.test', 'phone' => '333', 'promoCode' => strtolower($code)]));
        $this->assertSame([['name' => 'Pizzeria Luigi', 'status' => 'requested']], array_map(fn ($r) => ['name' => $r['name'], 'status' => $r['status']], $this->ok($m->get('/api/referral'))['referrals']));

        // il superadmin approva: azienda + invito con il promotore collegato
        $s = $this->loginAs('super@example.test');
        $req = $this->ok($s->get('/api/platform/signup-requests'))['data'][0];
        $this->assertSame($code, $req['promoter']['code']);
        $co = $this->ok($s->post("/api/platform/signup-requests/{$req['id']}/approve", ['sendEmail' => false]));
        $this->assertSame('signup', DB::table('companies')->where('id', $co['id'])->value('referred_via'));
        $this->assertSame('luigi@example.test', $co['invitation']['email']);
        $this->assertSame(409, $s->post("/api/platform/signup-requests/{$req['id']}/approve", [])->status);
        $this->assertSame('invited', $this->ok($m->get('/api/referral'))['referrals'][0]['status']);

        // Luigi attiva l'account e inserisce prodotti: Mario vede solo «attivo»
        parse_str((string) parse_url($co['invitation']['inviteLink'], PHP_URL_QUERY), $q);
        $luigi = $this->client();
        $this->ok($luigi->post('/api/auth/invitations/accept', ['token' => $q['token'], 'password' => 'Password-luigi-1']));
        $this->ok($luigi->post('/api/recipes', ['title' => 'Segreto della casa', 'status' => 'draft', 'revision' => ['components' => []]]));
        $refs = $this->ok($m->get('/api/referral'))['referrals'];
        $this->assertSame([['name' => 'Pizzeria Luigi', 'date' => $refs[0]['date'], 'status' => 'active']], $refs);
        $raw = json_encode($this->ok($m->get('/api/referral')));
        $this->assertStringNotContainsString('Segreto', $raw);
        $this->assertStringNotContainsString('luigi@', $raw);
    }

    public function test_richiesta_pubblica_validazioni_e_rifiuto(): void
    {
        $c = $this->client();
        $bad = $c->post('/api/public/signup-requests', ['businessName' => 'Bar', 'contactName' => 'Ugo Ughi', 'email' => 'ugo@example.test', 'promoCode' => 'NONESISTE']);
        $this->assertSame(422, $bad->status);
        $this->assertArrayHasKey('promoCode', $bad->body['error']['details']['fields']);
        $this->assertSame(0, DB::table('signup_requests')->count());
        // bot: campo trappola compilato → risposta normale, nessun dato
        $this->ok($c->post('/api/public/signup-requests', ['businessName' => 'Spam', 'contactName' => 'Spam Bot', 'email' => 'bot@example.test', 'website' => 'http://x']));
        $this->assertSame(0, DB::table('signup_requests')->count());
        // senza codice va bene; la stessa email aggiorna la richiesta aperta
        $this->ok($c->post('/api/public/signup-requests', ['businessName' => 'Bar Ugo', 'contactName' => 'Ugo Ughi', 'email' => 'ugo@example.test']));
        $this->ok($c->post('/api/public/signup-requests', ['businessName' => 'Bar da Ugo', 'contactName' => 'Ugo Ughi', 'email' => 'ugo@example.test']));
        $this->assertSame(1, DB::table('signup_requests')->count());

        $this->assertSame(403, $this->loginAs('mario@example.test')->get('/api/platform/signup-requests')->status);
        $s = $this->loginAs('super@example.test');
        $r = $this->ok($s->get('/api/platform/signup-requests'));
        $this->assertSame([1, 'Bar da Ugo'], [$r['pending'], $r['data'][0]['businessName']]);
        $this->ok($s->post("/api/platform/signup-requests/{$r['data'][0]['id']}/reject", []));
        $this->assertSame(0, $this->ok($s->get('/api/platform/signup-requests'))['pending']);
    }

    public function test_una_persona_ha_un_solo_codice_anche_se_tu_e_lui_lo_create_insieme(): void
    {
        $s = $this->loginAs('super@example.test');
        $m = $this->loginAs('mario@example.test');
        $marioId = DB::table('users')->where('email', 'mario@example.test')->value('id');

        // lui crea per primo: tu ricevi un messaggio chiaro, niente doppione
        $mine = $this->ok($m->post('/api/referral', []))['promoter']['code'];
        $r = $s->post('/api/platform/promoters', ['userId' => $marioId]);
        $this->assertSame(422, $r->status);
        $this->assertStringContainsString($mine, $r->body['error']['message']);
        $this->assertSame(1, DB::table('promoters')->where('user_id', $marioId)->count());

        // tu per primo: lui riceve il tuo codice
        DB::table('promoters')->delete();
        $yours = $this->ok($s->post('/api/platform/promoters', ['userId' => $marioId]))['code'];
        $this->assertSame($yours, $this->ok($m->post('/api/referral', []))['promoter']['code']);
        $this->assertSame(1, DB::table('promoters')->where('user_id', $marioId)->count());

        // nello stesso istante: il database rifiuta comunque il secondo
        $this->expectException(\Illuminate\Database\QueryException::class);
        DB::table('promoters')->insert(['id' => (string) \Illuminate\Support\Str::uuid(), 'code' => 'ALTRO10', 'code_key' => 'A1TR010', 'name' => 'Mario', 'user_id' => $marioId, 'is_active' => 1, 'created_at' => now()]);
    }

    public function test_collegare_a_un_utente_che_ha_gia_un_codice_e_bloccato(): void
    {
        $s = $this->loginAs('super@example.test');
        $marioId = DB::table('users')->where('email', 'mario@example.test')->value('id');
        $this->ok($this->loginAs('mario@example.test')->post('/api/referral', []));
        $ext = $this->ok($s->post('/api/platform/promoters', ['name' => 'Esterno', 'code' => 'EST-01']));
        $this->assertSame(422, $s->patch("/api/platform/promoters/{$ext['id']}", ['userId' => $marioId])->status);
    }
}
