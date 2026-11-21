<?php

declare(strict_types=1);

namespace App\Services;

use App\Auth\AuthContext;
use App\Auth\Crypto;
use App\Auth\Permissions;
use App\Support\Clock;
use Illuminate\Support\Facades\DB;

/**
 * Sessioni su tabella propria (port di services/sessions.ts): il cookie contiene un token casuale,
 * il database solo il suo hash SHA-256 e l'azienda attiva.
 *
 * NUOVO: il superadmin (is_platform_admin) può rendere attiva un'azienda di cui non è membro per assistere
 * il cliente ("modalità assistenza"): opera con il ruolo admin e ogni accesso è registrato nell'audit.
 */
final class Sessions
{
    public const COOKIE = 'fc_session';

    private const TOUCH_INTERVAL_MS = 5 * 60 * 1000;

    public static function create(string $userId, int $days, ?string $activeCompanyId): string
    {
        $token = Crypto::newToken();
        DB::table('sessions')->insert([
            'token_hash' => Crypto::hashToken($token),
            'user_id' => $userId,
            'active_company_id' => $activeCompanyId,
            'created_at' => Clock::now(),
            'last_seen_at' => Clock::now(),
            'expires_at' => Clock::plusSeconds($days * 86400),
        ]);

        return $token;
    }

    public static function load(string $token): ?AuthContext
    {
        $hash = Crypto::hashToken($token);
        $row = DB::table('sessions as s')
            ->join('users as u', 'u.id', '=', 's.user_id')
            ->leftJoin('memberships as m', function ($j) {
                $j->on('m.user_id', '=', 's.user_id')->on('m.company_id', '=', 's.active_company_id')->where('m.is_active', '=', 1);
            })
            ->leftJoin('companies as c', function ($j) {
                $j->on('c.id', '=', 's.active_company_id')->whereNull('c.archived_at');
            })
            ->where('s.token_hash', $hash)
            ->first([
                's.token_hash', 's.expires_at', 's.last_seen_at', 's.active_company_id',
                'u.id as user_id', 'u.email', 'u.name', 'u.is_active', 'u.is_platform_admin',
                'm.role', 'm.extra_permissions', 'c.id as company_id', 'c.name as company_name',
            ]);
        if (! $row || ! $row->is_active || Clock::isPast($row->expires_at)) {
            return null;
        }
        if (Clock::msSince($row->last_seen_at) > self::TOUCH_INTERVAL_MS) {
            DB::table('sessions')->where('token_hash', $hash)->update(['last_seen_at' => Clock::now()]);
        }

        $isPlatformAdmin = (bool) $row->is_platform_admin;
        $user = ['id' => $row->user_id, 'email' => $row->email, 'name' => $row->name, 'isPlatformAdmin' => $isPlatformAdmin];
        if ($row->company_id && $row->role) {
            $extra = json_decode($row->extra_permissions ?? '[]', true) ?: [];

            return new AuthContext($hash, $user, ['id' => $row->company_id, 'name' => $row->company_name], $row->role, Permissions::effective($row->role, $extra));
        }
        if ($row->company_id && $isPlatformAdmin) {
            return new AuthContext($hash, $user, ['id' => $row->company_id, 'name' => $row->company_name], 'admin', Permissions::effective('admin', []), true);
        }

        return new AuthContext($hash, $user, null, null, []);
    }

    public static function destroy(string $hash): void
    {
        DB::table('sessions')->where('token_hash', $hash)->delete();
    }
}
