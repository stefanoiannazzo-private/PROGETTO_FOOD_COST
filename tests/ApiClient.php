<?php

namespace Tests;

/** Client HTTP dei test: mantiene il cookie di sessione e invia l'header CSRF dell'app (come Client in helpers.ts). */
final class ApiClient
{
    public string $cookie = '';

    public function __construct(private TestCase $t)
    {
    }

    public function request(string $method, string $url, mixed $payload = null, bool $csrf = true, ?string $origin = null, array $files = [], array $form = [], array $headers = []): ApiResponse
    {
        $server = ['HTTP_ACCEPT' => 'application/json', 'REMOTE_ADDR' => '10.0.0.1'];
        foreach ($headers as $k => $v) {
            $server['HTTP_'.strtoupper(str_replace('-', '_', $k))] = $v;
        }
        if ($csrf && $method !== 'GET') {
            $server['HTTP_X_REQUESTED_WITH'] = 'foodcost';
        }
        if ($origin) {
            $server['HTTP_ORIGIN'] = $origin;
        }
        $content = null;
        if ($payload !== null && ! $files) {
            $server['CONTENT_TYPE'] = 'application/json';
            $content = json_encode($payload);
        }
        $cookies = $this->cookie !== '' ? ['fc_session' => $this->cookie] : [];
        $res = $this->t->call($method, $url, $files ? $form : [], $cookies, $files, $server, $content);
        foreach ($res->headers->getCookies() as $c) {
            if ($c->getName() === 'fc_session') {
                $this->cookie = $c->getValue() ?? '';
            }
        }
        $raw = $res->getContent();
        $body = json_decode((string) $raw, true);

        return new ApiResponse($res->getStatusCode(), json_last_error() === JSON_ERROR_NONE ? $body : $raw, $res);
    }

    public function get(string $url): ApiResponse
    {
        return $this->request('GET', $url);
    }

    public function post(string $url, mixed $body = []): ApiResponse
    {
        return $this->request('POST', $url, $body);
    }

    public function put(string $url, mixed $body): ApiResponse
    {
        return $this->request('PUT', $url, $body);
    }

    public function patch(string $url, mixed $body): ApiResponse
    {
        return $this->request('PATCH', $url, $body);
    }

    public function del(string $url): ApiResponse
    {
        return $this->request('DELETE', $url);
    }

    public function upload(string $url, string $type, \Illuminate\Http\UploadedFile $file): ApiResponse
    {
        return $this->request('POST', $url, null, true, null, ['file' => $file], ['type' => $type]);
    }
}
