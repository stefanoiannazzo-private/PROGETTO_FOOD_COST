<?php

namespace App\Http\Controllers\Api;

use App\Domain\Costing\Dec;
use App\Http\Controllers\Controller;
use App\Services\Audit;
use App\Services\Costing;
use App\Support\AppError;
use App\Support\Clock;
use App\Support\Validation\S;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;

/**
 * NUOVO — Area Ordini, configurazione: postazioni (cucina, bancone…), sezioni del menu,
 * voci del menu (solo da ricette o prodotti pronti), sale e tavoli, impostazioni del menu digitale.
 */
class OrderSetupController extends Controller
{
    public const STATION_KINDS = ['kitchen', 'bar', 'other'];

    public const PUBLIC_MODES = ['off', 'open', 'required', 'optional'];

    /** Tutta la configurazione in una chiamata (pagina «Menu e sala»). */
    public function index(Request $req): array
    {
        $ctx = $this->requireCompany($req, 'orders.manage');
        $cid = $ctx->companyId();
        $showCost = $ctx->can('costs.read');
        $items = DB::table('menu_items as m')
            ->leftJoin('recipes as r', 'r.id', '=', 'm.recipe_id')
            ->leftJoin('ingredients as i', 'i.id', '=', 'm.ingredient_id')
            ->where('m.company_id', $cid)->whereNull('m.archived_at')
            ->orderBy('m.sort')->orderBy('m.name')
            ->get(['m.*', 'r.title as recipe_title', 'r.status as recipe_status', 'i.name as ingredient_name']);
        $costs = $showCost ? $this->itemCosts($cid, $items) : [];

        return [
            'stations' => DB::table('stations')->where('company_id', $cid)->orderBy('sort')->orderBy('name')->get()->map(fn ($s) => $this->stationRow($s))->all(),
            'sections' => DB::table('menu_sections')->where('company_id', $cid)->orderBy('sort')->orderBy('name')->get()->map(fn ($s) => $this->sectionRow($s))->all(),
            'items' => $items->map(fn ($m) => [...$this->itemRow($m), 'unitCost' => $showCost ? ($costs[$m->id] ?? null) : null])->all(),
            'areas' => DB::table('dining_areas')->where('company_id', $cid)->orderBy('sort')->orderBy('name')->get()->map(fn ($a) => ['id' => $a->id, 'name' => $a->name, 'sort' => (int) $a->sort])->all(),
            'tables' => DB::table('dining_tables')->where('company_id', $cid)->orderBy('sort')->get()->sortBy(fn ($t) => [(int) $t->label, $t->label])->values()->map(fn ($t) => $this->tableRow($t))->all(),
            'settings' => $this->settings($cid),
            'costsVisible' => $showCost,
        ];
    }

    /* ----------------------------- postazioni ----------------------------- */

    public function storeStation(Request $req): array
    {
        $ctx = $this->requireCompany($req, 'orders.manage');
        $b = $this->parseBody($req, $this->stationSchema());
        $id = (string) Str::uuid();
        DB::table('stations')->insert(['id' => $id, 'company_id' => $ctx->companyId(), 'name' => $b['name'], 'kind' => $b['kind'], 'sort' => $this->nextSort('stations', $ctx->companyId()), 'created_at' => Clock::now()]);
        Audit::log($ctx->companyId(), $ctx->userId(), 'station', $id, 'created', ['name' => $b['name']]);

        return ['id' => $id];
    }

    public function updateStation(Request $req, string $id): array
    {
        $ctx = $this->requireCompany($req, 'orders.manage');
        $id = $this->owned('stations', $id, $ctx->companyId());
        $b = $this->parseBody($req, $this->stationSchema(true));
        DB::table('stations')->where('id', $id)->update(['name' => $b['name'], 'kind' => $b['kind'], 'is_active' => ($b['isActive'] ?? true) ? 1 : 0]);
        Audit::log($ctx->companyId(), $ctx->userId(), 'station', $id, 'updated', ['name' => $b['name']]);

        return ['ok' => true];
    }

    public function destroyStation(Request $req, string $id): array
    {
        $ctx = $this->requireCompany($req, 'orders.manage');
        $id = $this->owned('stations', $id, $ctx->companyId());
        if (DB::table('order_items')->where('station_id', $id)->whereIn('status', ['held', 'sent', 'preparing', 'ready'])->exists()) {
            throw new AppError(409, 'station_busy', 'Questa postazione ha comande ancora aperte: chiudile prima di eliminarla.');
        }
        DB::table('stations')->where('id', $id)->delete(); // sezioni e voci restano, senza postazione
        Audit::log($ctx->companyId(), $ctx->userId(), 'station', $id, 'deleted');

        return ['ok' => true];
    }

    /* ------------------------------- sezioni ------------------------------ */

    public function storeSection(Request $req): array
    {
        $ctx = $this->requireCompany($req, 'orders.manage');
        $b = $this->parseBody($req, $this->sectionSchema());
        $this->checkStation($b['stationId'] ?? null, $ctx->companyId());
        $id = (string) Str::uuid();
        DB::table('menu_sections')->insert([
            'id' => $id, 'company_id' => $ctx->companyId(), 'name' => $b['name'], 'station_id' => $b['stationId'] ?? null,
            'is_drinks' => $b['isDrinks'] ? 1 : 0, 'is_visible' => $b['isVisible'] ? 1 : 0, 'sort' => $this->nextSort('menu_sections', $ctx->companyId()), 'created_at' => Clock::now(),
        ]);
        Audit::log($ctx->companyId(), $ctx->userId(), 'menu_section', $id, 'created', ['name' => $b['name']]);

        return ['id' => $id];
    }

    public function updateSection(Request $req, string $id): array
    {
        $ctx = $this->requireCompany($req, 'orders.manage');
        $id = $this->owned('menu_sections', $id, $ctx->companyId());
        $b = $this->parseBody($req, $this->sectionSchema());
        $this->checkStation($b['stationId'] ?? null, $ctx->companyId());
        DB::table('menu_sections')->where('id', $id)->update(['name' => $b['name'], 'station_id' => $b['stationId'] ?? null, 'is_drinks' => $b['isDrinks'] ? 1 : 0, 'is_visible' => $b['isVisible'] ? 1 : 0]);
        Audit::log($ctx->companyId(), $ctx->userId(), 'menu_section', $id, 'updated', ['name' => $b['name']]);

        return ['ok' => true];
    }

    public function destroySection(Request $req, string $id): array
    {
        $ctx = $this->requireCompany($req, 'orders.manage');
        $id = $this->owned('menu_sections', $id, $ctx->companyId());
        if (DB::table('menu_items')->where('section_id', $id)->whereNull('archived_at')->exists()) {
            throw new AppError(409, 'section_not_empty', 'La sezione contiene ancora dei piatti: spostali o toglili prima di eliminarla.');
        }
        if (DB::table('menu_items')->where('section_id', $id)->exists()) {
            DB::table('menu_sections')->where('id', $id)->update(['is_visible' => 0, 'name' => DB::raw("CONCAT(name, ' (eliminata)')")]);
        } else {
            DB::table('menu_sections')->where('id', $id)->delete();
        }
        Audit::log($ctx->companyId(), $ctx->userId(), 'menu_section', $id, 'deleted');

        return ['ok' => true];
    }

    /** Nuovo ordine di sezioni, voci, postazioni, sale o tavoli: elenco di id nell'ordine voluto. */
    public function reorder(Request $req, string $what): array
    {
        $ctx = $this->requireCompany($req, 'orders.manage');
        $table = ['sections' => 'menu_sections', 'items' => 'menu_items', 'stations' => 'stations', 'areas' => 'dining_areas', 'tables' => 'dining_tables'][$what] ?? null;
        if (! $table) {
            throw AppError::notFound();
        }
        $b = $this->parseBody($req, S::object(['ids' => S::array(S::uuid())->max(500, 'Troppi elementi.')]));
        DB::transaction(function () use ($b, $table, $ctx) {
            foreach (array_values($b['ids']) as $i => $id) {
                DB::table($table)->where('id', $id)->where('company_id', $ctx->companyId())->update(['sort' => $i + 1]);
            }
        });

        return ['ok' => true];
    }

    /* ---------------------------- voci del menu --------------------------- */

    /** Ricette e prodotti da cui creare le voci del menu. */
    public function sources(Request $req): array
    {
        $ctx = $this->requireCompany($req, 'orders.manage');
        $q = trim((string) $req->query('q', ''));
        $like = '%'.addcslashes($q, '%_\\').'%';
        $recipes = DB::table('recipes as r')->leftJoin('recipe_prices as p', 'p.recipe_id', '=', 'r.id')
            ->where('r.company_id', $ctx->companyId())->where('r.status', '<>', 'archived')
            ->when($q !== '', fn ($w) => $w->where(fn ($x) => $x->where('r.title', 'like', $like)->orWhere('r.code', 'like', $like)))
            ->orderBy('r.title')->limit(40)->get(['r.id', 'r.title', 'r.code', 'r.status', 'p.menu_price', 'p.vat_percent']);
        $ingredients = DB::table('ingredients')->where('company_id', $ctx->companyId())->whereNull('archived_at')
            ->when($q !== '', fn ($w) => $w->where(fn ($x) => $x->where('name', 'like', $like)->orWhere('code', 'like', $like)))
            ->orderBy('name')->limit(40)->get(['id', 'name', 'code', 'category', 'usage_unit', 'package_unit']);

        return [
            'recipes' => $recipes->map(fn ($r) => ['id' => $r->id, 'name' => $r->title, 'code' => $r->code, 'status' => $r->status, 'menuPrice' => $r->menu_price, 'vatPercent' => $r->vat_percent])->all(),
            'ingredients' => $ingredients->map(fn ($i) => ['id' => $i->id, 'name' => $i->name, 'code' => $i->code, 'category' => $i->category, 'unit' => $i->usage_unit ?: $i->package_unit])->all(),
        ];
    }

    public function storeItem(Request $req): array
    {
        $ctx = $this->requireCompany($req, 'orders.manage');
        $b = $this->parseBody($req, $this->itemSchema());
        $row = $this->itemData($b, $ctx->companyId());
        $id = (string) Str::uuid();
        DB::table('menu_items')->insert([...$row, 'id' => $id, 'company_id' => $ctx->companyId(), 'sort' => $this->nextSort('menu_items', $ctx->companyId()), 'created_at' => Clock::now(), 'updated_at' => Clock::now()]);
        $this->syncRecipePrice($ctx->companyId(), $row);
        Audit::log($ctx->companyId(), $ctx->userId(), 'menu_item', $id, 'created', ['name' => $row['name'], 'price' => $row['price']]);

        return ['id' => $id];
    }

    public function updateItem(Request $req, string $id): array
    {
        $ctx = $this->requireCompany($req, 'orders.manage');
        $id = $this->owned('menu_items', $id, $ctx->companyId());
        $b = $this->parseBody($req, $this->itemSchema());
        $row = $this->itemData($b, $ctx->companyId());
        DB::table('menu_items')->where('id', $id)->update([...$row, 'updated_at' => Clock::now()]);
        $this->syncRecipePrice($ctx->companyId(), $row);
        Audit::log($ctx->companyId(), $ctx->userId(), 'menu_item', $id, 'updated', ['name' => $row['name'], 'price' => $row['price']]);

        return ['ok' => true];
    }

    /** Esaurito / di nuovo disponibile: anche la cucina e il bancone possono segnarlo. */
    public function availability(Request $req, string $id): array
    {
        $ctx = $this->requireCompany($req);
        if (! $ctx->can('orders.manage') && ! $ctx->can('orders.kitchen')) {
            throw AppError::forbidden();
        }
        $id = $this->owned('menu_items', $id, $ctx->companyId());
        $b = $this->parseBody($req, S::object(['isAvailable' => S::bool()]));
        DB::table('menu_items')->where('id', $id)->update(['is_available' => $b['isAvailable'] ? 1 : 0, 'updated_at' => Clock::now()]);
        Audit::log($ctx->companyId(), $ctx->userId(), 'menu_item', $id, $b['isAvailable'] ? 'available' : 'sold_out');

        return ['ok' => true];
    }

    public function destroyItem(Request $req, string $id): array
    {
        $ctx = $this->requireCompany($req, 'orders.manage');
        $id = $this->owned('menu_items', $id, $ctx->companyId());
        DB::table('menu_items')->where('id', $id)->update(['archived_at' => Clock::now(), 'updated_at' => Clock::now()]); // lo storico delle vendite resta
        Audit::log($ctx->companyId(), $ctx->userId(), 'menu_item', $id, 'archived');

        return ['ok' => true];
    }

    /* ---------------------------- sale e tavoli --------------------------- */

    public function storeArea(Request $req): array
    {
        $ctx = $this->requireCompany($req, 'orders.manage');
        $b = $this->parseBody($req, S::object(['name' => S::reqText('Il nome della sala', 60)]));
        $id = (string) Str::uuid();
        DB::table('dining_areas')->insert(['id' => $id, 'company_id' => $ctx->companyId(), 'name' => $b['name'], 'sort' => $this->nextSort('dining_areas', $ctx->companyId()), 'created_at' => Clock::now()]);

        return ['id' => $id];
    }

    public function updateArea(Request $req, string $id): array
    {
        $ctx = $this->requireCompany($req, 'orders.manage');
        $id = $this->owned('dining_areas', $id, $ctx->companyId());
        $b = $this->parseBody($req, S::object(['name' => S::reqText('Il nome della sala', 60)]));
        DB::table('dining_areas')->where('id', $id)->update(['name' => $b['name']]);

        return ['ok' => true];
    }

    public function destroyArea(Request $req, string $id): array
    {
        $ctx = $this->requireCompany($req, 'orders.manage');
        $id = $this->owned('dining_areas', $id, $ctx->companyId());
        DB::table('dining_areas')->where('id', $id)->delete(); // i tavoli restano, senza sala

        return ['ok' => true];
    }

    /** Uno o più tavoli: label singola oppure da… a… (es. 1–20). */
    public function storeTables(Request $req): array
    {
        $ctx = $this->requireCompany($req, 'orders.manage');
        $b = $this->parseBody($req, S::object([
            'label' => S::string()->trim()->max(20)->nullable()->optional(),
            'from' => S::int(1, 999)->nullable()->optional(),
            'to' => S::int(1, 999)->nullable()->optional(),
            'seats' => S::int(1, 99),
            'areaId' => S::uuid()->nullable()->optional(),
        ]));
        $this->checkArea($b['areaId'] ?? null, $ctx->companyId());
        $labels = ($b['label'] ?? '') !== '' ? [$b['label']] : (($b['from'] ?? null) && ($b['to'] ?? null) && $b['to'] >= $b['from'] && $b['to'] - $b['from'] < 200 ? array_map('strval', range($b['from'], $b['to'])) : []);
        if (! $labels) {
            $msg = 'Indica il numero del tavolo, oppure un intervallo «da… a…».';
            throw new AppError(422, 'validation_failed', $msg, ['fields' => ['label' => $msg]]);
        }
        $taken = DB::table('dining_tables')->where('company_id', $ctx->companyId())->whereIn('label', $labels)->pluck('label')->all();
        if ($taken) {
            natsort($taken);
            $msg = (count($taken) === 1 ? 'Esiste già il tavolo ' : 'Esistono già i tavoli ').implode(', ', $taken).'.';
            throw new AppError(422, 'validation_failed', $msg, ['fields' => ['label' => $msg]]);
        }
        $sort = $this->nextSort('dining_tables', $ctx->companyId());
        $ids = [];
        foreach ($labels as $i => $label) {
            $ids[] = $id = (string) Str::uuid();
            DB::table('dining_tables')->insert(['id' => $id, 'company_id' => $ctx->companyId(), 'area_id' => $b['areaId'] ?? null, 'label' => $label, 'seats' => $b['seats'], 'sort' => $sort + $i, 'qr_token' => Str::random(24), 'created_at' => Clock::now()]);
        }
        Audit::log($ctx->companyId(), $ctx->userId(), 'dining_table', null, 'created', ['labels' => $labels]);

        return ['ids' => $ids];
    }

    public function updateTable(Request $req, string $id): array
    {
        $ctx = $this->requireCompany($req, 'orders.manage');
        $id = $this->owned('dining_tables', $id, $ctx->companyId());
        $b = $this->parseBody($req, S::object([
            'label' => S::reqText('Il numero del tavolo', 20),
            'seats' => S::int(1, 99),
            'areaId' => S::uuid()->nullable()->optional(),
            'isActive' => S::bool()->default(true),
        ]));
        $this->checkArea($b['areaId'] ?? null, $ctx->companyId());
        if (DB::table('dining_tables')->where('company_id', $ctx->companyId())->where('label', $b['label'])->where('id', '<>', $id)->exists()) {
            $msg = "Esiste già il tavolo {$b['label']}.";
            throw new AppError(422, 'validation_failed', $msg, ['fields' => ['label' => $msg]]);
        }
        DB::table('dining_tables')->where('id', $id)->update(['label' => $b['label'], 'seats' => $b['seats'], 'area_id' => $b['areaId'] ?? null, 'is_active' => $b['isActive'] ? 1 : 0]);

        return ['ok' => true];
    }

    public function destroyTable(Request $req, string $id): array
    {
        $ctx = $this->requireCompany($req, 'orders.manage');
        $id = $this->owned('dining_tables', $id, $ctx->companyId());
        if (DB::table('table_session_tables')->where('table_id', $id)->where('is_open', 1)->exists()) {
            throw new AppError(409, 'table_open', 'Il tavolo è aperto: chiudilo prima di eliminarlo.');
        }
        if (DB::table('table_session_tables')->where('table_id', $id)->exists()) {
            DB::table('dining_tables')->where('id', $id)->update(['is_active' => 0]); // ha uno storico: si disattiva
        } else {
            DB::table('dining_tables')->where('id', $id)->delete();
        }

        return ['ok' => true];
    }

    /* ---------------------------- impostazioni ---------------------------- */

    public function updateSettings(Request $req): array
    {
        $ctx = $this->requireCompany($req, 'orders.manage');
        $b = $this->parseBody($req, S::object([
            'publicMode' => S::enum(self::PUBLIC_MODES),
            'giftText' => S::optText(160),
            'coverCharge' => S::dec(['min' => 0, 'max' => 999, 'label' => 'Il coperto']),
        ]));
        if ($b['publicMode'] === 'optional' && ! ($b['giftText'] ?? null)) {
            $msg = 'Scrivi l’omaggio per chi si registra (es. «Caffè offerto»).';
            throw new AppError(422, 'validation_failed', $msg, ['fields' => ['giftText' => $msg]]);
        }
        $this->settings($ctx->companyId()); // crea la riga se manca
        DB::table('ordering_settings')->where('company_id', $ctx->companyId())->update([
            'public_mode' => $b['publicMode'], 'gift_text' => $b['giftText'] ?? null, 'cover_charge' => $b['coverCharge'], 'updated_at' => Clock::now(),
        ]);
        Audit::log($ctx->companyId(), $ctx->userId(), 'ordering', null, 'settings_updated', ['publicMode' => $b['publicMode']]);

        return ['ok' => true];
    }

    /* ------------------------- clienti registrati ------------------------- */

    /** Clienti registrati dal menu digitale (solo chi configura l'area Ordini). */
    public function guests(Request $req): mixed
    {
        $ctx = $this->requireCompany($req, 'orders.manage');
        $rows = DB::table('menu_guests as g')->leftJoin('dining_tables as t', 't.id', '=', 'g.table_id')
            ->where('g.company_id', $ctx->companyId())->orderByDesc('g.created_at')->limit(5000)
            ->get(['g.*', 't.label as table_label']);
        if ($req->query('format') === 'csv') {
            Audit::log($ctx->companyId(), $ctx->userId(), 'menu_guest', null, 'exported', ['rows' => $rows->count()]);
            $out = fopen('php://temp', 'r+');
            fwrite($out, "\xEF\xBB\xBF");
            fputcsv($out, ['Data', 'Nome', 'Cognome', 'Email', 'Telefono', 'Consenso marketing', 'Tavolo', 'Omaggio', 'Codice', 'Omaggio consegnato'], ';');
            foreach ($rows as $g) {
                fputcsv($out, [substr((string) $g->created_at, 0, 16), $g->first_name, $g->last_name, $g->email, $g->phone, $g->marketing_consent ? 'sì' : 'no', $g->table_label, $g->gift_text, $g->gift_code, $g->gift_redeemed_at ? substr((string) $g->gift_redeemed_at, 0, 16) : ''], ';');
            }
            rewind($out);

            return response(stream_get_contents($out), 200, ['Content-Type' => 'text/csv; charset=utf-8', 'Content-Disposition' => 'attachment; filename="clienti-menu-digitale.csv"']);
        }

        return ['data' => $rows->map(fn ($g) => [
            'id' => $g->id, 'firstName' => $g->first_name, 'lastName' => $g->last_name, 'email' => $g->email, 'phone' => $g->phone,
            'marketing' => (bool) $g->marketing_consent, 'table' => $g->table_label, 'gift' => $g->gift_text, 'giftCode' => $g->gift_code,
            'giftRedeemedAt' => Clock::iso($g->gift_redeemed_at), 'createdAt' => Clock::iso($g->created_at),
        ])->all(), 'total' => DB::table('menu_guests')->where('company_id', $ctx->companyId())->count()];
    }

    /* ------------------------------ supporto ------------------------------ */

    public static function settings(string $cid): array
    {
        $s = DB::table('ordering_settings')->where('company_id', $cid)->first();
        if (! $s) {
            DB::table('ordering_settings')->insertOrIgnore(['company_id' => $cid, 'public_token' => Str::random(20), 'updated_at' => Clock::now()]);
            $s = DB::table('ordering_settings')->where('company_id', $cid)->first();
        }

        return [
            'publicToken' => $s->public_token, 'publicMode' => $s->public_mode, 'giftText' => $s->gift_text,
            'guestOrdering' => (bool) $s->guest_ordering, 'coverCharge' => $s->cover_charge,
            'publicUrl' => rtrim((string) config('foodcost.app_url'), '/').'/menu/'.$s->public_token,
        ];
    }

    private function stationSchema(bool $update = false): \App\Support\Validation\Schema
    {
        return S::object([
            'name' => S::reqText('Il nome della postazione', 60),
            'kind' => S::enum(self::STATION_KINDS)->default('kitchen'),
            'isActive' => S::bool()->optional(),
        ]);
    }

    private function sectionSchema(): \App\Support\Validation\Schema
    {
        return S::object([
            'name' => S::reqText('Il nome della sezione', 80),
            'stationId' => S::uuid()->nullable()->optional(),
            'isDrinks' => S::bool()->default(false),
            'isVisible' => S::bool()->default(true),
        ]);
    }

    private function itemSchema(): \App\Support\Validation\Schema
    {
        return S::object([
            'sectionId' => S::uuid(),
            'sourceType' => S::enum(['recipe', 'ingredient']),
            'recipeId' => S::uuid()->nullable()->optional(),
            'ingredientId' => S::uuid()->nullable()->optional(),
            'portionQty' => S::decOpt(['gt' => 0, 'label' => 'La quantità servita'])->optional(),
            'portionUnit' => S::measureUnit()->nullable()->optional(),
            'name' => S::string()->trim()->max(160)->nullable()->optional(),
            'description' => S::optText(500),
            'price' => S::dec(['min' => 0, 'max' => 99999, 'label' => 'Il prezzo']),
            'vatPercent' => S::dec(['min' => 0, 'max' => 100, 'label' => 'L’IVA'])->default('10'),
            'stationId' => S::uuid()->nullable()->optional(),
            'isAvailable' => S::bool()->default(true),
            'isPublic' => S::bool()->default(true),
        ]);
    }

    /** Controlla l'origine (solo ricette o prodotti dell'azienda) e prepara la riga. */
    private function itemData(array $b, string $cid): array
    {
        if (! DB::table('menu_sections')->where('id', $b['sectionId'])->where('company_id', $cid)->exists()) {
            throw new AppError(422, 'validation_failed', 'Sezione non trovata.', ['fields' => ['sectionId' => 'Scegli una sezione.']]);
        }
        $this->checkStation($b['stationId'] ?? null, $cid);
        $name = trim((string) ($b['name'] ?? ''));
        if ($b['sourceType'] === 'recipe') {
            $r = ($b['recipeId'] ?? null) ? DB::table('recipes')->where('id', $b['recipeId'])->where('company_id', $cid)->first(['id', 'title']) : null;
            if (! $r) {
                throw new AppError(422, 'validation_failed', 'Scegli la ricetta.', ['fields' => ['recipeId' => 'Scegli la ricetta.']]);
            }
            $source = ['recipe_id' => $r->id, 'ingredient_id' => null, 'portion_qty' => null, 'portion_unit' => null];
            $name = $name !== '' ? $name : $r->title;
        } else {
            $i = ($b['ingredientId'] ?? null) ? DB::table('ingredients')->where('id', $b['ingredientId'])->where('company_id', $cid)->first(['id', 'name', 'usage_unit', 'package_unit']) : null;
            if (! $i) {
                throw new AppError(422, 'validation_failed', 'Scegli il prodotto.', ['fields' => ['ingredientId' => 'Scegli il prodotto.']]);
            }
            $source = [
                'recipe_id' => null, 'ingredient_id' => $i->id,
                'portion_qty' => ($b['portionQty'] ?? null) !== null ? (string) $b['portionQty'] : '1',
                'portion_unit' => $b['portionUnit'] ?? ($i->usage_unit ?: $i->package_unit ?: 'pz'),
            ];
            $name = $name !== '' ? $name : $i->name;
        }

        return [
            'section_id' => $b['sectionId'], 'source_type' => $b['sourceType'], ...$source, 'name' => $name,
            'description' => $b['description'] ?? null, 'price' => Dec::of($b['price'])->toDecimalPlaces(2)->toFixed(2), 'vat_percent' => (string) $b['vatPercent'],
            'station_id' => $b['stationId'] ?? null, 'is_available' => $b['isAvailable'] ? 1 : 0, 'is_public' => $b['isPublic'] ? 1 : 0,
        ];
    }

    /** Il prezzo in menu di una ricetta è uno solo: lo stesso che usa la Redditività. */
    private function syncRecipePrice(string $cid, array $row): void
    {
        if ($row['recipe_id']) {
            DB::table('recipe_prices')->upsert([[
                'recipe_id' => $row['recipe_id'], 'company_id' => $cid, 'menu_price' => $row['price'], 'vat_percent' => $row['vat_percent'], 'updated_at' => Clock::now(),
            ]], ['recipe_id'], ['menu_price', 'vat_percent', 'updated_at']);
        }
    }

    /** Costo per porzione di ogni voce (per margine e food cost %). */
    private function itemCosts(string $cid, $items): array
    {
        $date = Clock::today();
        $recipeCosts = Costing::recipePortionCosts($cid, $items->pluck('recipe_id')->filter()->all(), $date);
        $out = [];
        foreach ($items as $m) {
            if ($m->recipe_id) {
                $out[$m->id] = $recipeCosts[$m->recipe_id] ?? null;
            } elseif ($m->ingredient_id && $m->portion_qty !== null) {
                $out[$m->id] = Costing::ingredientPortionCost($cid, $m->ingredient_id, (string) $m->portion_qty, (string) $m->portion_unit, $date)?->toFixed();
            }
        }

        return $out;
    }

    private function stationRow(object $s): array
    {
        return ['id' => $s->id, 'name' => $s->name, 'kind' => $s->kind, 'sort' => (int) $s->sort, 'isActive' => (bool) $s->is_active];
    }

    private function sectionRow(object $s): array
    {
        return ['id' => $s->id, 'name' => $s->name, 'stationId' => $s->station_id, 'isDrinks' => (bool) $s->is_drinks, 'isVisible' => (bool) $s->is_visible, 'sort' => (int) $s->sort];
    }

    private function itemRow(object $m): array
    {
        return [
            'id' => $m->id, 'sectionId' => $m->section_id, 'sourceType' => $m->source_type, 'recipeId' => $m->recipe_id, 'ingredientId' => $m->ingredient_id,
            'sourceName' => $m->recipe_title ?? $m->ingredient_name, 'recipeStatus' => $m->recipe_status ?? null,
            'portionQty' => $m->portion_qty !== null ? Dec::of($m->portion_qty)->toFixed() : null, 'portionUnit' => $m->portion_unit,
            'name' => $m->name, 'description' => $m->description, 'price' => $m->price, 'vatPercent' => $m->vat_percent,
            'stationId' => $m->station_id, 'isAvailable' => (bool) $m->is_available, 'isPublic' => (bool) $m->is_public, 'sort' => (int) $m->sort,
        ];
    }

    private function tableRow(object $t): array
    {
        return [
            'id' => $t->id, 'label' => $t->label, 'seats' => (int) $t->seats, 'areaId' => $t->area_id, 'isActive' => (bool) $t->is_active, 'sort' => (int) $t->sort,
            'qrUrl' => rtrim((string) config('foodcost.app_url'), '/').'/menu/t/'.$t->qr_token,
        ];
    }

    private function nextSort(string $table, string $cid): int
    {
        return (int) DB::table($table)->where('company_id', $cid)->max('sort') + 1;
    }

    private function owned(string $table, string $id, string $cid): string
    {
        $id = $this->uuid($id);
        if (! DB::table($table)->where('id', $id)->where('company_id', $cid)->exists()) {
            throw AppError::notFound();
        }

        return $id;
    }

    private function checkStation(?string $id, string $cid): void
    {
        if ($id && ! DB::table('stations')->where('id', $id)->where('company_id', $cid)->exists()) {
            throw new AppError(422, 'validation_failed', 'Postazione non trovata.', ['fields' => ['stationId' => 'Scegli una postazione.']]);
        }
    }

    private function checkArea(?string $id, string $cid): void
    {
        if ($id && ! DB::table('dining_areas')->where('id', $id)->where('company_id', $cid)->exists()) {
            throw new AppError(422, 'validation_failed', 'Sala non trovata.', ['fields' => ['areaId' => 'Scegli una sala.']]);
        }
    }
}
