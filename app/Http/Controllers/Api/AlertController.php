<?php

declare(strict_types=1);

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Services\ChangeAlerts;
use App\Support\AppError;
use App\Support\Validation\S;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;

/**
 * NUOVO — Avvisi di variazione dei costi: ricette e prodotti cambiati dall'ultima volta che l'utente li ha aperti.
 * Visibili solo a chi vede i costi.
 */
final class AlertController extends Controller
{
    public function index(Request $req): array
    {
        $ctx = $this->requireCompany($req, 'recipes.read');
        if (! $ctx->can('costs.read')) {
            return ['recipes' => [], 'ingredients' => []];
        }

        return ChangeAlerts::unseen($ctx->companyId(), $ctx->userId());
    }

    public function seen(Request $req): array
    {
        $ctx = $this->requireCompany($req, 'recipes.read');
        $b = $this->parseBody($req, S::object([
            'type' => S::enum(['recipe', 'ingredient']),
            'id' => S::uuid()->optional(),
        ]));
        $cid = $ctx->companyId();
        if (! isset($b['id'])) {
            return ['ok' => true, 'count' => ChangeAlerts::markAllSeen($ctx->userId(), $cid, $b['type'])];
        }
        $table = $b['type'] === 'recipe' ? 'recipes' : 'ingredients';
        if (! DB::table($table)->where('id', $b['id'])->where('company_id', $cid)->exists()) {
            throw AppError::notFound($b['type'] === 'recipe' ? 'Ricetta' : 'Prodotto');
        }
        ChangeAlerts::markSeen($ctx->userId(), $cid, $b['type'], $b['id']);

        return ['ok' => true];
    }
}
