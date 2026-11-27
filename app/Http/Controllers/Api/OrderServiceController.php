<?php

namespace App\Http\Controllers\Api;

use App\Auth\AuthContext;
use App\Auth\Permissions;
use App\Domain\Costing\Dec;
use App\Http\Controllers\Controller;
use App\Services\Audit;
use App\Services\Costing;
use App\Support\AppError;
use App\Support\Clock;
use App\Auth\Crypto;
use App\Support\RateLimit;
use App\Support\Validation\S;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;

/**
 * NUOVO — Area Ordini, servizio: sala (tavoli, comande, VIA, unione, chiusura), cucina e bancone
 * (comande per postazione e stati), PIN degli operatori e tablet di servizio.
 *
 * Portate: 0 = bevande (partono subito), 1 = «subito», 2+ = «a seguire».
 * Una riga è «held» finché la sua portata non riceve il VIA; poi sent → preparing → ready → served.
 */
class OrderServiceController extends Controller
{
    private const ACTIVE = ['held', 'sent', 'preparing', 'ready'];

    /* ================================ SALA ================================ */

    /** Mappa della sala: tavoli liberi e occupati, con lo stato del servizio. */
    public function floor(Request $req): array
    {
        $ctx = $this->requireCompany($req, 'orders.take');
        $cid = $ctx->companyId();
        $sessions = DB::table('table_sessions')->where('company_id', $cid)->where('status', 'open')->get()->keyBy('id');
        $links = DB::table('table_session_tables')->where('company_id', $cid)->where('is_open', 1)->get();
        $stats = DB::table('order_items')->where('company_id', $cid)->whereIn('session_id', $sessions->keys())->whereIn('status', self::ACTIVE)
            ->groupBy('session_id', 'status')->selectRaw('session_id, status, count(*) as n')->get()->groupBy('session_id');
        $tableSession = $links->pluck('session_id', 'table_id');

        return [
            'areas' => DB::table('dining_areas')->where('company_id', $cid)->orderBy('sort')->get(['id', 'name'])->all(),
            'tables' => DB::table('dining_tables')->where('company_id', $cid)->where('is_active', 1)->orderBy('sort')->get()
                ->sortBy(fn ($t) => [(int) $t->label, $t->label])->values()
                ->map(fn ($t) => ['id' => $t->id, 'label' => $t->label, 'seats' => (int) $t->seats, 'areaId' => $t->area_id, 'sessionId' => $tableSession[$t->id] ?? null])->all(),
            'sessions' => $sessions->map(function ($s) use ($stats) {
                $c = collect($stats[$s->id] ?? [])->pluck('n', 'status');

                return [
                    'id' => $s->id, 'label' => $s->label, 'covers' => (int) $s->covers, 'openedAt' => Clock::iso($s->opened_at),
                    'held' => (int) ($c['held'] ?? 0), 'inKitchen' => (int) ($c['sent'] ?? 0) + (int) ($c['preparing'] ?? 0), 'ready' => (int) ($c['ready'] ?? 0),
                ];
            })->values()->all(),
            'serverTime' => Clock::iso(Clock::now()),
        ];
    }

    /** Menu per la presa ordini (senza costi). */
    public function menu(Request $req): array
    {
        $ctx = $this->requireCompany($req);
        if (! $ctx->can('orders.take') && ! $ctx->can('orders.kitchen')) {
            throw AppError::forbidden();
        }
        $cid = $ctx->companyId();
        $sections = DB::table('menu_sections')->where('company_id', $cid)->where('is_visible', 1)->orderBy('sort')->get();
        $items = DB::table('menu_items')->where('company_id', $cid)->whereNull('archived_at')->whereIn('section_id', $sections->pluck('id'))->orderBy('sort')->orderBy('name')->get();

        return [
            'sections' => $sections->map(fn ($s) => [
                'id' => $s->id, 'name' => $s->name, 'isDrinks' => (bool) $s->is_drinks,
                'items' => $items->where('section_id', $s->id)->values()->map(fn ($m) => [
                    'id' => $m->id, 'name' => $m->name, 'description' => $m->description, 'price' => $m->price, 'isAvailable' => (bool) $m->is_available,
                ])->all(),
            ])->all(),
            'coverCharge' => OrderSetupController::settings($cid)['coverCharge'],
        ];
    }

    /** Apre un tavolo (o più tavoli uniti) con il numero di coperti. */
    public function open(Request $req): array
    {
        $ctx = $this->requireCompany($req, 'orders.take');
        $b = $this->parseBody($req, S::object([
            'tableIds' => S::array(S::uuid())->min(1, 'Scegli almeno un tavolo.')->max(20, 'Troppi tavoli.'),
            'covers' => S::int(0, 200),
            'pin' => S::string()->max(8)->nullable()->optional(),
        ]));
        $waiter = $this->operator($ctx, $b['pin'] ?? null, 'orders.take');
        $cid = $ctx->companyId();

        $id = DB::transaction(function () use ($b, $cid, $waiter) {
            $tables = DB::table('dining_tables')->where('company_id', $cid)->whereIn('id', $b['tableIds'])->where('is_active', 1)->lockForUpdate()->get();
            if ($tables->count() !== count(array_unique($b['tableIds']))) {
                throw AppError::notFound('Tavolo');
            }
            $busy = DB::table('table_session_tables')->whereIn('table_id', $b['tableIds'])->where('is_open', 1)->exists();
            if ($busy) {
                throw new AppError(409, 'table_busy', 'Il tavolo è già aperto da un collega: aggiorna la sala.');
            }
            $id = (string) Str::uuid();
            DB::table('table_sessions')->insert([
                'id' => $id, 'company_id' => $cid, 'label' => self::label($tables->pluck('label')->all()), 'covers' => $b['covers'],
                'status' => 'open', 'next_course' => 2, 'opened_by' => $waiter, 'opened_at' => Clock::now(),
            ]);
            foreach ($tables as $t) {
                DB::table('table_session_tables')->insert(['session_id' => $id, 'table_id' => $t->id, 'company_id' => $cid, 'is_open' => 1]);
            }

            return $id;
        });
        Audit::log($cid, $waiter, 'table_session', $id, 'opened', ['covers' => $b['covers']]);

        return $this->sessionPayload($cid, $id);
    }

    public function show(Request $req, string $id): array
    {
        $ctx = $this->requireCompany($req, 'orders.take');

        return $this->sessionPayload($ctx->companyId(), $this->session($id, $ctx->companyId())->id);
    }

    /** Coperti e note del tavolo. */
    public function update(Request $req, string $id): array
    {
        $ctx = $this->requireCompany($req, 'orders.take');
        $s = $this->session($id, $ctx->companyId(), true);
        $b = $this->parseBody($req, S::object(['covers' => S::int(0, 200)->optional(), 'notes' => S::optText(500)]));
        $set = [];
        if (array_key_exists('covers', $b)) {
            $set['covers'] = $b['covers'];
        }
        if (array_key_exists('notes', $b)) {
            $set['notes'] = $b['notes'];
        }
        if ($set) {
            DB::table('table_sessions')->where('id', $s->id)->update($set);
        }

        return $this->sessionPayload($ctx->companyId(), $s->id);
    }

    /** Unisce altri tavoli a quello aperto (5 + 6 → «5-6»). Se erano già aperti, i loro ordini passano qui. */
    public function addTables(Request $req, string $id): array
    {
        $ctx = $this->requireCompany($req, 'orders.take');
        $b = $this->parseBody($req, S::object(['tableIds' => S::array(S::uuid())->min(1, 'Scegli almeno un tavolo.')->max(20, 'Troppi tavoli.'), 'pin' => S::string()->max(8)->nullable()->optional()]));
        $waiter = $this->operator($ctx, $b['pin'] ?? null, 'orders.take');
        $cid = $ctx->companyId();
        DB::transaction(function () use ($id, $cid, $b) {
            $s = $this->session($id, $cid, true, true);
            $tables = DB::table('dining_tables')->where('company_id', $cid)->whereIn('id', $b['tableIds'])->where('is_active', 1)->lockForUpdate()->get();
            if ($tables->count() !== count(array_unique($b['tableIds']))) {
                throw AppError::notFound('Tavolo');
            }
            foreach ($tables as $t) {
                $other = DB::table('table_session_tables')->where('table_id', $t->id)->where('is_open', 1)->value('session_id');
                if ($other === $s->id) {
                    continue;
                }
                if ($other) {
                    // il tavolo era già aperto: i suoi ordini e coperti confluiscono qui
                    $o = DB::table('table_sessions')->where('id', $other)->lockForUpdate()->first();
                    DB::table('order_items')->where('session_id', $other)->update(['session_id' => $s->id]);
                    DB::table('table_sessions')->where('id', $s->id)->update(['covers' => DB::raw('covers + '.(int) $o->covers), 'next_course' => max((int) $s->next_course, (int) $o->next_course)]);
                    DB::table('table_session_tables')->where('session_id', $other)->update(['is_open' => 0]);
                    foreach (DB::table('table_session_tables')->where('session_id', $other)->pluck('table_id') as $tid) {
                        DB::table('table_session_tables')->insertOrIgnore(['session_id' => $s->id, 'table_id' => $tid, 'company_id' => $cid, 'is_open' => 1]);
                    }
                    DB::table('table_sessions')->where('id', $other)->update(['status' => 'cancelled', 'closed_at' => Clock::now(), 'notes' => 'Unito a un altro tavolo']);
                } else {
                    DB::table('table_session_tables')->insert(['session_id' => $s->id, 'table_id' => $t->id, 'company_id' => $cid, 'is_open' => 1]);
                }
            }
            $this->relabel($s->id);
        });
        Audit::log($cid, $waiter, 'table_session', $id, 'tables_merged', ['tables' => $b['tableIds']]);

        return $this->sessionPayload($cid, $this->uuid($id));
    }

    /** Toglie un tavolo dall'unione (es. unito per sbaglio). Il tavolo resta con almeno uno. */
    public function removeTable(Request $req, string $id, string $tableId): array
    {
        $ctx = $this->requireCompany($req, 'orders.take');
        $s = $this->session($id, $ctx->companyId(), true);
        $tableId = $this->uuid($tableId);
        if (DB::table('table_session_tables')->where('session_id', $s->id)->where('is_open', 1)->count() <= 1) {
            throw new AppError(409, 'last_table', 'È l’unico tavolo: per liberarlo chiudi il conto.');
        }
        DB::table('table_session_tables')->where('session_id', $s->id)->where('table_id', $tableId)->delete();
        $this->relabel($s->id);

        return $this->sessionPayload($ctx->companyId(), $s->id);
    }

    /** Invio di una comanda: righe con portata, quantità e note. Le portate «a seguire» aspettano il VIA. */
    public function send(Request $req, string $id): array
    {
        $ctx = $this->requireCompany($req, 'orders.take');
        $b = $this->parseBody($req, S::object([
            'items' => S::array(S::object([
                'menuItemId' => S::uuid(),
                'qty' => S::int(1, 99),
                'course' => S::int(1, 5)->default(1),
                'notes' => S::optText(300),
            ]))->min(1, 'La comanda è vuota.')->max(200, 'Troppe righe.'),
            'pin' => S::string()->max(8)->nullable()->optional(),
        ]));
        $waiter = $this->operator($ctx, $b['pin'] ?? null, 'orders.take');
        $cid = $ctx->companyId();
        $menu = DB::table('menu_items as m')->join('menu_sections as s', 's.id', '=', 'm.section_id')
            ->where('m.company_id', $cid)->whereIn('m.id', array_column($b['items'], 'menuItemId'))->whereNull('m.archived_at')
            ->get(['m.*', 's.station_id as section_station', 's.is_drinks'])->keyBy('id');
        $missing = array_diff(array_column($b['items'], 'menuItemId'), $menu->keys()->all());
        if ($missing) {
            throw new AppError(422, 'validation_failed', 'Un piatto non è più nel menu: aggiorna e riprova.');
        }
        $soldOut = $menu->filter(fn ($m) => ! $m->is_available)->pluck('name')->all();
        if ($soldOut) {
            throw new AppError(409, 'sold_out', 'Esaurito: '.implode(', ', $soldOut).'. Toglilo dalla comanda.');
        }
        $costs = $this->unitCosts($cid, $menu);
        $batch = (string) Str::uuid();

        DB::transaction(function () use ($id, $cid, $b, $menu, $costs, $batch, $waiter) {
            $s = $this->session($id, $cid, true, true);
            $released = (int) $s->next_course - 1;
            $now = Clock::now();
            foreach ($b['items'] as $line) {
                $m = $menu[$line['menuItemId']];
                $course = $m->is_drinks ? 0 : $line['course'];
                $held = $course > $released;
                DB::table('order_items')->insert([
                    'id' => (string) Str::uuid(), 'company_id' => $cid, 'session_id' => $s->id, 'batch_id' => $batch,
                    'menu_item_id' => $m->id, 'recipe_id' => $m->recipe_id, 'ingredient_id' => $m->ingredient_id,
                    'name' => $m->name, 'qty' => $line['qty'], 'unit_price' => $m->price, 'vat_percent' => $m->vat_percent,
                    'unit_cost' => $costs[$m->id] ?? null, 'course' => $course, 'station_id' => $m->station_id ?? $m->section_station,
                    'notes' => $line['notes'] ?? null, 'status' => $held ? 'held' : 'sent', 'waiter_id' => $waiter,
                    'created_at' => $now, 'sent_at' => $held ? null : $now,
                ]);
            }
        });
        Audit::log($cid, $waiter, 'table_session', $this->uuid($id), 'order_sent', ['lines' => count($b['items'])]);

        return $this->sessionPayload($cid, $this->uuid($id));
    }

    /** VIA: manda in cucina la prossima portata in attesa. */
    public function go(Request $req, string $id): array
    {
        $ctx = $this->requireCompany($req, 'orders.take');
        $b = $this->parseBody($req, S::object(['pin' => S::string()->max(8)->nullable()->optional()]));
        $waiter = $this->operator($ctx, $b['pin'] ?? null, 'orders.take');
        $cid = $ctx->companyId();
        $course = DB::transaction(function () use ($id, $cid) {
            $s = $this->session($id, $cid, true, true);
            $course = DB::table('order_items')->where('session_id', $s->id)->where('status', 'held')->min('course');
            if ($course === null) {
                throw new AppError(409, 'nothing_held', 'Non ci sono portate in attesa del VIA.');
            }
            DB::table('order_items')->where('session_id', $s->id)->where('status', 'held')->where('course', $course)->update(['status' => 'sent', 'sent_at' => Clock::now()]);
            DB::table('table_sessions')->where('id', $s->id)->update(['next_course' => (int) $course + 1]);

            return (int) $course;
        });
        Audit::log($cid, $waiter, 'table_session', $this->uuid($id), 'course_released', ['course' => $course]);

        return $this->sessionPayload($cid, $this->uuid($id));
    }

    /** Annulla una riga (sbagliata o non più voluta): la cucina la vede barrata. */
    public function cancelItem(Request $req, string $itemId): array
    {
        $ctx = $this->requireCompany($req, 'orders.take');
        $b = $this->parseBody($req, S::object(['pin' => S::string()->max(8)->nullable()->optional()]));
        $waiter = $this->operator($ctx, $b['pin'] ?? null, 'orders.take');
        $itemId = $this->uuid($itemId);
        $it = DB::table('order_items')->where('id', $itemId)->where('company_id', $ctx->companyId())->first();
        if (! $it) {
            throw AppError::notFound();
        }
        $this->session($it->session_id, $ctx->companyId(), true);
        if (in_array($it->status, ['served', 'cancelled'], true)) {
            throw new AppError(409, 'not_cancellable', 'Questa riga è già servita o annullata.');
        }
        DB::table('order_items')->where('id', $itemId)->update(['status' => 'cancelled', 'cancelled_at' => Clock::now()]);
        Audit::log($ctx->companyId(), $waiter, 'order_item', $itemId, 'cancelled', ['name' => $it->name, 'was' => $it->status]);

        return $this->sessionPayload($ctx->companyId(), $it->session_id);
    }

    /** Il cameriere ha portato al tavolo i piatti pronti. */
    public function served(Request $req, string $id): array
    {
        $ctx = $this->requireCompany($req, 'orders.take');
        $s = $this->session($id, $ctx->companyId(), true);
        DB::table('order_items')->where('session_id', $s->id)->where('status', 'ready')->update(['status' => 'served']);

        return $this->sessionPayload($ctx->companyId(), $s->id);
    }

    /** Chiusura del tavolo: totale del preconto, tavoli liberi. */
    public function close(Request $req, string $id): array
    {
        $ctx = $this->requireCompany($req, 'orders.take');
        $b = $this->parseBody($req, S::object(['pin' => S::string()->max(8)->nullable()->optional(), 'force' => S::bool()->default(false)]));
        $waiter = $this->operator($ctx, $b['pin'] ?? null, 'orders.take');
        $cid = $ctx->companyId();
        $out = DB::transaction(function () use ($id, $cid, $b, $waiter) {
            $s = $this->session($id, $cid, true, true);
            // le portate mai partite (in attesa del VIA) non sono state fatte: si annullano, con conferma
            $held = (int) DB::table('order_items')->where('session_id', $s->id)->where('status', 'held')->sum('qty');
            if ($held && ! $b['force']) {
                throw new AppError(409, 'pending_items', $held === 1 ? 'C’è ancora 1 piatto in attesa del VIA: chiudendo non verrà preparato. Chiudi comunque?' : "Ci sono ancora {$held} piatti in attesa del VIA: chiudendo non verranno preparati. Chiudi comunque?");
            }
            DB::table('order_items')->where('session_id', $s->id)->where('status', 'held')->update(['status' => 'cancelled', 'cancelled_at' => Clock::now()]);
            // ciò che era già in cucina è stato fatto e servito (anche se nessuno ha toccato «pronto»)
            DB::table('order_items')->where('session_id', $s->id)->whereIn('status', ['sent', 'preparing', 'ready'])->update(['status' => 'served']);
            $bill = $this->bill($cid, $s);
            DB::table('table_sessions')->where('id', $s->id)->update(['status' => 'closed', 'closed_at' => Clock::now(), 'closed_by' => $waiter, 'total' => $bill['total']]);
            DB::table('table_session_tables')->where('session_id', $s->id)->update(['is_open' => 0]);

            return $bill;
        });
        Audit::log($cid, $waiter, 'table_session', $this->uuid($id), 'closed', ['total' => $out['total']]);

        return ['ok' => true, 'bill' => $out];
    }

    /** Preconto (non fiscale) del tavolo. */
    public function billPreview(Request $req, string $id): array
    {
        $ctx = $this->requireCompany($req, 'orders.take');
        $s = $this->session($id, $ctx->companyId());

        return $this->bill($ctx->companyId(), $s);
    }

    /* =========================== CUCINA E BANCONE =========================== */

    /** Comande per postazione: in arrivo, in preparazione, pronte (ultimi 20 minuti) e in attesa del VIA. */
    public function kitchen(Request $req): array
    {
        $ctx = $this->requireCompany($req, 'orders.kitchen');
        $cid = $ctx->companyId();
        $stations = DB::table('stations')->where('company_id', $cid)->where('is_active', 1)->orderBy('sort')->get(['id', 'name', 'kind']);
        $want = array_filter(explode(',', (string) $req->query('stations', '')));
        $ids = $want ? array_values(array_intersect($want, $stations->pluck('id')->all())) : $stations->pluck('id')->all();
        $since = date('Y-m-d H:i:s', time() - 20 * 60);
        $rows = DB::table('order_items as o')->join('table_sessions as s', 's.id', '=', 'o.session_id')
            ->leftJoin('users as w', 'w.id', '=', 'o.waiter_id')
            ->where('o.company_id', $cid)->whereIn('o.station_id', $ids ?: ['-'])->where('s.status', 'open')
            ->where(fn ($q) => $q->whereIn('o.status', ['held', 'sent', 'preparing'])->orWhere(fn ($r) => $r->where('o.status', 'ready')->where('o.ready_at', '>=', $since))->orWhere(fn ($r) => $r->where('o.status', 'cancelled')->where('o.cancelled_at', '>=', $since)->whereNotNull('o.sent_at')))
            ->orderBy('o.sent_at')->orderBy('o.created_at')
            ->get(['o.id', 'o.session_id', 'o.station_id', 'o.name', 'o.qty', 'o.course', 'o.notes', 'o.status', 'o.created_at', 'o.sent_at', 'o.ready_at', 's.label', 's.covers', 'w.name as waiter']);

        // una comanda = tavolo + portata + postazione
        $tickets = $rows->groupBy(fn ($r) => $r->session_id.'|'.$r->course.'|'.$r->station_id)->map(function ($g) {
            $f = $g->first();
            $live = $g->whereNotIn('status', ['cancelled']);
            $status = $live->isEmpty() ? 'cancelled' : ($live->contains('status', 'held') && $live->every(fn ($r) => $r->status === 'held') ? 'held'
                : ($live->every(fn ($r) => $r->status === 'ready') ? 'ready' : ($live->contains('status', 'preparing') ? 'preparing' : 'new')));

            return [
                'key' => $f->session_id.'|'.$f->course.'|'.$f->station_id, 'sessionId' => $f->session_id, 'table' => $f->label, 'covers' => (int) $f->covers,
                'course' => (int) $f->course, 'stationId' => $f->station_id, 'status' => $status, 'waiter' => $f->waiter,
                'sentAt' => Clock::iso($g->min('sent_at')), 'readyAt' => Clock::iso($g->max('ready_at')),
                'items' => $g->map(fn ($r) => ['id' => $r->id, 'name' => $r->name, 'qty' => (int) $r->qty, 'notes' => $r->notes, 'status' => $r->status])->values()->all(),
            ];
        })->sortBy(fn ($t) => [$t['status'] === 'held' ? 1 : 0, $t['sentAt'] ?? '9999', $t['course']])->values()->all(); // in attesa del VIA in fondo

        return ['stations' => $stations->all(), 'tickets' => $tickets, 'serverTime' => Clock::iso(Clock::now())];
    }

    /** Stato delle righe: in preparazione, pronte, servite (o di nuovo «da fare»). */
    public function kitchenStatus(Request $req): array
    {
        $ctx = $this->requireCompany($req, 'orders.kitchen');
        $b = $this->parseBody($req, S::object(['ids' => S::array(S::uuid())->min(1, 'Nessuna riga.')->max(200, 'Troppe righe.'), 'status' => S::enum(['sent', 'preparing', 'ready', 'served'])]));
        $set = ['status' => $b['status']];
        $set['ready_at'] = $b['status'] === 'ready' ? Clock::now() : null;
        if ($b['status'] === 'served') {
            unset($set['ready_at']);
        }
        $n = DB::table('order_items')->where('company_id', $ctx->companyId())->whereIn('id', $b['ids'])->whereIn('status', ['sent', 'preparing', 'ready'])->update($set);

        return ['ok' => true, 'updated' => $n];
    }

    /** Il cliente mostra il codice dell'omaggio: il cameriere lo verifica e lo segna come consegnato. */
    public function redeemGift(Request $req): array
    {
        $ctx = $this->requireCompany($req, 'orders.take');
        $b = $this->parseBody($req, S::object(['code' => S::string()->trim()->max(12), 'confirm' => S::bool()->default(false)]));
        $g = DB::table('menu_guests')->where('company_id', $ctx->companyId())->where('gift_code', strtoupper($b['code']))->first();
        if (! $g) {
            throw new AppError(404, 'not_found', 'Codice omaggio non trovato.');
        }
        if ($b['confirm'] && ! $g->gift_redeemed_at) {
            DB::table('menu_guests')->where('id', $g->id)->update(['gift_redeemed_at' => Clock::now()]);
            Audit::log($ctx->companyId(), $ctx->userId(), 'menu_guest', $g->id, 'gift_redeemed');
        }

        return ['name' => $g->first_name.' '.$g->last_name, 'gift' => $g->gift_text, 'redeemedAt' => Clock::iso($b['confirm'] && ! $g->gift_redeemed_at ? Clock::now() : $g->gift_redeemed_at), 'alreadyRedeemed' => $g->gift_redeemed_at !== null];
    }

    /* ============================ PIN E TABLET ============================ */

    /** Il proprio PIN (4–6 cifre) per i tablet condivisi. */
    public function setOwnPin(Request $req): array
    {
        $ctx = $this->requireCompany($req);
        if ($ctx->assist || $ctx->serviceDevice) {
            throw AppError::forbidden();
        }
        $b = $this->parseBody($req, S::object(['pin' => S::string()->regex('/^\d{4,6}$/', 'Il PIN è di 4–6 cifre.')]));
        $this->storePin($ctx->companyId(), $ctx->userId(), $b['pin']);

        return ['ok' => true];
    }

    /** Personale dell'area Ordini con il PIN impostato o no (per l'amministratore). */
    public function staff(Request $req): array
    {
        $ctx = $this->requireCompany($req, 'orders.manage');
        $rows = DB::table('memberships as m')->join('users as u', 'u.id', '=', 'm.user_id')
            ->where('m.company_id', $ctx->companyId())->where('m.is_active', 1)->orderBy('u.name')
            ->get(['u.id', 'u.name', 'u.email', 'm.role', 'm.extra_permissions', 'm.pin_lookup']);

        return ['data' => $rows->map(function ($r) {
            $perms = Permissions::effective($r->role, json_decode($r->extra_permissions ?? '[]', true) ?: []);

            return [
                'userId' => $r->id, 'name' => $r->name, 'email' => $r->email, 'role' => $r->role, 'roleLabel' => Permissions::ROLE_LABELS[$r->role] ?? $r->role,
                'takesOrders' => in_array('orders.take', $perms, true), 'kitchen' => in_array('orders.kitchen', $perms, true), 'hasPin' => $r->pin_lookup !== null,
            ];
        })->filter(fn ($r) => $r['takesOrders'] || $r['kitchen'])->values()->all()];
    }

    public function setStaffPin(Request $req, string $userId): array
    {
        $ctx = $this->requireCompany($req, 'orders.manage');
        $userId = $this->uuid($userId);
        $b = $this->parseBody($req, S::object(['pin' => S::string()->regex('/^\d{4,6}$/', 'Il PIN è di 4–6 cifre.')->nullable()]));
        if (! DB::table('memberships')->where('company_id', $ctx->companyId())->where('user_id', $userId)->where('is_active', 1)->exists()) {
            throw AppError::notFound('Utente');
        }
        if ($b['pin'] === null) {
            DB::table('memberships')->where('company_id', $ctx->companyId())->where('user_id', $userId)->update(['pin_lookup' => null, 'pin_hash' => null]);
        } else {
            $this->storePin($ctx->companyId(), $userId, $b['pin']);
        }
        Audit::log($ctx->companyId(), $ctx->userId(), 'membership', $userId, $b['pin'] === null ? 'pin_removed' : 'pin_set');

        return ['ok' => true];
    }

    /** Trasforma questo dispositivo in tablet di servizio (serve la password dell'amministratore). */
    public function enableDevice(Request $req): array
    {
        $ctx = $this->requireCompany($req, 'orders.manage');
        if ($ctx->assist || $ctx->serviceDevice) {
            throw AppError::forbidden();
        }
        $this->checkPassword($req, $ctx);
        DB::table('sessions')->where('token_hash', $ctx->sessionHash)->update(['service_device' => 1]);
        Audit::log($ctx->companyId(), $ctx->userId(), 'session', null, 'service_device_on');

        return ['ok' => true];
    }

    /** Esce dalla modalità tablet di servizio: serve la password di chi l'ha attivata. */
    public function disableDevice(Request $req): array
    {
        $ctx = $this->requireCompany($req);
        if (! $ctx->serviceDevice) {
            return ['ok' => true];
        }
        $this->checkPassword($req, $ctx);
        DB::table('sessions')->where('token_hash', $ctx->sessionHash)->update(['service_device' => 0]);
        Audit::log($ctx->companyId(), $ctx->userId(), 'session', null, 'service_device_off');

        return ['ok' => true];
    }

    /** Chi è il PIN? (per mostrare «Ciao Marco» sul tablet) */
    public function whoami(Request $req): array
    {
        $ctx = $this->requireCompany($req);
        $b = $this->parseBody($req, S::object(['pin' => S::string()->max(8)]));
        $uid = $this->operator($ctx, $b['pin'], null);

        return ['userId' => $uid, 'name' => DB::table('users')->where('id', $uid)->value('name')];
    }

    /* ============================== SUPPORTO ============================== */

    /**
     * Chi sta operando: sul tablet di servizio la persona del PIN, altrimenti l'utente collegato.
     */
    private function operator(AuthContext $ctx, ?string $pin, ?string $perm): string
    {
        if (! $ctx->serviceDevice) {
            return $ctx->userId();
        }
        if (! $pin) {
            throw new AppError(422, 'pin_required', 'Inserisci il tuo PIN.', ['fields' => ['pin' => 'Inserisci il tuo PIN.']]);
        }
        RateLimit::hit('order-pin', $ctx->sessionHash, 20, 300);
        $m = DB::table('memberships')->where('company_id', $ctx->companyId())->where('is_active', 1)->where('pin_lookup', $this->pinLookup($ctx->companyId(), $pin))->first();
        if (! $m) {
            throw new AppError(422, 'pin_invalid', 'PIN non riconosciuto.', ['fields' => ['pin' => 'PIN non riconosciuto.']]);
        }
        if ($perm && ! in_array($perm, Permissions::effective($m->role, json_decode($m->extra_permissions ?? '[]', true) ?: []), true)) {
            throw new AppError(403, 'forbidden', 'Con questo PIN non puoi prendere ordini.');
        }

        return $m->user_id;
    }

    private function pinLookup(string $cid, string $pin): string
    {
        return hash_hmac('sha256', $cid.':'.$pin, (string) config('app.key'));
    }

    private function storePin(string $cid, string $userId, string $pin): void
    {
        $lookup = $this->pinLookup($cid, $pin);
        if (DB::table('memberships')->where('company_id', $cid)->where('pin_lookup', $lookup)->where('user_id', '<>', $userId)->exists()) {
            $msg = 'Questo PIN è già usato da un collega: scegline un altro.';
            throw new AppError(422, 'validation_failed', $msg, ['fields' => ['pin' => $msg]]);
        }
        DB::table('memberships')->where('company_id', $cid)->where('user_id', $userId)->update(['pin_lookup' => $lookup, 'pin_hash' => null]);
    }

    private function checkPassword(Request $req, AuthContext $ctx): void
    {
        $b = $this->parseBody($req, S::object(['password' => S::string()->min(1)]));
        RateLimit::hit('device-password', $ctx->sessionHash, 10, 300);
        $hash = DB::table('users')->where('id', $ctx->userId())->value('password_hash');
        if (! $hash || ! Crypto::verifyPassword($b['password'], $hash)) {
            throw new AppError(422, 'validation_failed', 'Password errata.', ['fields' => ['password' => 'Password errata.']]);
        }
    }

    private function session(string $id, string $cid, bool $mustBeOpen = false, bool $lock = false): object
    {
        $id = $this->uuid($id);
        $q = DB::table('table_sessions')->where('id', $id)->where('company_id', $cid);
        $s = $lock ? $q->lockForUpdate()->first() : $q->first();
        if (! $s) {
            throw AppError::notFound('Tavolo');
        }
        if ($mustBeOpen && $s->status !== 'open') {
            throw new AppError(409, 'session_closed', 'Questo tavolo è già stato chiuso.');
        }

        return $s;
    }

    private static function label(array $labels): string
    {
        natsort($labels);

        return implode('-', $labels);
    }

    private function relabel(string $sessionId): void
    {
        $labels = DB::table('table_session_tables as l')->join('dining_tables as t', 't.id', '=', 'l.table_id')->where('l.session_id', $sessionId)->where('l.is_open', 1)->pluck('t.label')->all();
        DB::table('table_sessions')->where('id', $sessionId)->update(['label' => self::label($labels)]);
    }

    /** Costo per porzione al momento dell'ordine (per le statistiche di margine). */
    private function unitCosts(string $cid, $menu): array
    {
        $date = Clock::today();
        $recipe = Costing::recipePortionCosts($cid, $menu->pluck('recipe_id')->filter()->all(), $date);
        $out = [];
        foreach ($menu as $m) {
            if ($m->recipe_id) {
                $out[$m->id] = isset($recipe[$m->recipe_id]) ? Costing::fit((string) $recipe[$m->recipe_id]) : null;
            } elseif ($m->ingredient_id && $m->portion_qty !== null) {
                $c = Costing::ingredientPortionCost($cid, $m->ingredient_id, (string) $m->portion_qty, (string) $m->portion_unit, $date);
                $out[$m->id] = $c ? Costing::fit($c->toFixed()) : null;
            }
        }

        return $out;
    }

    private function bill(string $cid, object $s): array
    {
        $items = DB::table('order_items')->where('session_id', $s->id)->where('status', '<>', 'cancelled')->orderBy('course')->orderBy('created_at')->get();
        $lines = $items->groupBy(fn ($i) => $i->name.'|'.$i->unit_price)->map(function ($g) {
            $f = $g->first();
            $qty = $g->sum('qty');

            return ['name' => $f->name, 'qty' => $qty, 'unitPrice' => $f->unit_price, 'total' => Dec::of($f->unit_price)->times((string) $qty)->toDecimalPlaces(2)->toFixed(2)];
        })->values();
        $cover = Dec::of((string) (OrderSetupController::settings($cid)['coverCharge'] ?? '0'));
        $coverTotal = $cover->times((string) $s->covers);
        $total = $coverTotal;
        foreach ($lines as $l) {
            $total = $total->plus($l['total']);
        }

        return [
            'label' => $s->label, 'covers' => (int) $s->covers, 'coverCharge' => $cover->toDecimalPlaces(2)->toFixed(2), 'coverTotal' => $coverTotal->toDecimalPlaces(2)->toFixed(2),
            'lines' => $lines->all(), 'total' => $total->toDecimalPlaces(2)->toFixed(2), 'openedAt' => Clock::iso($s->opened_at),
        ];
    }

    private function sessionPayload(string $cid, string $id): array
    {
        $s = DB::table('table_sessions')->where('id', $id)->where('company_id', $cid)->first();
        $tables = DB::table('table_session_tables as l')->join('dining_tables as t', 't.id', '=', 'l.table_id')->where('l.session_id', $id)->where('l.is_open', $s->status === 'open' ? 1 : 0)->get(['t.id', 't.label', 't.seats']);
        $items = DB::table('order_items as o')->leftJoin('stations as st', 'st.id', '=', 'o.station_id')->leftJoin('users as w', 'w.id', '=', 'o.waiter_id')
            ->where('o.session_id', $id)->orderBy('o.course')->orderBy('o.created_at')
            ->get(['o.id', 'o.name', 'o.qty', 'o.unit_price', 'o.course', 'o.notes', 'o.status', 'o.created_at', 'st.name as station', 'w.name as waiter']);

        return [
            'id' => $s->id, 'label' => $s->label, 'covers' => (int) $s->covers, 'status' => $s->status, 'notes' => $s->notes,
            'openedAt' => Clock::iso($s->opened_at), 'nextCourse' => (int) $s->next_course,
            'heldCourse' => $items->where('status', 'held')->min('course'),
            'tables' => $tables->map(fn ($t) => ['id' => $t->id, 'label' => $t->label, 'seats' => (int) $t->seats])->all(),
            'items' => $items->map(fn ($i) => [
                'id' => $i->id, 'name' => $i->name, 'qty' => (int) $i->qty, 'unitPrice' => $i->unit_price, 'course' => (int) $i->course,
                'notes' => $i->notes, 'status' => $i->status, 'station' => $i->station, 'waiter' => $i->waiter, 'createdAt' => Clock::iso($i->created_at),
            ])->all(),
            'bill' => $this->bill($cid, $s),
        ];
    }
}
