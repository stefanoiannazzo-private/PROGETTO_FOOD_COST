<?php

declare(strict_types=1);

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Services\Audit;
use App\Support\AppError;
use App\Support\Clock;
use App\Support\Validation\S;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;

/**
 * Gestione minima delle aziende (port di routes/companies.ts): l'amministratore di piattaforma crea le aziende
 * clienti e ne diventa amministratore per invitarne gli utenti. Niente registrazione pubblica.
 */
final class CompanyController extends Controller
{
    public function store(Request $req): array
    {
        $auth = $this->requireAuth($req);
        if (! $auth->isPlatformAdmin()) {
            throw AppError::forbidden('Solo l’amministratore della piattaforma può creare aziende.');
        }
        $body = $this->parseBody($req, S::object(['name' => S::string()->trim()->min(2)->max(160)]));

        return DB::transaction(function () use ($auth, $body) {
            $id = (string) Str::uuid();
            DB::table('companies')->insert(['id' => $id, 'name' => $body['name'], 'created_at' => Clock::now()]);
            DB::table('memberships')->insert([
                'id' => (string) Str::uuid(), 'company_id' => $id, 'user_id' => $auth->userId(), 'role' => 'admin',
                'extra_permissions' => '[]', 'is_active' => 1, 'created_at' => Clock::now(),
            ]);
            Audit::log($id, $auth->userId(), 'company', $id, 'created', ['name' => $body['name']]);

            return ['id' => $id, 'name' => $body['name']];
        });
    }

    public function updateCurrent(Request $req): array
    {
        $ctx = $this->requireCompany($req, 'users.manage');
        $body = $this->parseBody($req, S::object(['name' => S::string()->trim()->min(2)->max(160)]));
        DB::table('companies')->where('id', $ctx->companyId())->update(['name' => $body['name']]);
        Audit::log($ctx->companyId(), $ctx->userId(), 'company', $ctx->companyId(), 'renamed', $body);

        return ['ok' => true];
    }
}
