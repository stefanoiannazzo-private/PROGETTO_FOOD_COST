<?php

namespace Tests\Feature;

use App\Services\Jobs;
use App\Support\Clock;
use Illuminate\Support\Facades\DB;
use Tests\TestCase;

/** NUOVO: indirizzi per l'hosting condiviso (cron via URL e passo finale del deploy), protetti da chiave. */
class SystemTest extends TestCase
{
    public function test_cron_disattivato_senza_chiave_e_protetto(): void
    {
        config(['foodcost.cron_key' => '']);
        $this->assertSame(404, $this->client()->get('/api/cron?k=')->status);
        config(['foodcost.cron_key' => 'chiave-di-prova-lunga']);
        $this->assertSame(404, $this->client()->get('/api/cron?k=sbagliata')->status);
        $this->assertSame(404, $this->client()->get('/api/cron')->status);
    }

    public function test_cron_esegue_i_lavori_e_pulisce_le_sessioni(): void
    {
        config(['foodcost.cron_key' => 'chiave-di-prova-lunga']);
        $uid = $this->createUser('x@example.test', 'X');
        DB::table('sessions')->insert(['token_hash' => str_repeat('a', 64), 'user_id' => $uid, 'created_at' => Clock::now(), 'expires_at' => Clock::plusSeconds(-86400), 'last_seen_at' => Clock::now()]);
        Jobs::enqueue('imports.cleanup', []);
        $r = $this->ok($this->client()->get('/api/cron?k=chiave-di-prova-lunga'));
        $this->assertTrue($r['ok']);
        $this->assertGreaterThanOrEqual(1, $r['jobs']);
        $this->assertSame(0, DB::table('sessions')->count(), json_encode(DB::table('sessions')->get()));
    }

    public function test_deploy_protetto_da_chiave(): void
    {
        config(['foodcost.deploy_key' => '']);
        $this->assertSame(404, $this->client()->request('POST', '/api/system/deploy', [])->status);
        config(['foodcost.deploy_key' => 'chiave-deploy-lunga']);
        // senza chiave, con chiave errata o senza l'header dell'app: nessuna esecuzione
        $this->assertSame(404, $this->client()->request('POST', '/api/system/deploy', [])->status);
        $c = $this->client();
        $this->assertSame(403, $c->request('POST', '/api/system/deploy', [], false)->status);
        $this->assertSame(404, $this->call('POST', '/api/system/deploy', [], [], [], ['HTTP_X_REQUESTED_WITH' => 'foodcost', 'HTTP_X_DEPLOY_KEY' => 'sbagliata'])->getStatusCode());
        // il metodo GET non esiste (la SPA non intercetta /api)
        $this->assertSame(404, $this->call('GET', '/api/system/deploy', [], [], [], ['HTTP_X_DEPLOY_KEY' => 'chiave-deploy-lunga'])->getStatusCode());
    }

    public function test_primo_superadmin_senza_ssh(): void
    {
        config(['foodcost.deploy_key' => 'chiave-deploy-lunga']);
        $call = fn (array $b, string $k = 'chiave-deploy-lunga') => $this->call('POST', '/api/system/first-admin', [], [], [], ['HTTP_X_REQUESTED_WITH' => 'foodcost', 'HTTP_X_DEPLOY_KEY' => $k, 'CONTENT_TYPE' => 'application/json'], json_encode($b));
        $this->assertSame(404, $call(['email' => 'boss@example.test', 'name' => 'Boss'], 'sbagliata')->getStatusCode());
        $r = $call(['email' => 'Boss@Example.test', 'name' => 'Boss']);
        $this->assertSame(200, $r->getStatusCode(), $r->getContent());
        parse_str((string) parse_url($r->json('setPasswordLink'), PHP_URL_QUERY), $q);
        // nessuna password finché non la imposta chi riceve il link
        $this->assertSame(401, $this->client()->post('/api/auth/login', ['email' => 'boss@example.test', 'password' => 'qualsiasi-password'])->status);
        $this->ok($this->client()->post('/api/auth/password/reset', ['token' => $q['token'], 'password' => 'Password-del-boss-1']));
        $me = $this->ok($this->client()->post('/api/auth/login', ['email' => 'boss@example.test', 'password' => 'Password-del-boss-1']));
        $this->assertTrue($me['user']['isPlatformAdmin']);
        // una sola volta
        $again = $call(['email' => 'altro@example.test', 'name' => 'Altro']);
        $this->assertSame(409, $again->getStatusCode());
        $this->assertSame('already_initialized', $again->json('error.code'));
    }

    /** Hosting con cache lato server (es. Aruba HiSpeed Cache): niente in cache tra utenti, nessun CORS verso altri siti. */
    public function test_intestazioni_per_hosting_con_cache(): void
    {
        $api = $this->call('GET', '/api/health', [], [], [], ['HTTP_ORIGIN' => 'https://altro-sito.example']);
        $this->assertStringContainsString('no-store', (string) $api->headers->get('Cache-Control'));
        $this->assertNull($api->headers->get('Access-Control-Allow-Origin'));
        $this->createUser('cors@example.test', 'Cors');
        $c = $this->loginAs('cors@example.test');
        $me = $this->call('GET', '/api/auth/me', [], ['fc_session' => $c->cookie]);
        $this->assertStringContainsString('no-store', (string) $me->headers->get('Cache-Control'));
        $this->assertStringContainsString('private', (string) $me->headers->get('Cache-Control'));
        if (is_file(public_path('app/index.html'))) {
            $spa = $this->call('GET', '/ricette');
            $this->assertSame(200, $spa->getStatusCode());
            $this->assertStringContainsString('no-store', (string) $spa->headers->get('Cache-Control'));
        }
    }
}
