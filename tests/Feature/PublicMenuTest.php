<?php

namespace Tests\Feature;

use Illuminate\Support\Facades\DB;
use Tests\TestCase;

/** NUOVO — menu digitale pubblico: modalità, registrazione con privacy, omaggio e verifica del cameriere. */
class PublicMenuTest extends TestCase
{
    private string $company;

    private array $s;

    protected function setUp(): void
    {
        parent::setUp();
        $this->company = $this->createCompany('Osteria');
        $this->addMember($this->company, $this->createUser('admin@m.test', 'Admin'), 'admin');
        $this->addMember($this->company, $this->createUser('cam@m.test', 'Cam'), 'waiter');
        $a = $this->loginAs('admin@m.test');
        $sec = $this->ok($a->post('/api/orders/setup/sections', ['name' => 'Primi']))['id'];
        $r = $this->ok($a->post('/api/recipes', ['title' => 'Cacio e pepe', 'status' => 'active', 'revision' => ['components' => []]]))['id'];
        $this->ok($a->post('/api/orders/setup/items', ['sectionId' => $sec, 'sourceType' => 'recipe', 'recipeId' => $r, 'price' => '11', 'description' => 'Pecorino romano']));
        $r2 = $this->ok($a->post('/api/recipes', ['title' => 'Piatto segreto', 'status' => 'active', 'revision' => ['components' => []]]))['id'];
        $this->ok($a->post('/api/orders/setup/items', ['sectionId' => $sec, 'sourceType' => 'recipe', 'recipeId' => $r2, 'price' => '20', 'isPublic' => false]));
        $this->ok($a->post('/api/orders/setup/tables', ['label' => '7', 'seats' => 4]));
        $this->s = $this->ok($a->get('/api/orders/setup'));
    }

    private function token(): string
    {
        return $this->s['settings']['publicToken'];
    }

    public function test_menu_libero_e_per_tavolo_senza_dati_interni(): void
    {
        $m = $this->ok($this->client()->get('/api/public/menu/'.$this->token()));
        $this->assertSame(['Osteria', false], [$m['company'], $m['locked']]);
        $this->assertSame([['Cacio e pepe', '11.00', 'Pecorino romano']], array_map(fn ($i) => [$i['name'], $i['price'], $i['description']], $m['sections'][0]['items']));
        $raw = json_encode($m);
        $this->assertStringNotContainsString('segreto', $raw);
        $this->assertStringNotContainsString('unitCost', $raw);
        $qr = basename($this->s['tables'][0]['qrUrl']);
        $this->assertSame('7', $this->ok($this->client()->get('/api/public/menu/t/'.$qr))['table']);
        $this->assertSame(404, $this->client()->get('/api/public/menu/inesistente')->status);
    }

    public function test_registrazione_obbligatoria_e_facoltativa_con_omaggio(): void
    {
        $a = $this->loginAs('admin@m.test');
        $this->ok($a->put('/api/orders/setup/settings', ['publicMode' => 'required', 'coverCharge' => '0']));
        $c = $this->client();
        $m = $this->ok($c->get('/api/public/menu/'.$this->token()));
        $this->assertSame([true, []], [$m['locked'], $m['sections']]);
        $bad = $c->post('/api/public/menu/'.$this->token().'/guests', ['firstName' => 'Lia', 'lastName' => 'Neri', 'email' => 'lia@example.test', 'phone' => '333 1234567', 'privacyOk' => false]);
        $this->assertSame(422, $bad->status);
        $g = $this->ok($c->post('/api/public/menu/'.$this->token().'/guests', ['firstName' => 'Lia', 'lastName' => 'Neri', 'email' => 'lia@example.test', 'phone' => '333 1234567', 'privacyOk' => true]));
        $this->assertNull($g['gift']);
        $open = $c->request('GET', '/api/public/menu/'.$this->token(), null, true, null, [], [], ['X-Guest-Token' => $g['guestToken']]);
        $this->assertFalse($open->body['locked'] ?? true);

        $this->ok($a->put('/api/orders/setup/settings', ['publicMode' => 'optional', 'giftText' => 'Caffè offerto', 'coverCharge' => '0']));
        $this->assertFalse($this->ok($this->client()->get('/api/public/menu/'.$this->token()))['locked'], 'facoltativa: il menu si vede subito');
        $g2 = $this->ok($this->client()->post('/api/public/menu/'.$this->token().'/guests', ['firstName' => 'Ugo', 'lastName' => 'Bassi', 'email' => 'ugo@example.test', 'phone' => '+39 333 7654321', 'privacyOk' => true, 'marketing' => true]));
        $this->assertSame('Caffè offerto', $g2['gift']['text']);

        // il cameriere verifica e consegna l'omaggio
        $cam = $this->loginAs('cam@m.test');
        $chk = $this->ok($cam->post('/api/orders/gifts/redeem', ['code' => strtolower($g2['gift']['code'])]));
        $this->assertSame(['Ugo Bassi', false], [$chk['name'], $chk['alreadyRedeemed']]);
        $this->ok($cam->post('/api/orders/gifts/redeem', ['code' => $g2['gift']['code'], 'confirm' => true]));
        $this->assertTrue($this->ok($cam->post('/api/orders/gifts/redeem', ['code' => $g2['gift']['code']]))['alreadyRedeemed']);

        // l'elenco clienti lo vede solo chi configura
        $this->assertSame(403, $cam->get('/api/orders/setup/guests')->status);
        $list = $this->ok($a->get('/api/orders/setup/guests'));
        $this->assertSame([2, true], [$list['total'], $list['data'][0]['marketing']]);
    }

    public function test_menu_spento(): void
    {
        $this->ok($this->loginAs('admin@m.test')->put('/api/orders/setup/settings', ['publicMode' => 'off', 'coverCharge' => '0']));
        $m = $this->ok($this->client()->get('/api/public/menu/'.$this->token()));
        $this->assertSame([true, []], [$m['locked'], $m['sections']]);
        $this->assertSame(409, $this->client()->post('/api/public/menu/'.$this->token().'/guests', ['firstName' => 'A', 'lastName' => 'B', 'email' => 'a@b.it', 'phone' => '3331234567', 'privacyOk' => true])->status);
    }
}
