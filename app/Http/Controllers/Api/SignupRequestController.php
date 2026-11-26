<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Services\Audit;
use App\Services\Mailer;
use App\Services\Promoters;
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
 * NUOVO — Richieste di attivazione arrivate dal link di un promotore (o dalla pagina pubblica).
 * Il ristoratore compila la richiesta con il codice promo già inserito; il superadmin la approva
 * (crea azienda + invito con il promotore collegato) o la rifiuta.
 */
class SignupRequestController extends Controller
{
    /** Pubblica: il codice esiste ed è attivo? Restituisce la forma ufficiale, nient'altro. */
    public function checkCode(Request $req, string $code): array
    {
        RateLimit::hit('promo-check', (string) $req->ip(), 30, 60);
        $p = Promoters::findActive(mb_substr($code, 0, 40));

        return ['valid' => (bool) $p, 'code' => $p?->code];
    }

    /** Pubblica: nuova richiesta di attivazione. */
    public function store(Request $req): array
    {
        RateLimit::hit('signup-request', (string) $req->ip(), 5, 15 * 60);
        $body = $this->parseBody($req, S::object([
            'businessName' => S::string()->trim()->min(2, 'Indica il nome del locale.')->max(160),
            'contactName' => S::string()->trim()->min(2, 'Indica il tuo nome e cognome.')->max(120),
            'email' => S::string()->trim()->toLowerCase()->max(254)->refine(fn ($v) => filter_var($v, FILTER_VALIDATE_EMAIL) !== false, 'Email non valida.'),
            'phone' => S::string()->trim()->max(40)->nullable()->optional(),
            'city' => S::string()->trim()->max(80)->nullable()->optional(),
            'message' => S::string()->trim()->max(2000)->nullable()->optional(),
            'promoCode' => S::string()->trim()->max(40)->nullable()->optional(),
            'website' => S::string()->max(200)->nullable()->optional(), // trappola per i bot: deve restare vuoto
        ]));
        if (($body['website'] ?? '') !== '') {
            return ['ok' => true];
        }
        $promoter = ($body['promoCode'] ?? '') !== '' ? Promoters::require($body['promoCode']) : null;
        $row = [
            'business_name' => $body['businessName'], 'contact_name' => $body['contactName'], 'email' => $body['email'],
            'phone' => $body['phone'] ?? null, 'city' => $body['city'] ?? null, 'message' => $body['message'] ?? null,
            'promoter_id' => $promoter?->id, 'promo_code' => $promoter?->code,
        ];
        // la stessa email con una richiesta ancora aperta aggiorna quella (niente doppioni)
        $open = DB::table('signup_requests')->where('email', $body['email'])->where('status', 'pending')->first();
        if ($open) {
            if (! $promoter && $open->promoter_id) {
                unset($row['promoter_id'], $row['promo_code']);
            }
            DB::table('signup_requests')->where('id', $open->id)->update($row);
            $id = $open->id;
        } else {
            $id = (string) Str::uuid();
            DB::table('signup_requests')->insert([...$row, 'id' => $id, 'status' => 'pending', 'created_at' => Clock::now()]);
        }
        $this->notifyStaff($id);

        return ['ok' => true];
    }

    public function index(Request $req): array
    {
        $this->requirePlatformAdmin($req);
        $status = in_array($req->query('status'), ['pending', 'approved', 'rejected', 'all'], true) ? $req->query('status') : 'pending';
        $rows = DB::table('signup_requests as r')->leftJoin('promoters as p', 'p.id', '=', 'r.promoter_id')
            ->when($status !== 'all', fn ($q) => $q->where('r.status', $status))
            ->orderByDesc('r.created_at')->limit(200)->get(['r.*', 'p.name as promoter_name']);

        return [
            'data' => $rows->map(fn ($r) => [
                'id' => $r->id, 'businessName' => $r->business_name, 'contactName' => $r->contact_name, 'email' => $r->email,
                'phone' => $r->phone, 'city' => $r->city, 'message' => $r->message, 'status' => $r->status,
                'promoter' => $r->promoter_id ? ['id' => $r->promoter_id, 'name' => $r->promoter_name, 'code' => $r->promo_code] : null,
                'companyId' => $r->company_id, 'createdAt' => Clock::iso($r->created_at), 'handledAt' => Clock::iso($r->handled_at),
            ])->all(),
            'pending' => DB::table('signup_requests')->where('status', 'pending')->count(),
        ];
    }

    public function approve(Request $req, string $id): array
    {
        $auth = $this->requirePlatformAdmin($req);
        $r = $this->pending($this->uuid($id));
        $body = $this->parseBody($req, S::object([
            'name' => S::string()->trim()->min(2, 'Il nome dell’azienda è obbligatorio.')->max(160)->optional(),
            'adminName' => S::string()->trim()->min(2, 'Indica il nome dell’amministratore.')->max(120)->optional(),
            'adminEmail' => S::string()->trim()->toLowerCase()->refine(fn ($v) => filter_var($v, FILTER_VALIDATE_EMAIL) !== false, 'Email non valida.')->optional(),
            'sendEmail' => S::bool()->default(true),
        ]));
        $promoter = $r->promoter_id ? DB::table('promoters')->where('id', $r->promoter_id)->first() : null;

        $out = PlatformController::makeCompany(
            $auth, $body['name'] ?? $r->business_name, $body['adminName'] ?? $r->contact_name, $body['adminEmail'] ?? $r->email,
            $body['sendEmail'], $promoter, 'signup',
            fn (string $companyId) => DB::table('signup_requests')->where('id', $r->id)->update([
                'status' => 'approved', 'company_id' => $companyId, 'handled_at' => Clock::now(), 'handled_by' => $auth->userId(),
            ]),
        );
        Audit::log($out['id'], $auth->userId(), 'signup_request', $r->id, 'approved', ['email' => $r->email]);

        return $out;
    }

    public function reject(Request $req, string $id): array
    {
        $auth = $this->requirePlatformAdmin($req);
        $r = $this->pending($this->uuid($id));
        DB::table('signup_requests')->where('id', $r->id)->update(['status' => 'rejected', 'handled_at' => Clock::now(), 'handled_by' => $auth->userId()]);
        Audit::log(null, $auth->userId(), 'signup_request', $r->id, 'rejected', ['email' => $r->email]);

        return ['ok' => true];
    }

    private function pending(string $id): object
    {
        $r = DB::table('signup_requests')->where('id', $id)->first();
        if (! $r) {
            throw AppError::notFound('Richiesta');
        }
        if ($r->status !== 'pending') {
            throw new AppError(409, 'already_handled', 'Questa richiesta è già stata gestita.');
        }

        return $r;
    }

    private function notifyStaff(string $id): void
    {
        try {
            $r = DB::table('signup_requests')->where('id', $id)->first();
            $link = config('foodcost.app_url').'/piattaforma';
            $body = "Nuova richiesta di attivazione\n\nLocale: {$r->business_name}".($r->city ? " ({$r->city})" : '')
                ."\nReferente: {$r->contact_name} <{$r->email}>".($r->phone ? "\nTelefono: {$r->phone}" : '')
                .($r->promo_code ? "\nCodice promo: {$r->promo_code}" : "\nSenza codice promo")
                .($r->message ? "\n\n".mb_substr($r->message, 0, 2000) : '')."\n\nApprova o rifiuta: {$link}\n";
            foreach (DB::table('users')->where('is_platform_admin', true)->pluck('email') as $to) {
                Mailer::send($to, "Richiesta di attivazione — {$r->business_name}", $body);
            }
        } catch (Throwable $e) {
            Log::warning('signup notifyStaff '.$e->getMessage());
        }
    }
}
