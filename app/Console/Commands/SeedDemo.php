<?php

declare(strict_types=1);

namespace App\Console\Commands;

use App\Auth\Crypto;
use App\Support\Clock;
use App\Support\InternalApi;
use Illuminate\Console\Command;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;

/**
 * Dati dimostrativi SINTETICI per lo sviluppo locale (port di apps/api/src/db/seed-demo.ts).
 * Crea "Trattoria Demo" (stessi dati dell'originale: ragù → lasagna) e, per provare la console SaaS,
 * "Osteria Demo" con prodotti simili, prezzi e agenti diversi e una lasagna con un altro nome.
 * Si rifiuta di partire in produzione.
 *
 *   php artisan foodcost:seed-demo --password="una-password-locale"
 */
final class SeedDemo extends Command
{
    protected $signature = 'foodcost:seed-demo {--password=}';

    protected $description = 'Crea i dati dimostrativi (solo sviluppo)';

    public function handle(): int
    {
        if (app()->environment('production')) {
            $this->error('Il seed dimostrativo non può essere eseguito in produzione.');

            return 1;
        }
        $password = (string) ($this->option('password') ?: getenv('DEMO_PASSWORD') ?: rtrim(strtr(base64_encode(random_bytes(9)), '+/', '-_'), '='));
        if (mb_strlen($password) < 10) {
            $this->error('La password deve avere almeno 10 caratteri.');

            return 1;
        }
        if (DB::table('companies')->where('name', 'Trattoria Demo')->exists()) {
            $this->info('Dati dimostrativi già presenti (azienda "Trattoria Demo"). Nulla da fare.');

            return 0;
        }
        config(['foodcost.login_rate_limit' => 1000]);
        $hash = Crypto::hashPassword($password);
        $mk = function (string $email, string $name, bool $platform = false) use ($hash): string {
            $id = DB::table('users')->where('email', $email)->value('id');
            if ($id) {
                return $id;
            }
            $id = (string) Str::uuid();
            DB::table('users')->insert(['id' => $id, 'email' => $email, 'name' => $name, 'password_hash' => $hash, 'is_platform_admin' => $platform ? 1 : 0, 'created_at' => Clock::now()]);

            return $id;
        };
        $member = fn (string $companyId, string $userId, string $role) => DB::table('memberships')->insert([
            'id' => (string) Str::uuid(), 'company_id' => $companyId, 'user_id' => $userId, 'role' => $role, 'extra_permissions' => '[]', 'is_active' => 1, 'created_at' => Clock::now(),
        ]);

        $company = (string) Str::uuid();
        DB::table('companies')->insert(['id' => $company, 'name' => 'Trattoria Demo', 'created_at' => Clock::now()]);
        $users = [
            ['admin@demo.local', 'Anna Amministratrice', 'admin', true],
            ['responsabile@demo.local', 'Roberto Responsabile', 'manager', false],
            ['operatore@demo.local', 'Olga Operatrice', 'operator', false],
        ];
        foreach ($users as [$email, $name, $role, $platform]) {
            $member($company, $mk($email, $name, $platform), $role);
        }
        $api = new InternalApi;
        $api->call('POST', '/auth/login', ['email' => 'admin@demo.local', 'password' => $password]);

        $date = '2026-01-01';
        $ing = function (string $code, string $name, string $category, string $content, string $unit, string $usage, ?string $price, array $extra = [], string $supplier = 'Fornitore dimostrativo', ?string $agent = null) use ($api, $date): string {
            $body = ['code' => $code, 'name' => $name, 'category' => $category, 'supplier' => $supplier, 'packageContent' => $content, 'packageUnit' => $unit, 'usageUnit' => $usage, ...$extra];
            if ($price !== null) {
                $body['initialPrice'] = ['packagePrice' => $price, 'validFrom' => $date, 'source' => 'Listino dimostrativo', 'agentName' => $agent];
            }

            return $api->call('POST', '/ingredients', $body)['id'];
        };
        $I = [
            'carne' => $ing('CAR-MAC', 'Carne macinata mista', 'Carni', '1', 'kg', 'g', '9.80', [], 'Fornitore dimostrativo', 'Luca Bianchi'),
            'pomodoro' => $ing('POM-PEL', 'Pomodori pelati', 'Conserve', '2.5', 'kg', 'g', '4.50', [], 'Fornitore dimostrativo', 'Luca Bianchi'),
            'cipolla' => $ing('VER-CIP', 'Cipolle', 'Verdure', '5', 'kg', 'g', '6.00', ['edibleYieldPercent' => '85']),
            'carota' => $ing('VER-CAR', 'Carote', 'Verdure', '5', 'kg', 'g', '5.50', ['edibleYieldPercent' => '80']),
            'sedano' => $ing('VER-SED', 'Sedano', 'Verdure', '1', 'kg', 'g', '2.20', ['edibleYieldPercent' => '70']),
            'olio' => $ing('OLI-EVO', 'Olio extravergine di oliva', 'Condimenti', '5', 'l', 'ml', '42.00', ['densityKgPerL' => '0.916']),
            'vino' => $ing('VIN-ROS', 'Vino rosso da cucina', 'Bevande', '0.75', 'l', 'ml', '3.90'),
            'latte' => $ing('LAT-INT', 'Latte intero', 'Latticini', '1', 'l', 'ml', '1.35'),
            'burro' => $ing('LAT-BUR', 'Burro', 'Latticini', '1', 'kg', 'g', '11.50'),
            'farina' => $ing('FAR-00', 'Farina 00', 'Farine', '25', 'kg', 'g', '19.00'),
            'noce' => $ing('SPE-NOC', 'Noce moscata', 'Spezie', '50', 'g', 'g', '3.20'),
            'sfoglia' => $ing('PAS-SFO', 'Sfoglia fresca all’uovo', 'Pasta', '1', 'kg', 'g', '7.80'),
            'parmigiano' => $ing('LAT-PAR', 'Parmigiano Reggiano 24 mesi', 'Latticini', '1', 'kg', 'g', '21.00', [], 'Fornitore dimostrativo', 'Luca Bianchi'),
            'uova' => $ing('UOV-FRE', 'Uova fresche', 'Uova', '30', 'pz', 'pz', '9.60', ['unitWeightKg' => '0.06']),
            'sale' => $ing('SPE-SAL', 'Sale fino', 'Spezie', '1', 'kg', 'g', '0'),
            'basilico' => $ing('ERB-BAS', 'Basilico fresco', 'Erbe', '100', 'g', 'g', null),
        ];

        $luce = $api->call('POST', '/tariffs', ['name' => 'Energia elettrica laboratorio', 'kind' => 'electricity', 'unit' => 'kwh', 'firstVersion' => ['mode' => 'direct', 'pricePerUnit' => '0.28', 'validFrom' => $date]])['id'];
        $api->call('POST', "/tariffs/{$luce}/versions", [
            'mode' => 'bill', 'validFrom' => '2026-07-01', 'periodFrom' => '2026-05-01', 'periodTo' => '2026-06-30', 'consumption' => '1850', 'consumptionUnit' => 'kwh', 'vatBasis' => 'net',
            'components' => [
                ['label' => 'Spesa per la materia energia', 'amount' => '412.30', 'kind' => 'variable', 'include' => true],
                ['label' => 'Trasporto e oneri di sistema variabili', 'amount' => '128.75', 'kind' => 'variable', 'include' => true],
                ['label' => 'Quota fissa e quota potenza', 'amount' => '64.20', 'kind' => 'fixed', 'include' => false],
            ],
        ]);
        $gas = $api->call('POST', '/tariffs', ['name' => 'Gas metano cucina', 'kind' => 'gas', 'unit' => 'smc', 'firstVersion' => ['mode' => 'direct', 'pricePerUnit' => '1.15', 'validFrom' => $date, 'm3ToSmc' => '0.9667', 'smcToKwh' => '10.69']])['id'];

        $eq = fn (array $b) => $api->call('POST', '/equipment', $b)['id'];
        $E = [
            'forno' => $eq(['code' => 'FOR-01', 'name' => 'Forno combinato 10 teglie', 'category' => 'Forni', 'powerType' => 'electric', 'capacity' => '10 GN 1/1', 'electricPowerKw' => '18', 'usageCoefficient' => '0.55', 'preheatCoefficient' => '0.95', 'holdCoefficient' => '0.3', 'electricTariffId' => $luce]),
            'fornello' => $eq(['code' => 'FUO-01', 'name' => 'Fuochi a gas 6 bruciatori', 'category' => 'Fuochi', 'powerType' => 'gas', 'gasMode' => 'flow', 'gasFlowPerHour' => '0.9', 'gasFlowUnit' => 'm3', 'gasLoadFactor' => '0.6', 'gasTariffId' => $gas]),
            'planetaria' => $eq(['code' => 'PLA-01', 'name' => 'Planetaria 20 l', 'category' => 'Impastatrici', 'powerType' => 'electric', 'electricPowerKw' => '1.1', 'usageCoefficient' => '0.7', 'electricTariffId' => $luce]),
            'abbattitore' => $eq(['code' => 'ABB-01', 'name' => 'Abbattitore di temperatura', 'category' => 'Freddo', 'powerType' => 'electric', 'electricPowerKw' => '2.4', 'usageCoefficient' => '0.8', 'electricTariffId' => $luce]),
            'mattarello' => $eq(['code' => 'MAN-01', 'name' => 'Teglie e utensili manuali', 'category' => 'Manuali', 'powerType' => 'manual']),
        ];
        $P = [
            'cuoco' => $api->call('POST', '/employees', ['code' => 'DIP-001', 'firstName' => 'Marco', 'lastName' => 'Bianchi', 'jobTitle' => 'Capo cuoco', 'firstCost' => ['validFrom' => $date, 'grossMonthly' => '2600', 'contributionsMode' => 'percent', 'contributionsValue' => '32', 'otherMonthlyCosts' => '120', 'productiveHours' => '150']])['id'],
            'aiuto' => $api->call('POST', '/employees', ['code' => 'DIP-002', 'firstName' => 'Giulia', 'lastName' => 'Verdi', 'jobTitle' => 'Aiuto cuoco', 'firstCost' => ['validFrom' => $date, 'grossMonthly' => '1750', 'contributionsMode' => 'none', 'productiveHours' => '160']])['id'],
        ];

        $c = fn (string $id, string $q, string $u) => ['kind' => 'ingredient', 'ingredientId' => $id, 'quantity' => $q, 'unit' => $u];
        $ragu = $api->call('POST', '/recipes', [
            'code' => 'RAGU', 'title' => 'Ragù alla bolognese', 'category' => 'Sughi', 'status' => 'active', 'description' => 'Base per lasagne e primi piatti.',
            'revision' => [
                'finalQuantity' => '5', 'finalUnit' => 'kg', 'finalWeightKg' => '5', 'declaredDurationMinutes' => '210', 'yieldNotes' => 'Cottura lenta: evaporazione circa 30%.',
                'instructions' => 'Soffriggere le verdure nell’olio, rosolare la carne, sfumare con il vino, aggiungere il pomodoro e cuocere a fuoco basso per 3 ore. Abbattere e porzionare.',
                'phases' => [['key' => 'p1', 'name' => 'Mondatura e soffritto'], ['key' => 'p2', 'name' => 'Cottura lenta'], ['key' => 'p3', 'name' => 'Abbattimento']],
                'components' => [$c($I['carne'], '2500', 'g'), $c($I['pomodoro'], '3000', 'g'), $c($I['cipolla'], '300', 'g'), $c($I['carota'], '300', 'g'), $c($I['sedano'], '200', 'g'), $c($I['olio'], '150', 'ml'), $c($I['vino'], '375', 'ml'), $c($I['sale'], '40', 'g')],
                'equipmentUses' => [
                    ['phaseKey' => 'p1', 'equipmentId' => $E['fornello'], 'segment' => 'work', 'minutes' => '30', 'sharePercent' => '100'],
                    ['phaseKey' => 'p2', 'equipmentId' => $E['fornello'], 'segment' => 'hold', 'minutes' => '180', 'sharePercent' => '50', 'note' => 'Fuoco condiviso con il brodo'],
                    ['phaseKey' => 'p3', 'equipmentId' => $E['abbattitore'], 'segment' => 'work', 'minutes' => '90', 'sharePercent' => '100'],
                ],
                'labor' => [
                    ['phaseKey' => 'p1', 'employeeId' => $P['aiuto'], 'activeMinutes' => '35'],
                    ['phaseKey' => 'p1', 'employeeId' => $P['cuoco'], 'activeMinutes' => '15'],
                    ['phaseKey' => 'p2', 'employeeId' => $P['cuoco'], 'activeMinutes' => '20'],
                    ['phaseKey' => 'p3', 'employeeId' => $P['aiuto'], 'activeMinutes' => '10'],
                ],
            ],
        ])['id'];
        $besciamella = $api->call('POST', '/recipes', [
            'code' => 'BESC', 'title' => 'Besciamella', 'category' => 'Salse', 'status' => 'active',
            'revision' => [
                'finalQuantity' => '2.2', 'finalUnit' => 'kg', 'finalWeightKg' => '2.2', 'declaredDurationMinutes' => '25',
                'components' => [$c($I['latte'], '2', 'l'), $c($I['burro'], '120', 'g'), $c($I['farina'], '120', 'g'), $c($I['noce'], '2', 'g'), $c($I['sale'], '10', 'g')],
                'equipmentUses' => [['equipmentId' => $E['fornello'], 'segment' => 'work', 'minutes' => '20']],
                'labor' => [['employeeId' => $P['aiuto'], 'activeMinutes' => '20']],
            ],
        ])['id'];
        $lasagna = $api->call('POST', '/recipes', [
            'code' => 'LASA', 'title' => 'Lasagna alla bolognese', 'category' => 'Primi', 'status' => 'active', 'description' => 'Teglia da 12 porzioni.',
            'revision' => [
                'finalQuantity' => '1', 'finalUnit' => 'pz', 'finalWeightKg' => '3.6', 'portions' => '12', 'declaredDurationMinutes' => '75',
                'phases' => [['key' => 'a', 'name' => 'Assemblaggio'], ['key' => 'b', 'name' => 'Cottura in forno']],
                'components' => [
                    ['kind' => 'recipe', 'recipeId' => $ragu, 'quantity' => '1400', 'unit' => 'g'],
                    ['kind' => 'recipe', 'recipeId' => $besciamella, 'quantity' => '900', 'unit' => 'g'],
                    $c($I['sfoglia'], '750', 'g'), $c($I['parmigiano'], '180', 'g'), $c($I['burro'], '30', 'g'),
                ],
                'equipmentUses' => [
                    ['phaseKey' => 'a', 'equipmentId' => $E['mattarello'], 'segment' => 'work', 'minutes' => '20'],
                    ['phaseKey' => 'b', 'equipmentId' => $E['forno'], 'segment' => 'preheat', 'minutes' => '15', 'sharePercent' => '50'],
                    ['phaseKey' => 'b', 'equipmentId' => $E['forno'], 'segment' => 'work', 'minutes' => '40', 'sharePercent' => '50', 'note' => 'Forno condiviso con un’altra teglia'],
                ],
                'labor' => [['phaseKey' => 'a', 'employeeId' => $P['aiuto'], 'activeMinutes' => '25'], ['phaseKey' => 'b', 'employeeId' => $P['cuoco'], 'activeMinutes' => '5']],
            ],
        ])['id'];
        // una ricetta in bozza, volutamente incompleta, per vedere le segnalazioni
        $api->call('POST', '/recipes', [
            'code' => 'PEST', 'title' => 'Pesto al basilico (bozza)', 'category' => 'Salse',
            'revision' => ['components' => [$c($I['basilico'], '200', 'g'), ['kind' => 'ingredient', 'ingredientId' => $I['olio'], 'quantity' => null, 'unit' => 'ml']]],
        ]);
        $detail = $api->call('GET', "/recipes/{$lasagna}");
        $api->call('POST', "/recipes/{$lasagna}/snapshots", ['label' => 'Listino autunno 2026', 'expectedRevisionId' => $detail['revision']['id']]);

        /* ---------------- seconda azienda, per la console del superadmin ---------------- */
        $osteria = (string) Str::uuid();
        DB::table('companies')->insert(['id' => $osteria, 'name' => 'Osteria Demo', 'created_at' => Clock::now()]);
        $member($osteria, $mk('admin@osteria.local', 'Oscar Oste'), 'admin');
        $api2 = new InternalApi;
        $api2->call('POST', '/auth/login', ['email' => 'admin@osteria.local', 'password' => $password]);
        $ing2 = function (string $code, string $name, string $content, string $unit, string $usage, string $price, string $supplier, ?string $agent) use ($api2, $date): string {
            return $api2->call('POST', '/ingredients', ['code' => $code, 'name' => $name, 'supplier' => $supplier, 'packageContent' => $content, 'packageUnit' => $unit, 'usageUnit' => $usage,
                'initialPrice' => ['packagePrice' => $price, 'validFrom' => $date, 'source' => 'Fattura', 'agentName' => $agent]])['id'];
        };
        $J = [
            'carne' => $ing2('M01', 'Carne macinata mista', '1', 'kg', 'g', '10.40', 'Fornitore dimostrativo', 'Sara Neri'),
            'pomodoro' => $ing2('M02', 'Pomodori pelati', '2.5', 'kg', 'g', '4.20', 'Fornitore dimostrativo', 'Sara Neri'),
            'sfoglia' => $ing2('M03', 'Sfoglia fresca all’uovo', '1', 'kg', 'g', '8.30', 'Pastificio Demo', null),
            'parmigiano' => $ing2('M04', 'Parmigiano Reggiano 24 mesi', '1', 'kg', 'g', '19.90', 'Fornitore dimostrativo', 'Sara Neri'),
            'besciamella' => $ing2('M05', 'Besciamella pronta', '1', 'kg', 'g', '3.90', 'Fornitore dimostrativo', 'Sara Neri'),
        ];
        $api2->call('POST', '/recipes', [
            'code' => 'LAS-CASA', 'title' => 'Lasagne della casa', 'category' => 'Primi', 'status' => 'active',
            'revision' => [
                'finalQuantity' => '1', 'finalUnit' => 'pz', 'finalWeightKg' => '3.2', 'portions' => '10',
                'components' => [$c($J['carne'], '700', 'g'), $c($J['pomodoro'], '900', 'g'), $c($J['sfoglia'], '700', 'g'), $c($J['parmigiano'], '150', 'g'), $c($J['besciamella'], '800', 'g')],
            ],
        ]);

        $v = $detail['valuation'];
        $r2 = fn ($x) => number_format((float) $x, 2, ',', '');
        $this->newLine();
        $this->info('Dati dimostrativi creati (aziende "Trattoria Demo" e "Osteria Demo").');
        $this->line("Lasagna: {$r2($v['total'])} € a teglia, {$r2($v['costPerKg'])} €/kg, {$r2($v['costPerPortion'])} €/porzione.");
        $this->newLine();
        $this->line('Accessi locali (stessa password per tutti):');
        $this->line('  superadmin + admin  admin@demo.local');
        $this->line('  manager             responsabile@demo.local');
        $this->line('  operator            operatore@demo.local');
        $this->line('  admin (Osteria)     admin@osteria.local');
        if (! $this->option('password') && ! getenv('DEMO_PASSWORD')) {
            $this->line("  password generata: {$password}");
        }

        return 0;
    }
}
