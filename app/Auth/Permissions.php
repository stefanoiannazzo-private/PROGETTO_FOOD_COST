<?php

declare(strict_types=1);

namespace App\Auth;

/** Ruoli e permessi (port di apps/api/src/auth/permissions.ts). */
final class Permissions
{
    // NUOVO: cameriere e cucina/bancone per l'area Ordini
    public const ROLES = ['admin', 'manager', 'operator', 'waiter', 'kitchen'];

    public const ROLE_LABELS = ['admin' => 'Amministratore', 'manager' => 'Responsabile', 'operator' => 'Operatore', 'waiter' => 'Cameriere', 'kitchen' => 'Cucina / Bancone', 'service' => 'Tablet di servizio'];

    public const PERMISSIONS = [
        'recipes.read' => 'Consultare ricette e schede di preparazione',
        'recipes.manage' => 'Creare e modificare ricette',
        'costs.read' => 'Consultare i costi (prezzi, costi aggregati e valorizzazioni)',
        'snapshots.create' => 'Salvare snapshot di costo',
        'ingredients.manage' => 'Gestire ingredienti e prezzi',
        'equipment.manage' => 'Gestire strumenti e macchinari',
        'tariffs.read' => 'Consultare le tariffe delle utenze',
        'tariffs.manage' => 'Modificare le tariffe delle utenze',
        'employees.read' => 'Consultare l’elenco dei dipendenti (senza retribuzioni)',
        'employees.manage' => 'Gestire i dipendenti',
        'salaries.read' => 'Leggere le retribuzioni e i costi orari nominativi',
        'imports.manage' => 'Eseguire importazioni massive',
        'users.manage' => 'Gestire utenti, ruoli e inviti',
        // NUOVO: area Ordini
        'orders.take' => 'Prendere ordini ai tavoli',
        'orders.kitchen' => 'Vedere e preparare le comande della postazione',
        'orders.manage' => 'Configurare menu, tavoli e postazioni',
        'sales.read' => 'Consultare le statistiche di vendita',
    ];

    public const ROLE_PERMISSIONS = [
        'manager' => ['recipes.read', 'recipes.manage', 'costs.read', 'snapshots.create', 'ingredients.manage', 'equipment.manage', 'tariffs.read', 'employees.read'],
        'operator' => ['recipes.read'],
        'waiter' => ['orders.take'],
        'kitchen' => ['orders.kitchen', 'recipes.read'],
    ];

    /** Permessi concedibili oltre al ruolo. */
    public const GRANTABLE = ['costs.read', 'salaries.read', 'tariffs.read', 'tariffs.manage', 'employees.read', 'employees.manage', 'imports.manage', 'ingredients.manage', 'snapshots.create', 'orders.take', 'orders.kitchen', 'orders.manage', 'sales.read'];

    public static function all(): array
    {
        return array_keys(self::PERMISSIONS);
    }

    /** @return list<string> permessi effettivi, ordinati */
    public static function effective(string $role, array $extra): array
    {
        $set = array_fill_keys($role === 'admin' ? self::all() : (self::ROLE_PERMISSIONS[$role] ?? []), true);
        foreach ($extra as $p) {
            if (in_array($p, self::GRANTABLE, true)) {
                $set[$p] = true;
            }
        }
        // la lettura dei costi è implicita in chi può salvare snapshot o leggere retribuzioni
        if (isset($set['salaries.read']) || isset($set['snapshots.create'])) {
            $set['costs.read'] = true;
        }
        if (isset($set['employees.manage'])) {
            $set['employees.read'] = true;
        }
        if (isset($set['tariffs.manage'])) {
            $set['tariffs.read'] = true;
        }
        $list = array_keys($set);
        sort($list, SORT_STRING);

        return $list;
    }
}
