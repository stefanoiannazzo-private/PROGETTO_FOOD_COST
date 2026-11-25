<?php

namespace Tests\Feature;

use Illuminate\Http\UploadedFile;
use Illuminate\Support\Facades\DB;
use Tests\TestCase;

/** NUOVO — Assistenza: apertura richiesta con screenshot, visibilità, risposta del supporto, avvisi email. */
class SupportTest extends TestCase
{
    public function test_percorso_completo_richiesta_risposta_e_visibilita(): void
    {
        $this->createUser('staff@rq.test', 'Supporto', true);
        $c = $this->createCompany('Trattoria Aiuto');
        $this->addMember($c, $this->createUser('admin@aiuto.test', 'Anna'), 'admin');
        $this->addMember($c, $this->createUser('cuoco@aiuto.test', 'Carlo'), 'operator');
        $this->addMember($c, $this->createUser('cuoca@aiuto.test', 'Carla'), 'operator');
        $other = $this->createCompany('Altra');
        $this->addMember($other, $this->createUser('x@altra.test', 'X'), 'admin');

        $carlo = $this->loginAs('cuoco@aiuto.test');
        $info = $this->ok($carlo->get('/api/support/info'));
        $this->assertSame('+393917326882', $info['phone']);
        $this->assertArrayHasKey('ricette', $info['areas']);

        // validazione
        $bad = $carlo->post('/api/support/tickets', ['area' => 'boh', 'kind' => 'question', 'subject' => '', 'message' => '']);
        $this->assertSame(422, $bad->status);

        // richiesta con screenshot PNG
        $png = base64_decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==');
        $tmp = tempnam(sys_get_temp_dir(), 'sup');
        file_put_contents($tmp, $png);
        $outboxBefore = count(glob(storage_path('app/outbox/*')) ?: []);
        $r = $this->ok($carlo->request('POST', '/api/support/tickets', null, true, null, ['attachment' => new UploadedFile($tmp, 'schermata.png', 'image/png', null, true)], [
            'area' => 'ricette', 'kind' => 'problem', 'subject' => 'Il costo della pizza non torna', 'message' => "Ho inserito 1 kg di farina\nma il costo è zero", 'contactPhone' => '333 1234567', 'pageUrl' => '/ricette/abc',
        ]));
        $id = $r['id'];
        $this->assertGreaterThan(0, $r['number']);
        $this->assertGreaterThan($outboxBefore, count(glob(storage_path('app/outbox/*')) ?: []), 'avviso al supporto');

        $d = $this->ok($carlo->get("/api/support/tickets/{$id}"));
        $this->assertSame(['open', 'ricette', 'Ricette e semilavorati', 'problem'], [$d['status'], $d['area'], $d['areaLabel'], $d['kind']]);
        $this->assertSame('schermata.png', $d['messages'][0]['attachment']['name']);
        $this->assertArrayNotHasKey('userAgent', $d);
        $img = $carlo->get($d['messages'][0]['attachment']['url']);
        $this->assertSame(200, $img->status);

        // visibilità: collega non amministratore no, amministratore sì, altra azienda no
        $this->assertSame([], $this->ok($this->loginAs('cuoca@aiuto.test')->get('/api/support/tickets'))['data']);
        $this->assertSame(404, $this->loginAs('cuoca@aiuto.test')->get("/api/support/tickets/{$id}")->status);
        $this->assertCount(1, $this->ok($this->loginAs('admin@aiuto.test')->get('/api/support/tickets'))['data']);
        $this->assertSame(404, $this->loginAs('x@altra.test')->get("/api/support/tickets/{$id}")->status);
        $this->assertSame(404, $this->loginAs('x@altra.test')->get($d['messages'][0]['attachment']['url'])->status);
        $this->assertSame(403, $carlo->get('/api/platform/support')->status);

        // supporto: elenco, dettaglio con dati tecnici, risposta → stato «answered» e email al cliente
        $staff = $this->loginAs('staff@rq.test');
        $list = $this->ok($staff->get('/api/platform/support'));
        $this->assertSame(1, $list['counts']['open']);
        $this->assertSame('Trattoria Aiuto', $list['data'][0]['company']);
        $this->assertSame('/ricette/abc', $this->ok($staff->get("/api/platform/support/{$id}"))['pageUrl']);
        $this->ok($staff->post("/api/platform/support/{$id}/messages", ['message' => 'Manca il prezzo della farina: aggiungilo dalla scheda prodotto.']));
        $this->assertTrue($this->ok($carlo->get('/api/support/tickets'))['data'][0]['unread']);
        $d = $this->ok($carlo->get("/api/support/tickets/{$id}"));
        $this->assertSame('answered', $d['status']);
        $this->assertFalse($this->ok($carlo->get('/api/support/tickets'))['data'][0]['unread']);
        $this->assertSame('Assistenza Ricetta Quadra', $d['messages'][1]['author']);
        $mails = glob(storage_path('app/outbox/*cuoco@aiuto.test*')) ?: [];
        $this->assertNotEmpty($mails);
        $this->assertStringContainsString("/assistenza/{$id}", (string) file_get_contents(end($mails)));

        // il cliente risponde → torna «open»; poi chiude
        $this->ok($carlo->post("/api/support/tickets/{$id}/messages", ['message' => 'Grazie, risolto!']));
        $this->assertSame('open', $this->ok($carlo->get("/api/support/tickets/{$id}"))['status']);
        $this->ok($carlo->post("/api/support/tickets/{$id}/close"));
        $this->assertSame('closed', DB::table('support_tickets')->where('id', $id)->value('status'));
        $this->assertSame(0, $this->ok($staff->get('/api/platform/support'))['counts']['open']);
    }

    public function test_allegato_non_valido(): void
    {
        $c = $this->createCompany('T');
        $this->addMember($c, $this->createUser('a@t.test', 'A'), 'admin');
        $a = $this->loginAs('a@t.test');
        $tmp = tempnam(sys_get_temp_dir(), 'sup');
        file_put_contents($tmp, '<?php echo 1;');
        $r = $a->request('POST', '/api/support/tickets', null, true, null, ['attachment' => new UploadedFile($tmp, 'foto.php', 'image/png', null, true)], ['area' => 'altro', 'kind' => 'question', 'subject' => 'x', 'message' => 'y']);
        $this->assertSame(422, $r->status);
        $this->assertSame(0, DB::table('support_tickets')->count());
    }
}
