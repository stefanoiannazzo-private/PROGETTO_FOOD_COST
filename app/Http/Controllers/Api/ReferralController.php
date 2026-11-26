<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Services\Audit;
use App\Services\Promoters;
use App\Support\AppError;
use App\Support\Clock;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;

/**
 * NUOVO — «Invita un collega» nel pannello del ristoratore: il proprio codice promo, il link da inoltrare
 * e l'elenco dei colleghi presentati con il solo stato (richiesta / invito inviato / account attivato).
 * Mai dati interni delle aziende presentate (prodotti, prezzi, ricette, utenti).
 */
class ReferralController extends Controller
{
    public function show(Request $req): array
    {
        $auth = $this->requireCompany($req);
        $p = DB::table('promoters')->where('user_id', $auth->userId())->first();

        return [
            'canCreate' => ! $p && $auth->role === 'admin' && ! $auth->assist,
            'promoter' => $p ? ['code' => $p->code, 'link' => Promoters::link($p->code), 'isActive' => (bool) $p->is_active] : null,
            'referrals' => $p ? $this->referrals($p->id) : [],
        ];
    }

    public function store(Request $req): array
    {
        $auth = $this->requireCompany($req);
        if ($auth->role !== 'admin' || $auth->assist) {
            throw AppError::forbidden();
        }
        $p = DB::table('promoters')->where('user_id', $auth->userId())->first();
        if (! $p) {
            $code = Promoters::suggest($auth->user['name']);
            $id = (string) Str::uuid();
            DB::table('promoters')->insert([
                'id' => $id, 'code' => $code, 'code_key' => Promoters::key($code), 'name' => $auth->user['name'], 'email' => $auth->user['email'],
                'user_id' => $auth->userId(), 'notes' => 'Creato dal ristoratore (azienda '.$auth->company['name'].').',
                'is_active' => 1, 'created_by' => $auth->userId(), 'created_at' => Clock::now(),
            ]);
            Audit::log($auth->companyId(), $auth->userId(), 'promoter', $id, 'created', ['code' => $code, 'by' => 'self']);
        }

        return $this->show($req);
    }

    /** Solo nome del locale, data e stato. */
    private function referrals(string $promoterId): array
    {
        $members = DB::table('memberships')->where('is_active', 1)->groupBy('company_id')->selectRaw('company_id, count(*) as n')->pluck('n', 'company_id');
        $companies = DB::table('companies')->where('promoter_id', $promoterId)->get(['id', 'name', 'archived_at', 'referred_at'])
            ->map(fn ($c) => [
                'name' => $c->name, 'date' => Clock::iso($c->referred_at),
                'status' => $c->archived_at ? 'closed' : ((int) ($members[$c->id] ?? 0) > 0 ? 'active' : 'invited'),
            ]);
        $requests = DB::table('signup_requests')->where('promoter_id', $promoterId)->whereIn('status', ['pending', 'rejected'])
            ->get(['business_name', 'status', 'created_at'])
            ->map(fn ($r) => ['name' => $r->business_name, 'date' => Clock::iso($r->created_at), 'status' => $r->status === 'pending' ? 'requested' : 'declined']);

        return $companies->concat($requests)->sortByDesc('date')->values()->all();
    }
}
