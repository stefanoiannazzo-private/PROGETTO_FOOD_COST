<?php

declare(strict_types=1);

namespace App\Http\Controllers\Api;

use App\Auth\AuthContext;
use App\Http\Controllers\Controller;
use App\Services\Audit;
use App\Services\Mailer;
use App\Support\AppError;
use App\Support\Clock;
use App\Support\RateLimit;
use App\Support\Validation\S;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Log;
use Illuminate\Support\Str;
use Throwable;

/**
 * NUOVO — Assistenza.
 * Il ristoratore apre una richiesta indicando la pagina dell'app (area), il tipo e il messaggio, con uno
 * screenshot facoltativo; il supporto (superadmin) risponde dalla console. Avvisi via email a entrambi.
 * Chi non è amministratore vede solo le proprie richieste; l'amministratore vede quelle della sua azienda.
 */
final class SupportController extends Controller
{
    public const AREAS = [
        'dashboard' => 'Dashboard',
        'ricette' => 'Ricette e semilavorati',
        'ingredienti' => 'Ingredienti e prodotti',
        'strumenti' => 'Strumenti e attrezzature',
        'utenze' => 'Utenze e bollette',
        'dipendenti' => 'Dipendenti e costo del lavoro',
        'redditivita' => 'Redditività e prezzi in menu',
        'importazioni' => 'Importazioni (Excel e fatture XML)',
        'utenti' => 'Utenti e permessi',
        'impostazioni' => 'Impostazioni',
        'app' => 'App sul telefono',
        'account' => 'Accesso e account',
        'altro' => 'Altro',
    ];

    public const KINDS = ['question' => 'Domanda', 'problem' => 'Problema', 'suggestion' => 'Suggerimento'];

    private const FILE_TYPES = ['application/pdf' => 'pdf', 'image/jpeg' => 'jpg', 'image/png' => 'png', 'image/webp' => 'webp'];

    /* ============================== ristoratore ============================== */

    public function info(Request $req): array
    {
        $this->requireAuth($req);

        return [
            'phone' => (string) config('foodcost.support_phone'),
            'hours' => (string) config('foodcost.support_hours'),
            'areas' => self::AREAS,
            'kinds' => self::KINDS,
            'maxBytes' => (int) config('foodcost.support_max_bytes'),
        ];
    }

    public function index(Request $req): array
    {
        $ctx = $this->requireCompany($req);
        $q = $this->baseList()->where('t.company_id', $ctx->companyId());
        if ($ctx->role !== 'admin') {
            $q->where('t.user_id', $ctx->userId());
        }

        return ['data' => $q->orderByDesc('t.updated_at')->limit(200)->get()->map(fn ($r) => self::row($r))->all()];
    }

    public function store(Request $req): array
    {
        $ctx = $this->requireCompany($req);
        if ($ctx->assist) {
            throw AppError::forbidden('In modalità assistenza non si aprono richieste a nome del cliente.');
        }
        RateLimit::hit('support-ticket', $ctx->userId(), 15, 3600);
        $b = $this->parseBody($req, S::object([
            'area' => S::enum(array_keys(self::AREAS)),
            'kind' => S::enum(array_keys(self::KINDS)),
            'subject' => S::reqText('L’oggetto', 160),
            'message' => S::reqText('Il messaggio', 5000),
            'contactPhone' => S::optText(40),
            'pageUrl' => S::optText(300),
        ]));
        $file = $this->attachment($req);
        $now = Clock::now();
        $id = (string) Str::uuid();
        $number = 0;
        $ua = mb_substr((string) $req->userAgent(), 0, 300);
        for ($try = 0; $try < 5; $try++) {
            try {
                DB::transaction(function () use ($ctx, $b, $id, $now, $ua, &$number) {
                    $number = (int) DB::table('support_tickets')->lockForUpdate()->max('number') + 1;
                    DB::table('support_tickets')->insert([
                        'id' => $id,
                        'number' => $number,
                        'company_id' => $ctx->companyId(),
                        'user_id' => $ctx->userId(),
                        'area' => $b['area'],
                        'kind' => $b['kind'],
                        'subject' => $b['subject'],
                        'status' => 'open',
                        'contact_phone' => $b['contactPhone'] ?? null,
                        'page_url' => isset($b['pageUrl']) ? mb_substr((string) $b['pageUrl'], 0, 300) : null,
                        'user_agent' => $ua,
                        'created_at' => $now,
                        'updated_at' => $now,
                        'last_user_at' => $now,
                    ]);
                });
                break;
            } catch (\Illuminate\Database\UniqueConstraintViolationException) {
                continue;
            }
        }
        $this->addMessage($id, $ctx->userId(), false, $b['message'], $file, $now);
        Audit::log($ctx->companyId(), $ctx->userId(), 'support_ticket', $id, 'created', ['number' => $number]);
        $this->notifyStaff($id, 'Nuova richiesta');

        return ['id' => $id, 'number' => $number];
    }

    public function show(Request $req, string $id): array
    {
        $ctx = $this->requireAuth($req);
        $t = $this->visibleTicket($ctx, $this->uuid($id));
        // la risposta dell'assistenza è letta quando chi ha scritto apre la richiesta
        if ($t->user_id === $ctx->userId() && ! $ctx->assist) {
            DB::table('support_tickets')->where('id', $t->id)->update(['user_seen_at' => Clock::now()]);
        }

        return $this->detail($t, $ctx->isPlatformAdmin());
    }

    public function reply(Request $req, string $id): array
    {
        $ctx = $this->requireCompany($req);
        $t = $this->visibleTicket($ctx, $this->uuid($id));
        if ($ctx->assist) {
            throw AppError::forbidden('Rispondi dalla console Assistenza della piattaforma.');
        }
        RateLimit::hit('support-reply', $ctx->userId(), 60, 3600);
        $b = $this->parseBody($req, S::object(['message' => S::reqText('Il messaggio', 5000)]));
        $file = $this->attachment($req);
        $now = Clock::now();
        $this->addMessage($t->id, $ctx->userId(), false, $b['message'], $file, $now);
        DB::table('support_tickets')->where('id', $t->id)->update(['status' => 'open', 'updated_at' => $now, 'last_user_at' => $now]);
        $this->notifyStaff($t->id, 'Nuovo messaggio');

        return ['ok' => true];
    }

    public function close(Request $req, string $id): array
    {
        $ctx = $this->requireCompany($req);
        $t = $this->visibleTicket($ctx, $this->uuid($id));
        DB::table('support_tickets')->where('id', $t->id)->update(['status' => 'closed', 'updated_at' => Clock::now()]);

        return ['ok' => true];
    }

    public function attachmentFile(Request $req, string $id, string $messageId): \Symfony\Component\HttpFoundation\BinaryFileResponse
    {
        $ctx = $this->requireAuth($req);
        $t = $this->visibleTicket($ctx, $this->uuid($id));
        $m = DB::table('support_messages')->where('id', $this->uuid($messageId))->where('ticket_id', $t->id)->first();
        if (! $m || ! $m->attachment_path || ! is_file(storage_path('app/'.$m->attachment_path))) {
            throw AppError::notFound('Allegato');
        }
        $name = preg_replace('/[^A-Za-z0-9._-]/', '_', (string) $m->attachment_name) ?: 'allegato';

        return response()->file(storage_path('app/'.$m->attachment_path), [
            'Content-Type' => $m->attachment_mime,
            'Content-Disposition' => 'inline; filename="'.$name.'"',
            'X-Content-Type-Options' => 'nosniff',
            'Cache-Control' => 'private, no-store',
        ]);
    }

    /* ============================== supporto (superadmin) ============================== */

    public function platformIndex(Request $req): array
    {
        $this->requirePlatformAdmin($req);
        $status = (string) $req->query('status', 'active');
        $q = $this->baseList();
        if ($status === 'active') {
            $q->whereIn('t.status', ['open', 'answered']);
        } elseif (in_array($status, ['open', 'answered', 'closed'], true)) {
            $q->where('t.status', $status);
        }
        $counts = DB::table('support_tickets')->select('status', DB::raw('COUNT(*) as n'))->groupBy('status')->pluck('n', 'status');

        return [
            'data' => $q->orderByRaw("t.status = 'open' DESC")->orderByDesc('t.updated_at')->limit(300)->get()->map(fn ($r) => self::row($r, true))->all(),
            'counts' => ['open' => (int) ($counts['open'] ?? 0), 'answered' => (int) ($counts['answered'] ?? 0), 'closed' => (int) ($counts['closed'] ?? 0)],
        ];
    }

    public function platformReply(Request $req, string $id): array
    {
        $ctx = $this->requirePlatformAdmin($req);
        $t = $this->ticket($this->uuid($id));
        $b = $this->parseBody($req, S::object(['message' => S::reqText('Il messaggio', 5000)]));
        $file = $this->attachment($req);
        $now = Clock::now();
        $this->addMessage($t->id, $ctx->userId(), true, $b['message'], $file, $now);
        DB::table('support_tickets')->where('id', $t->id)->update(['status' => 'answered', 'updated_at' => $now, 'last_staff_at' => $now]);
        $this->notifyUser($t->id);

        return ['ok' => true];
    }

    public function platformStatus(Request $req, string $id): array
    {
        $this->requirePlatformAdmin($req);
        $t = $this->ticket($this->uuid($id));
        $b = $this->parseBody($req, S::object(['status' => S::enum(['open', 'answered', 'closed'])]));
        DB::table('support_tickets')->where('id', $t->id)->update(['status' => $b['status'], 'updated_at' => Clock::now()]);

        return ['ok' => true];
    }

    /* ============================== interni ============================== */

    private function baseList(): \Illuminate\Database\Query\Builder
    {
        return DB::table('support_tickets as t')
            ->join('users as u', 'u.id', '=', 't.user_id')
            ->join('companies as c', 'c.id', '=', 't.company_id')
            ->select(['t.*', 'u.name as user_name', 'u.email as user_email', 'c.name as company_name',
                DB::raw('(SELECT COUNT(*) FROM support_messages m WHERE m.ticket_id = t.id) as message_count')]);
    }

    private static function row(object $r, bool $staff = false): array
    {
        return [
            'id' => $r->id,
            'number' => (int) $r->number,
            'area' => $r->area,
            'areaLabel' => self::AREAS[$r->area] ?? $r->area,
            'kind' => $r->kind,
            'kindLabel' => self::KINDS[$r->kind] ?? $r->kind,
            'subject' => $r->subject,
            'status' => $r->status,
            'createdAt' => Clock::iso($r->created_at),
            'updatedAt' => Clock::iso($r->updated_at),
            'messageCount' => (int) $r->message_count,
            // risposta dell'assistenza non ancora letta da chi ha scritto
            'unread' => $r->last_staff_at !== null && ($r->user_seen_at === null || $r->last_staff_at > $r->user_seen_at),
            'userName' => $r->user_name,
            ...($staff ? ['company' => $r->company_name, 'companyId' => $r->company_id, 'userEmail' => $r->user_email, 'contactPhone' => $r->contact_phone] : []),
        ];
    }

    private function detail(object $t, bool $staff): array
    {
        $full = $this->baseList()->where('t.id', $t->id)->first();
        $msgs = DB::table('support_messages as m')->leftJoin('users as u', 'u.id', '=', 'm.author_id')
            ->where('m.ticket_id', $t->id)->orderBy('m.created_at')
            ->get(['m.id', 'm.from_staff', 'm.body', 'm.attachment_name', 'm.attachment_mime', 'm.attachment_path', 'm.created_at', 'u.name as author']);

        return [
            ...self::row($full, $staff),
            'contactPhone' => $t->contact_phone,
            ...($staff ? ['pageUrl' => $t->page_url, 'userAgent' => $t->user_agent] : []),
            'messages' => $msgs->map(fn ($m) => [
                'id' => $m->id,
                'fromStaff' => (bool) $m->from_staff,
                'author' => $m->from_staff ? 'Assistenza Ricetta Quadra' : $m->author,
                'body' => $m->body,
                'attachment' => $m->attachment_path ? ['name' => $m->attachment_name, 'mime' => $m->attachment_mime, 'url' => "/api/support/tickets/{$t->id}/attachments/{$m->id}"] : null,
                'createdAt' => Clock::iso($m->created_at),
            ])->all(),
        ];
    }

    private function ticket(string $id): object
    {
        $t = DB::table('support_tickets')->where('id', $id)->first();
        if (! $t) {
            throw AppError::notFound('Richiesta');
        }

        return $t;
    }

    /** Il supporto vede tutto; nell'azienda l'amministratore vede tutte le richieste, gli altri solo le proprie. */
    private function visibleTicket(AuthContext $ctx, string $id): object
    {
        $t = $this->ticket($id);
        if ($ctx->isPlatformAdmin()) {
            return $t;
        }
        $mine = $t->user_id === $ctx->userId();
        $sameCompanyAdmin = $ctx->company && $ctx->role === 'admin' && $t->company_id === $ctx->companyId();
        if (! $mine && ! $sameCompanyAdmin) {
            throw AppError::notFound('Richiesta');
        }

        return $t;
    }

    /** @return array{bytes: string, mime: string, name: string}|null */
    private function attachment(Request $req): ?array
    {
        $file = $req->file('attachment');
        if (! $file) {
            return null;
        }
        $max = (int) config('foodcost.support_max_bytes');
        if (! $file->isValid() || $file->getSize() > $max) {
            throw AppError::badRequest('file_too_large', 'Allegato troppo grande (massimo '.round($max / 1048576).' MB).');
        }
        $bytes = (string) file_get_contents($file->getRealPath());
        $mime = TariffBillController::sniff($bytes);
        if (! $mime) {
            $lower = mb_strtolower((string) $file->getClientOriginalName());
            throw AppError::badRequest('unsupported_type', str_ends_with($lower, '.heic') || str_ends_with($lower, '.heif')
                ? 'Le foto HEIC dell’iPhone non sono supportate: fai uno screenshot (è in PNG) o scatta in JPG.'
                : 'Allegato non supportato: carica un’immagine (JPG, PNG) o un PDF.');
        }

        return ['bytes' => $bytes, 'mime' => $mime, 'name' => mb_substr((string) $file->getClientOriginalName(), 0, 200) ?: 'allegato'];
    }

    private function addMessage(string $ticketId, ?string $authorId, bool $staff, string $body, ?array $file, string $now): void
    {
        $id = (string) Str::uuid();
        $rel = null;
        if ($file) {
            $rel = "support/{$ticketId}/{$id}.".self::FILE_TYPES[$file['mime']];
            $abs = storage_path('app/'.$rel);
            if (! is_dir(dirname($abs))) {
                mkdir(dirname($abs), 0700, true);
            }
            file_put_contents($abs, $file['bytes']);
            @chmod($abs, 0600);
        }
        DB::table('support_messages')->insert([
            'id' => $id,
            'ticket_id' => $ticketId,
            'author_id' => $authorId,
            'from_staff' => $staff,
            'body' => $body,
            'attachment_path' => $rel,
            'attachment_name' => $file['name'] ?? null,
            'attachment_mime' => $file['mime'] ?? null,
            'created_at' => $now,
        ]);
    }

    /** Avviso al supporto (gli utenti amministratori della piattaforma). Un errore di invio non blocca la richiesta. */
    private function notifyStaff(string $ticketId, string $what): void
    {
        try {
            $t = $this->baseList()->where('t.id', $ticketId)->first();
            $last = DB::table('support_messages')->where('ticket_id', $ticketId)->orderByDesc('created_at')->value('body');
            $link = config('foodcost.app_url')."/piattaforma/assistenza/{$ticketId}";
            $body = "{$what} #{$t->number} da {$t->user_name} ({$t->company_name})\n"
                .'Pagina: '.(self::AREAS[$t->area] ?? $t->area).' · '.(self::KINDS[$t->kind] ?? $t->kind)."\n"
                .($t->contact_phone ? "Telefono: {$t->contact_phone}\n" : '')
                ."\n{$t->subject}\n\n".mb_substr((string) $last, 0, 2000)."\n\nRispondi: {$link}\n";
            foreach (DB::table('users')->where('is_platform_admin', true)->pluck('email') as $to) {
                Mailer::send($to, "Assistenza #{$t->number} — {$t->subject}", $body);
            }
        } catch (Throwable $e) {
            Log::warning('support notifyStaff '.$e->getMessage());
        }
    }

    private function notifyUser(string $ticketId): void
    {
        try {
            $t = $this->baseList()->where('t.id', $ticketId)->first();
            $link = config('foodcost.app_url')."/assistenza/{$ticketId}";
            Mailer::send($t->user_email, "Ricetta Quadra — risposta alla richiesta #{$t->number}", "Ciao {$t->user_name},\n\nl’assistenza ha risposto alla tua richiesta «{$t->subject}».\nLeggi la risposta: {$link}\n\nRicetta Quadra\n");
        } catch (Throwable $e) {
            Log::warning('support notifyUser '.$e->getMessage());
        }
    }
}
