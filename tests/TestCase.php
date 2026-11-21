<?php

namespace Tests;

use App\Auth\Crypto;
use App\Support\Clock;
use Illuminate\Support\Facades\Artisan;
use Illuminate\Foundation\Testing\TestCase as BaseTestCase;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;

/** Base dei test (equivalente di apps/api/test/helpers.ts). */
abstract class TestCase extends BaseTestCase
{
    private static bool $migrated = false;

    public const PASSWORD = 'Password-di-prova-1';

    protected function setUp(): void
    {
        parent::setUp();
        if (! self::$migrated) {
            Artisan::call('migrate:fresh', ['--force' => true]);
            self::$migrated = true;
        }
        DB::beginTransaction();
        Cache::flush();
        config(['foodcost.login_rate_limit' => 1000, 'foodcost.dev_expose_tokens' => true, 'foodcost.import_max_rows' => 20000]);
    }

    protected function tearDown(): void
    {
        while (DB::transactionLevel() > 0) {
            DB::rollBack();
        }
        parent::tearDown();
    }

    protected function createUser(string $email, string $name, bool $platformAdmin = false): string
    {
        $id = (string) Str::uuid();
        DB::table('users')->insert(['id' => $id, 'email' => $email, 'name' => $name, 'password_hash' => Crypto::hashPassword(self::PASSWORD), 'is_platform_admin' => $platformAdmin ? 1 : 0, 'created_at' => Clock::now()]);

        return $id;
    }

    protected function createCompany(string $name): string
    {
        $id = (string) Str::uuid();
        DB::table('companies')->insert(['id' => $id, 'name' => $name, 'created_at' => Clock::now()]);

        return $id;
    }

    protected function addMember(string $companyId, string $userId, string $role, array $extra = []): void
    {
        DB::table('memberships')->insert(['id' => (string) Str::uuid(), 'company_id' => $companyId, 'user_id' => $userId, 'role' => $role, 'extra_permissions' => json_encode($extra), 'is_active' => 1, 'created_at' => Clock::now()]);
    }

    protected function client(): ApiClient
    {
        return new ApiClient($this);
    }

    protected function loginAs(string $email): ApiClient
    {
        $c = $this->client();
        $r = $c->post('/api/auth/login', ['email' => $email, 'password' => self::PASSWORD]);
        if ($r->status !== 200) {
            $this->fail("login fallito per {$email}: ".json_encode($r->body));
        }

        return $c;
    }

    /** @return array<mixed> */
    protected function ok(ApiResponse $r, int $status = 200): mixed
    {
        if ($r->status !== $status) {
            $this->fail("atteso {$status}, ricevuto {$r->status}: ".json_encode($r->body, JSON_UNESCAPED_UNICODE));
        }

        return $r->body;
    }
}
