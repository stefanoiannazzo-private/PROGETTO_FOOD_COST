<?php

declare(strict_types=1);

namespace App\Http\Controllers\Api;

use App\Auth\Crypto;
use App\Auth\Permissions;
use App\Http\Controllers\Controller;
use App\Services\Audit;
use App\Services\Mailer;
use App\Support\AppError;
use App\Support\Clock;
use App\Support\RateLimit;
use App\Support\Row;
use App\Support\Validation\S;
use App\Support\Validation\Schema;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Log;
use Illuminate\Support\Str;

/** Utenti, ruoli e inviti dell'azienda (port di apps/api/src/routes/users.ts). */
final class UserController extends Controller
{
    private static function extraPermissions(): Schema
    {
        return S::array(S::enum(Permissions::GRANTABLE))->default([]);
    }

    /** Catalogo di ruoli e permessi per la UI. */
    public function catalog(Request $req): array
    {
        $this->requireCompany($req);

        return [
            'roles' => array_map(fn ($r) => ['value' => $r, 'label' => Permissions::ROLE_LABELS[$r], 'permissions' => $r === 'admin' ? Permissions::all() : Permissions::ROLE_PERMISSIONS[$r]], Permissions::ROLES),
            'permissions' => array_map(fn ($v, $l) => ['value' => $v, 'label' => $l, 'grantable' => in_array($v, Permissions::GRANTABLE, true)], array_keys(Permissions::PERMISSIONS), Permissions::PERMISSIONS),
        ];
    }

    public function index(Request $req): array
    {
        $ctx = $this->requireCompany($req, 'users.manage');
        $rows = DB::table('memberships as m')->join('users as u', 'u.id', '=', 'm.user_id')
            ->where('m.company_id', $ctx->companyId())->orderBy('u.name')
            ->get(['m.id', 'm.role', 'm.extra_permissions', 'm.is_active', 'm.created_at', 'u.id as user_id', 'u.name', 'u.email', 'u.last_login_at', 'u.is_active as user_active']);
        $invitations = DB::table('invitations')->where('company_id', $ctx->companyId())->whereNull('accepted_at')->orderByDesc('created_at')
            ->get(['id', 'email', 'name', 'role', 'expires_at', 'created_at']);

        return [
            'data' => $rows->map(fn ($r) => [
                'id' => $r->id,
                'userId' => $r->user_id,
                'name' => $r->name,
                'email' => $r->email,
                'role' => $r->role,
                'roleLabel' => Permissions::ROLE_LABELS[$r->role],
                'extraPermissions' => json_decode($r->extra_permissions, true) ?: [],
                'isActive' => (bool) $r->is_active && (bool) $r->user_active,
                'lastLoginAt' => Clock::iso($r->last_login_at),
                'isSelf' => $r->user_id === $ctx->userId(),
            ])->all(),
            'invitations' => $invitations->map(fn ($i) => [...Row::one($i), 'roleLabel' => Permissions::ROLE_LABELS[$i->role], 'expired' => Clock::isPast($i->expires_at)])->all(),
        ];
    }

    public function invite(Request $req): array
    {
        $ctx = $this->requireCompany($req, 'users.manage');
        RateLimit::hit('invite', (string) $req->ip(), 30, 3600);
        $body = $this->parseBody($req, S::object([
            'email' => S::string()->trim()->toLowerCase()->refine(fn ($v) => filter_var($v, FILTER_VALIDATE_EMAIL) !== false, 'Email non valida.'),
            'name' => S::string()->trim()->min(2)->max(120),
            'role' => S::enum(Permissions::ROLES),
            'extraPermissions' => self::extraPermissions(),
        ]));
        $cid = $ctx->companyId();
        $already = DB::table('memberships as m')->join('users as u', 'u.id', '=', 'm.user_id')
            ->where('m.company_id', $cid)->where('u.email', $body['email'])->where('m.is_active', 1)->exists();
        if ($already) {
            throw AppError::conflict('already_member', 'Questo utente fa già parte dell’azienda.');
        }

        return self::createInvitation($cid, $ctx->company['name'], $ctx->userId(), $ctx->user['name'], $body['email'], $body['name'], $body['role'], $body['extraPermissions']);
    }

    /** Invia l'email di invito con il link. @return 'sent'|'outbox' */
    public static function sendInviteMail(string $email, string $companyName, string $byName, string $role, string $link): string
    {
        return Mailer::send($email, "Invito a Food Cost — {$companyName}", "{$byName} ti ha invitato su Food Cost per {$companyName} come ".Permissions::ROLE_LABELS[$role].".\nAccetta l’invito entro 7 giorni:\n{$link}\n");
    }

    /**
     * Crea un invito e prova a inviarlo; se l'email non parte, chi invita riceve il link da consegnare.
     * NUOVO: $send = false crea solo il link (mail 'skipped'); $returnLink = true lo restituisce sempre (console superadmin).
     */
    public static function createInvitation(string $companyId, string $companyName, string $byId, string $byName, string $email, string $name, string $role, array $extra, bool $send = true, bool $returnLink = false): array
    {
        $token = Crypto::newToken();
        $id = (string) Str::uuid();
        DB::table('invitations')->insert([
            'id' => $id, 'company_id' => $companyId, 'email' => $email, 'name' => $name, 'role' => $role,
            'extra_permissions' => json_encode(array_values($extra)), 'token_hash' => Crypto::hashToken($token),
            'invited_by' => $byId, 'expires_at' => Clock::plusSeconds(7 * 86400), 'created_at' => Clock::now(),
        ]);
        $link = config('foodcost.app_url')."/invito?token={$token}";
        $mail = 'skipped';
        if ($send) {
            try {
                $mail = self::sendInviteMail($email, $companyName, $byName, $role, $link);
            } catch (\Throwable $e) {
                Log::error('invio email di invito non riuscito', ['err' => $e->getMessage()]);
                $mail = 'failed';
            }
        }
        Audit::log($companyId, $byId, 'invitation', $id, 'created', ['email' => $email, 'role' => $role]);
        $out = ['id' => $id, 'mail' => $mail];
        if ($returnLink || $mail !== 'sent' || config('foodcost.dev_expose_tokens')) {
            $out['inviteLink'] = $link;
        }

        return $out;
    }

    public function deleteInvitation(Request $req, string $id): array
    {
        $ctx = $this->requireCompany($req, 'users.manage');
        $id = $this->uuid($id);
        $n = DB::table('invitations')->where('id', $id)->where('company_id', $ctx->companyId())->whereNull('accepted_at')->delete();
        if (! $n) {
            throw AppError::notFound('Invito');
        }

        return ['ok' => true];
    }

    /** Modifica ruolo, permessi aggiuntivi o stato di una membership. */
    public function update(Request $req, string $id): array
    {
        $ctx = $this->requireCompany($req, 'users.manage');
        $id = $this->uuid($id);
        $body = $this->parseBody($req, S::object([
            'role' => S::enum(Permissions::ROLES)->optional(),
            'extraPermissions' => self::extraPermissions()->optional(),
            'isActive' => S::bool()->optional(),
        ]));
        $cid = $ctx->companyId();

        return DB::transaction(function () use ($ctx, $body, $cid, $id) {
            $m = DB::table('memberships')->where('id', $id)->where('company_id', $cid)->lockForUpdate()->first();
            if (! $m) {
                throw AppError::notFound('Utente');
            }
            $nextRole = $body['role'] ?? $m->role;
            $nextActive = $body['isActive'] ?? (bool) $m->is_active;
            if ($m->role === 'admin' && ($nextRole !== 'admin' || ! $nextActive)) {
                $admins = DB::table('memberships')->where('company_id', $cid)->where('role', 'admin')->where('is_active', 1)->count();
                if ($admins <= 1) {
                    throw AppError::conflict('last_admin', 'Deve restare almeno un amministratore attivo.');
                }
            }
            DB::table('memberships')->where('id', $id)->update([
                'role' => $nextRole,
                'extra_permissions' => array_key_exists('extraPermissions', $body) ? json_encode(array_values($body['extraPermissions'])) : $m->extra_permissions,
                'is_active' => $nextActive ? 1 : 0,
            ]);
            if (! $nextActive) {
                // la disattivazione chiude subito le sessioni aperte su questa azienda
                DB::table('sessions')->where('user_id', $m->user_id)->where('active_company_id', $cid)->delete();
            }
            Audit::log($cid, $ctx->userId(), 'membership', $id, 'updated', $body);

            return ['ok' => true];
        });
    }
}
