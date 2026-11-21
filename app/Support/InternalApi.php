<?php

declare(strict_types=1);

namespace App\Support;

use Illuminate\Contracts\Http\Kernel;
use Illuminate\Http\Request;
use RuntimeException;

/**
 * Chiamate alle API dall'interno (dati dimostrativi): passano dagli stessi controlli e regole dell'interfaccia,
 * come app.inject() nel seed dell'originale.
 */
final class InternalApi
{
    private string $cookie = '';

    public function call(string $method, string $url, ?array $payload = null): array
    {
        $server = ['HTTP_X_REQUESTED_WITH' => 'foodcost', 'CONTENT_TYPE' => 'application/json', 'HTTP_ACCEPT' => 'application/json', 'REMOTE_ADDR' => '127.0.0.1'];
        $req = Request::create('/api'.$url, $method, [], $this->cookie !== '' ? ['fc_session' => $this->cookie] : [], [], $server, $payload === null ? null : json_encode($payload));
        $res = app(Kernel::class)->handle($req);
        foreach ($res->headers->getCookies() as $c) {
            if ($c->getName() === 'fc_session' && $c->getValue()) {
                $this->cookie = $c->getValue();
            }
        }
        if ($res->getStatusCode() >= 300) {
            throw new RuntimeException("{$method} {$url} → {$res->getStatusCode()} {$res->getContent()}");
        }

        return json_decode($res->getContent(), true) ?? [];
    }
}
