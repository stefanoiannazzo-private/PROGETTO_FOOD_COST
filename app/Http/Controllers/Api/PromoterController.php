<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Services\Audit;
use App\Services\Promoters;
use App\Support\AppError;
use App\Support\Clock;
use App\Support\Validation\S;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;

/**
 * NUOVO — Promotori (referral) nella console del superadmin.
 * Un promotore può essere un utente del portale oppure una persona esterna; ha un codice promo
 * che le nuove aziende indicano alla registrazione. La classifica conta le aziende presentate,
 * quelle attive (invito accettato) e quelle che usano davvero il portale (almeno una ricetta).
 */
class PromoterController extends Controller
{
    public function index(Request $req): array
    {
        $this->requirePlatformAdmin($req);
        $stats = $this->companyStats();
        $rows = DB::table('promoters as p')->leftJoin('users as u', 'u.id', '=', 'p.user_id')
            ->orderBy('p.name')->get(['p.*', 'u.name as user_name', 'u.email as user_email']);
        $memberOf = $this->companiesOfUsers($rows->pluck('user_id')->filter()->all());

        $data = $rows->map(function ($p) use ($stats, $memberOf) {
            $mine = $stats->where('promoter_id', $p->id);

            return [
                ...$this->row($p, $memberOf),
                'companies' => $mine->count(),
                'active' => $mine->where('active', true)->count(),
                'inUse' => $mine->where('inUse', true)->count(),
                'lastReferralAt' => Clock::iso($mine->max('referred_at')),
            ];
        })->sortByDesc(fn ($r) => [$r['inUse'], $r['active'], $r['companies']])->values()->all();

        return [
            'data' => $data,
            'totals' => [
                'promoters' => $rows->where('is_active', 1)->count(),
                'referred' => $stats->whereNotNull('promoter_id')->count(),
                'inUse' => $stats->whereNotNull('promoter_id')->where('inUse', true)->count(),
                'direct' => $stats->whereNull('promoter_id')->count(),
            ],
        ];
    }

    public function show(Request $req, string $id): array
    {
        $this->requirePlatformAdmin($req);
        $id = $this->uuid($id);
        $p = DB::table('promoters as p')->leftJoin('users as u', 'u.id', '=', 'p.user_id')->where('p.id', $id)->first(['p.*', 'u.name as user_name', 'u.email as user_email']);
        if (! $p) {
            throw AppError::notFound('Promotore');
        }
        $companies = $this->companyStats()->where('promoter_id', $id)->sortByDesc('referred_at')->map(fn ($c) => [
            'id' => $c['id'], 'name' => $c['name'], 'code' => $c['promo_code'], 'via' => $c['referred_via'],
            'referredAt' => Clock::iso($c['referred_at']), 'archived' => $c['archived'],
            'active' => $c['active'], 'inUse' => $c['inUse'], 'recipes' => $c['recipes'],
        ])->values()->all();

        return [...$this->row($p, $this->companiesOfUsers($p->user_id ? [$p->user_id] : [])), 'referredCompanies' => $companies];
    }

    public function store(Request $req): array
    {
        $auth = $this->requirePlatformAdmin($req);
        $body = $this->parseBody($req, $this->schema(false));
        $user = $this->linkedUser($body['userId'] ?? null);
        $name = $body['name'] ?? $user?->name;
        if (! $name) {
            $msg = 'Indica il nome del promotore.';
            throw new AppError(422, 'validation_failed', $msg, ['fields' => ['name' => $msg]]);
        }
        $code = ($body['code'] ?? '') !== '' ? $this->checkCode($body['code']) : Promoters::suggest($name);
        $id = (string) Str::uuid();
        DB::table('promoters')->insert([
            'id' => $id, 'code' => $code, 'name' => $name,
            'email' => $body['email'] ?? $user?->email, 'phone' => $body['phone'] ?? null,
            'user_id' => $user?->id, 'notes' => $body['notes'] ?? null, 'is_active' => 1,
            'created_by' => $auth->userId(), 'created_at' => Clock::now(),
        ]);
        Audit::log(null, $auth->userId(), 'promoter', $id, 'created', ['code' => $code, 'name' => $name]);

        return ['id' => $id, 'code' => $code, 'name' => $name];
    }

    public function update(Request $req, string $id): array
    {
        $auth = $this->requirePlatformAdmin($req);
        $id = $this->uuid($id);
        $p = DB::table('promoters')->where('id', $id)->first();
        if (! $p) {
            throw AppError::notFound('Promotore');
        }
        $body = $this->parseBody($req, $this->schema(true));
        $set = [];
        foreach (['name' => 'name', 'email' => 'email', 'phone' => 'phone', 'notes' => 'notes'] as $k => $col) {
            if (array_key_exists($k, $body)) {
                $set[$col] = $body[$k];
            }
        }
        if (array_key_exists('userId', $body)) {
            $set['user_id'] = $this->linkedUser($body['userId'])?->id;
        }
        if (array_key_exists('isActive', $body)) {
            $set['is_active'] = $body['isActive'] ? 1 : 0;
        }
        if (isset($body['code']) && $body['code'] !== '' && Promoters::normalize($body['code']) !== $p->code) {
            $set['code'] = $this->checkCode($body['code'], $id);
        }
        if (array_key_exists('name', $set) && ! $set['name']) {
            $msg = 'Indica il nome del promotore.';
            throw new AppError(422, 'validation_failed', $msg, ['fields' => ['name' => $msg]]);
        }
        if ($set) {
            DB::table('promoters')->where('id', $id)->update($set);
            Audit::log(null, $auth->userId(), 'promoter', $id, 'updated', array_keys($set));
        }

        return ['ok' => true];
    }

    /** Utenti del portale da collegare a un promotore (ricerca per nome o email). */
    public function users(Request $req): array
    {
        $this->requirePlatformAdmin($req);
        $q = trim((string) $req->query('q', ''));
        $rows = DB::table('users')->where('is_active', 1)
            ->when($q !== '', fn ($w) => $w->where(fn ($x) => $x->where('name', 'like', '%'.addcslashes($q, '%_\\').'%')->orWhere('email', 'like', '%'.addcslashes($q, '%_\\').'%')))
            ->orderBy('name')->limit(20)->get(['id', 'name', 'email']);
        $memberOf = $this->companiesOfUsers($rows->pluck('id')->all());
        $taken = DB::table('promoters')->whereIn('user_id', $rows->pluck('id'))->pluck('code', 'user_id');

        return ['data' => $rows->map(fn ($u) => [
            'id' => $u->id, 'name' => $u->name, 'email' => $u->email,
            'companies' => $memberOf[$u->id] ?? [], 'promoterCode' => $taken[$u->id] ?? null,
        ])->all()];
    }

    /* ------------------------------------------------------------------ */

    private function schema(bool $partial): \App\Support\Validation\Schema
    {
        $opt = fn ($s) => $s->nullable()->optional();

        return S::object([
            'name' => S::string()->trim()->max(120)->nullable()->optional(),
            'email' => $opt(S::string()->trim()->toLowerCase()->max(254)->refine(fn ($v) => $v === '' || filter_var($v, FILTER_VALIDATE_EMAIL) !== false, 'Email non valida.')),
            'phone' => $opt(S::string()->trim()->max(40)),
            'notes' => $opt(S::string()->trim()->max(2000)),
            'userId' => $opt(S::uuid()),
            'code' => $opt(S::string()->trim()->max(40)),
            'isActive' => S::bool()->optional(),
        ]);
    }

    private function checkCode(string $raw, ?string $exceptId = null): string
    {
        $code = Promoters::normalize($raw);
        if (! preg_match(Promoters::CODE_PATTERN, $code)) {
            $msg = 'Il codice deve avere da 4 a 24 caratteri: lettere, numeri e trattino.';
            throw new AppError(422, 'validation_failed', $msg, ['fields' => ['code' => $msg]]);
        }
        if (DB::table('promoters')->where('code', $code)->when($exceptId, fn ($q) => $q->where('id', '<>', $exceptId))->exists()) {
            $msg = 'Questo codice è già usato da un altro promotore.';
            throw new AppError(422, 'validation_failed', $msg, ['fields' => ['code' => $msg]]);
        }

        return $code;
    }

    private function linkedUser(?string $userId): ?object
    {
        if (! $userId) {
            return null;
        }
        $u = DB::table('users')->where('id', $userId)->first(['id', 'name', 'email']);
        if (! $u) {
            throw AppError::notFound('Utente');
        }

        return $u;
    }

    /** Aziende (attive) di cui ciascun utente è membro. */
    private function companiesOfUsers(array $userIds): array
    {
        if (! $userIds) {
            return [];
        }

        return DB::table('memberships as m')->join('companies as c', 'c.id', '=', 'm.company_id')
            ->whereIn('m.user_id', $userIds)->where('m.is_active', 1)->whereNull('c.archived_at')
            ->orderBy('c.name')->get(['m.user_id', 'c.name'])->groupBy('user_id')
            ->map(fn ($g) => $g->pluck('name')->all())->all();
    }

    private function row(object $p, array $memberOf): array
    {
        return [
            'id' => $p->id, 'code' => $p->code, 'name' => $p->name, 'email' => $p->email, 'phone' => $p->phone,
            'notes' => $p->notes, 'isActive' => (bool) $p->is_active, 'createdAt' => Clock::iso($p->created_at),
            'user' => $p->user_id ? ['id' => $p->user_id, 'name' => $p->user_name, 'email' => $p->user_email, 'companies' => $memberOf[$p->user_id] ?? []] : null,
        ];
    }

    /** Ogni azienda con promotore, stato d'uso e numero di ricette. */
    private function companyStats(): \Illuminate\Support\Collection
    {
        $members = DB::table('memberships')->where('is_active', 1)->groupBy('company_id')->selectRaw('company_id, count(*) as n')->pluck('n', 'company_id');
        $recipes = DB::table('recipes')->where('status', '<>', 'archived')->groupBy('company_id')->selectRaw('company_id, count(*) as n')->pluck('n', 'company_id');

        return DB::table('companies')->get(['id', 'name', 'archived_at', 'promoter_id', 'promo_code', 'referred_via', 'referred_at'])->map(function ($c) use ($members, $recipes) {
            $active = $c->archived_at === null && (int) ($members[$c->id] ?? 0) > 0;

            return [
                'id' => $c->id, 'name' => $c->name, 'archived' => $c->archived_at !== null,
                'promoter_id' => $c->promoter_id, 'promo_code' => $c->promo_code, 'referred_via' => $c->referred_via, 'referred_at' => $c->referred_at,
                'active' => $active, 'recipes' => (int) ($recipes[$c->id] ?? 0), 'inUse' => $active && (int) ($recipes[$c->id] ?? 0) > 0,
            ];
        });
    }
}
