<?php

declare(strict_types=1);

namespace App\Http\Controllers\Api;

use App\Auth\AuthContext;
use App\Auth\Crypto;
use App\Auth\Permissions;
use App\Http\Controllers\Controller;
use App\Services\Audit;
use App\Services\Promoters;
use App\Services\Mailer;
use App\Services\Sessions;
use App\Support\AppError;
use App\Support\Clock;
use App\Support\RateLimit;
use App\Support\Validation\S;
use App\Support\Validation\Schema;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Log;
use Illuminate\Support\Str;
use Symfony\Component\HttpFoundation\Cookie;

/** Accesso, sessione, password e inviti (port di apps/api/src/routes/auth.ts). */
final class AuthController extends Controller
{
    private static function password(): Schema
    {
        $min = Crypto::PASSWORD_MIN_LENGTH;

        return S::string()->min($min, "La password deve avere almeno {$min} caratteri.")->max(200);
    }

    public static function sessionCookie(string $token): Cookie
    {
        $days = config('foodcost.session_days');

        return Cookie::create(Sessions::COOKIE, $token, time() + $days * 86400, '/', null, config('foodcost.cookie_secure'), true, false, Cookie::SAMESITE_LAX);
    }

    /** Dati della sessione per l'interfaccia (utente, azienda attiva, permessi, aziende disponibili). */
    public static function me(string $userId, ?AuthContext $auth): array
    {
        $companies = DB::table('memberships as m')->join('companies as c', 'c.id', '=', 'm.company_id')
            ->where('m.user_id', $userId)->where('m.is_active', 1)->whereNull('c.archived_at')
            ->orderBy('c.name')->get(['c.id', 'c.name', 'm.role']);

        return [
            'user' => $auth?->user,
            'company' => $auth?->company,
            'role' => $auth?->role,
            'roleLabel' => $auth?->role ? Permissions::ROLE_LABELS[$auth->role] : null,
            'permissions' => $auth ? $auth->permissions : [],
            'companies' => $companies->map(fn ($c) => ['id' => $c->id, 'name' => $c->name, 'role' => $c->role, 'roleLabel' => Permissions::ROLE_LABELS[$c->role]])->all(),
            // NUOVO: il superadmin che assiste un'azienda di cui non è membro
            'assist' => $auth?->assist ?? false,
            // NUOVO: tablet di servizio dell'area Ordini
            'serviceDevice' => $auth?->serviceDevice ?? false,
            // NUOVO: guida del primo accesso già vista (completata o chiusa)
            'tourDone' => DB::table('users')->where('id', $userId)->value('tour_completed_at') !== null,
        ];
    }

    /** NUOVO — registra che la guida è stata completata o chiusa (done=false la ripropone al prossimo accesso). */
    public function tour(Request $req): array
    {
        $auth = $this->requireAuth($req);
        $body = $this->parseBody($req, S::object(['done' => S::bool()]));
        DB::table('users')->where('id', $auth->userId())->update(['tour_completed_at' => $body['done'] ? Clock::now() : null]);

        return ['ok' => true, 'tourDone' => $body['done']];
    }

    public function login(Request $req): JsonResponse
    {
        RateLimit::hit('login', (string) $req->ip(), config('foodcost.login_rate_limit'), 60);
        $body = $this->parseBody($req, S::object(['email' => S::string()->trim()->toLowerCase()->min(3), 'password' => S::string()->min(1)]));
        $user = DB::table('users')->where('email', $body['email'])->first();
        // stesso messaggio per utente inesistente, disattivato o password errata
        if (! $user || ! $user->is_active || ! Crypto::verifyPassword($body['password'], $user->password_hash)) {
            throw new AppError(401, 'invalid_credentials', 'Email o password non corrette.');
        }
        $memberships = DB::table('memberships as m')->join('companies as c', 'c.id', '=', 'm.company_id')
            ->where('m.user_id', $user->id)->where('m.is_active', 1)->whereNull('c.archived_at')->pluck('m.company_id');
        $active = $memberships->count() === 1 ? $memberships[0] : null;
        $token = Sessions::create($user->id, config('foodcost.session_days'), $active);
        DB::table('users')->where('id', $user->id)->update(['last_login_at' => Clock::now()]);
        Audit::log($active, $user->id, 'user', $user->id, 'login');

        return response()->json(self::me($user->id, Sessions::load($token)))->withCookie(self::sessionCookie($token));
    }

    public function logout(Request $req): JsonResponse
    {
        if ($auth = $this->auth($req)) {
            Sessions::destroy($auth->sessionHash);
        }

        return response()->json(['ok' => true])->withCookie(Cookie::create(Sessions::COOKIE, '', 1, '/'));
    }

    public function show(Request $req): array
    {
        $auth = $this->requireAuth($req);

        return self::me($auth->userId(), $auth);
    }

    /**
     * Selezione esplicita dell'azienda attiva, verificata contro le membership.
     * NUOVO: il superadmin può selezionare qualsiasi azienda attiva (modalità assistenza, registrata nell'audit).
     */
    public function company(Request $req): array
    {
        $auth = $this->requireAuth($req);
        if ($auth->serviceDevice) {
            throw AppError::forbidden(); // NUOVO: il tablet di servizio resta sul suo locale
        }
        $body = $this->parseBody($req, S::object(['companyId' => S::uuid()]));
        $companyId = strtolower($body['companyId']);
        $m = DB::table('memberships as m')->join('companies as c', 'c.id', '=', 'm.company_id')
            ->where('m.user_id', $auth->userId())->where('m.company_id', $companyId)->where('m.is_active', 1)->whereNull('c.archived_at')
            ->first(['m.role', 'm.extra_permissions', 'c.id', 'c.name']);
        if ($m) {
            DB::table('sessions')->where('token_hash', $auth->sessionHash)->update(['active_company_id' => $companyId]);
            $extra = json_decode($m->extra_permissions, true) ?: [];

            return self::me($auth->userId(), new AuthContext($auth->sessionHash, $auth->user, ['id' => $m->id, 'name' => $m->name], $m->role, Permissions::effective($m->role, $extra)));
        }
        if ($auth->isPlatformAdmin()) {
            $c = DB::table('companies')->where('id', $companyId)->whereNull('archived_at')->first(['id', 'name']);
            if ($c) {
                DB::table('sessions')->where('token_hash', $auth->sessionHash)->update(['active_company_id' => $companyId]);
                Audit::log($companyId, $auth->userId(), 'company', $companyId, 'assist_started');

                return self::me($auth->userId(), new AuthContext($auth->sessionHash, $auth->user, ['id' => $c->id, 'name' => $c->name], 'admin', Permissions::effective('admin', []), true));
            }
        }
        throw AppError::forbidden('Non appartieni a questa azienda.');
    }

    public function changePassword(Request $req): array
    {
        $auth = $this->requireAuth($req);
        if ($auth->serviceDevice) {
            throw AppError::forbidden();
        }
        $body = $this->parseBody($req, S::object(['currentPassword' => S::string()->min(1), 'newPassword' => self::password()]));
        $hash = DB::table('users')->where('id', $auth->userId())->value('password_hash');
        if (! Crypto::verifyPassword($body['currentPassword'], $hash)) {
            throw AppError::badRequest('invalid_password', 'La password attuale non è corretta.');
        }
        DB::table('users')->where('id', $auth->userId())->update(['password_hash' => Crypto::hashPassword($body['newPassword'])]);
        // chiude le altre sessioni
        DB::table('sessions')->where('user_id', $auth->userId())->where('token_hash', '<>', $auth->sessionHash)->delete();

        return ['ok' => true];
    }

    public function forgot(Request $req): array
    {
        RateLimit::hit('forgot', (string) $req->ip(), 5, 15 * 60);
        $body = $this->parseBody($req, S::object(['email' => S::string()->trim()->toLowerCase()->min(3)]));
        $user = DB::table('users')->where('email', $body['email'])->first(['id', 'email', 'is_active']);
        $devLink = null;
        if ($user && $user->is_active) {
            $token = Crypto::newToken();
            DB::table('password_resets')->insert([
                'token_hash' => Crypto::hashToken($token), 'user_id' => $user->id,
                'expires_at' => Clock::plusSeconds(3600), 'created_at' => Clock::now(),
            ]);
            $link = config('foodcost.app_url')."/reimposta-password?token={$token}";
            try {
                Mailer::send($user->email, 'Ricetta Quadra — reimpostazione password', "Per reimpostare la password apri questo link entro 60 minuti:\n{$link}\n");
            } catch (\Throwable $e) {
                // la risposta resta identica: non si rivela se l'indirizzo esiste
                Log::error('invio email di reset non riuscito', ['err' => $e->getMessage()]);
            }
            if (config('foodcost.dev_expose_tokens')) {
                $devLink = $link;
            }
        }
        $out = ['ok' => true, 'message' => 'Se l’indirizzo è registrato riceverai un’email con le istruzioni.'];
        if ($devLink) {
            $out['devLink'] = $devLink;
        }

        return $out;
    }

    public function reset(Request $req): array
    {
        RateLimit::hit('reset', (string) $req->ip(), 10, 15 * 60);
        $body = $this->parseBody($req, S::object(['token' => S::string()->min(10), 'password' => self::password()]));
        $row = DB::table('password_resets')->where('token_hash', Crypto::hashToken($body['token']))->first();
        if (! $row || $row->used_at || Clock::isPast($row->expires_at)) {
            throw AppError::badRequest('invalid_token', 'Il link non è valido o è scaduto.');
        }
        DB::transaction(function () use ($row, $body) {
            DB::table('password_resets')->where('token_hash', $row->token_hash)->update(['used_at' => Clock::now()]);
            DB::table('users')->where('id', $row->user_id)->update(['password_hash' => Crypto::hashPassword($body['password'])]);
            DB::table('sessions')->where('user_id', $row->user_id)->delete();
        });

        return ['ok' => true];
    }

    public function invitation(Request $req, string $token): array
    {
        $inv = DB::table('invitations as i')->join('companies as c', 'c.id', '=', 'i.company_id')
            ->where('i.token_hash', Crypto::hashToken($token))
            ->first(['i.email', 'i.name', 'i.role', 'i.expires_at', 'i.accepted_at', 'i.company_id', 'c.name as company', 'c.promoter_id']);
        if (! $inv || $inv->accepted_at || Clock::isPast($inv->expires_at)) {
            throw AppError::badRequest('invalid_token', 'L’invito non è valido o è scaduto.');
        }
        $existing = DB::table('users')->where('email', mb_strtolower($inv->email))->exists();

        return ['email' => $inv->email, 'name' => $inv->name, 'company' => $inv->company, 'role' => $inv->role, 'roleLabel' => Permissions::ROLE_LABELS[$inv->role], 'existingUser' => $existing,
            'askPromo' => self::asksPromo($inv)];
    }

    /** NUOVO: il codice promo si chiede solo al primo amministratore di un'azienda appena creata e senza promotore. */
    private static function asksPromo(object $inv): bool
    {
        return $inv->role === 'admin' && $inv->promoter_id === null
            && ! DB::table('memberships')->where('company_id', $inv->company_id)->where('is_active', 1)->exists();
    }

    public function acceptInvitation(Request $req): JsonResponse
    {
        RateLimit::hit('accept', (string) $req->ip(), 10, 15 * 60);
        $body = $this->parseBody($req, S::object(['token' => S::string()->min(10), 'password' => S::string()->min(1), 'promoCode' => S::string()->trim()->max(40)->nullable()->optional()]));
        $inv = DB::table('invitations as i')->join('companies as c', 'c.id', '=', 'i.company_id')
            ->where('i.token_hash', Crypto::hashToken($body['token']))->first(['i.*', 'c.promoter_id']);
        if (! $inv || $inv->accepted_at || Clock::isPast($inv->expires_at)) {
            throw AppError::badRequest('invalid_token', 'L’invito non è valido o è scaduto.');
        }
        // NUOVO: codice promo facoltativo, controllato prima di creare l'account
        $promoter = ($body['promoCode'] ?? '') !== '' && self::asksPromo($inv) ? Promoters::require($body['promoCode']) : null;
        $existing = DB::table('users')->where('email', mb_strtolower($inv->email))->first();
        if ($existing) {
            // un utente già registrato conferma con la propria password
            if (! Crypto::verifyPassword($body['password'], $existing->password_hash)) {
                throw AppError::badRequest('invalid_password', 'Password non corretta per l’account esistente.');
            }
            $userId = $existing->id;
        } else {
            $this->parse(S::object(['password' => self::password()]), ['password' => $body['password']]);
            $userId = (string) Str::uuid();
            DB::table('users')->insert([
                'id' => $userId, 'email' => $inv->email, 'name' => $inv->name,
                'password_hash' => Crypto::hashPassword($body['password']), 'created_at' => Clock::now(),
            ]);
        }
        DB::transaction(function () use ($inv, $userId, $promoter) {
            DB::table('invitations')->where('id', $inv->id)->update(['accepted_at' => Clock::now()]);
            if ($promoter) {
                Promoters::attach($inv->company_id, $promoter, 'invite');
            }
            $m = DB::table('memberships')->where('company_id', $inv->company_id)->where('user_id', $userId)->first();
            if ($m) {
                DB::table('memberships')->where('id', $m->id)->update(['role' => $inv->role, 'extra_permissions' => $inv->extra_permissions, 'is_active' => 1]);
            } else {
                DB::table('memberships')->insert([
                    'id' => (string) Str::uuid(), 'company_id' => $inv->company_id, 'user_id' => $userId,
                    'role' => $inv->role, 'extra_permissions' => $inv->extra_permissions, 'is_active' => 1, 'created_at' => Clock::now(),
                ]);
            }
        });
        Audit::log($inv->company_id, $userId, 'membership', $userId, 'invitation_accepted', ['role' => $inv->role]);
        $token = Sessions::create($userId, config('foodcost.session_days'), $inv->company_id);

        return response()->json(self::me($userId, Sessions::load($token)))->withCookie(self::sessionCookie($token));
    }
}
