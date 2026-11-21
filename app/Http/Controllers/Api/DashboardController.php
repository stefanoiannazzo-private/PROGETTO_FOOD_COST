<?php

declare(strict_types=1);

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Services\Costing;
use App\Support\Clock;
use App\Support\Row;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;

/** Cruscotto (port di apps/api/src/routes/dashboard.ts). */
final class DashboardController extends Controller
{
    public function show(Request $req): array
    {
        $ctx = $this->requireCompany($req, 'recipes.read');
        $t = Clock::today();
        $c = $ctx->companyId();
        $count = fn (string $table) => DB::table($table)->where('company_id', $c)->whereNull('archived_at')->count();
        $recipeCounts = DB::table('recipes')->where('company_id', $c)->groupBy('status')->selectRaw('status, count(*) as n')->pluck('n', 'status')->map(fn ($n) => (int) $n)->all();

        $costs = null;
        if ($ctx->can('costs.read')) {
            $ids = DB::table('recipes')->where('company_id', $c)->where('status', '<>', 'archived')->whereNotNull('current_revision_id')->pluck('id')->all();
            $vals = Costing::currentValuations($c, $ids, $t);
            $titles = DB::table('recipes')->where('company_id', $c)->where('status', '<>', 'archived')->get(['id', 'code', 'title', 'status']);
            $incomplete = [];
            foreach ($titles as $r) {
                $v = $vals[$r->id] ?? null;
                if (! $v || $v['complete']) {
                    continue;
                }
                $errors = array_values(array_filter($v['issues'], fn ($i) => $i['severity'] === 'error'));
                $incomplete[] = [
                    'id' => $r->id,
                    'code' => $r->code,
                    'title' => $r->title,
                    'status' => $r->status,
                    'total' => $v['total'],
                    'issues' => array_map(fn ($i) => ['code' => $i['code'], 'message' => $i['message'], 'path' => $i['path']], array_slice($errors, 0, 3)),
                    'errorCount' => count($errors),
                ];
            }
            usort($incomplete, fn ($a, $b) => $b['errorCount'] <=> $a['errorCount']);
            $missingPrices = DB::table('ingredients as i')->where('i.company_id', $c)->whereNull('i.archived_at')
                ->whereNotExists(fn ($q) => $q->selectRaw('1')->from('ingredient_prices as p')->whereColumn('p.ingredient_id', 'i.id')->where('p.valid_from', '<=', $t))
                ->count();
            $recentPrices = DB::table('ingredient_prices as p')->join('ingredients as i', 'i.id', '=', 'p.ingredient_id')
                ->where('p.company_id', $c)->orderByDesc('p.created_at')->limit(5)
                ->get(['i.id', 'i.name', 'p.package_price', 'p.valid_from', 'p.created_at']);
            $costs = ['incompleteCount' => count($incomplete), 'incomplete' => array_slice($incomplete, 0, 10), 'missingPrices' => $missingPrices, 'recentPrices' => Row::all($recentPrices)];
        }
        $recentRecipes = DB::table('recipes')->where('company_id', $c)->where('status', '<>', 'archived')->orderByDesc('updated_at')->limit(6)
            ->get(['id', 'code', 'title', 'status', 'updated_at']);

        return [
            'date' => $t,
            'counts' => [
                'ingredients' => $count('ingredients'),
                'equipment' => $count('equipment'),
                'employees' => $ctx->can('employees.read') ? $count('employees') : null,
                'recipes' => $recipeCounts ?: new \stdClass,
            ],
            'costs' => $costs,
            'recentRecipes' => Row::all($recentRecipes),
        ];
    }
}
