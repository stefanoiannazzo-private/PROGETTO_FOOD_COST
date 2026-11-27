<?php

namespace App\Http\Controllers\Api;

use App\Auth\Crypto;
use App\Http\Controllers\Controller;
use App\Support\AppError;
use App\Support\Clock;
use App\Support\RateLimit;
use App\Support\Validation\S;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;

/**
 * NUOVO — Menu digitale pubblico (QR sul tavolo), senza login.
 * Modalità decise dal locale: spento, libero, registrazione obbligatoria, registrazione facoltativa con omaggio.
 * Il cliente registrato riceve un gettone salvato sul suo telefono: non deve registrarsi di nuovo.
 * Ordinare dal telefono è predisposto (guest_ordering) ma non ancora attivo.
 */
class PublicMenuController extends Controller
{
    public function show(Request $req, string $token): array
    {
        RateLimit::hit('public-menu', (string) $req->ip(), 120, 60);
        [$company, $settings] = $this->company($token);

        return $this->payload($req, $company, $settings, null);
    }

    public function showTable(Request $req, string $qr): array
    {
        RateLimit::hit('public-menu', (string) $req->ip(), 120, 60);
        $table = DB::table('dining_tables')->where('qr_token', $qr)->where('is_active', 1)->first();
        if (! $table) {
            throw AppError::notFound('Menu');
        }
        $s = DB::table('ordering_settings')->where('company_id', $table->company_id)->first();
        if (! $s) {
            throw AppError::notFound('Menu');
        }
        [$company, $settings] = $this->company($s->public_token);

        return $this->payload($req, $company, $settings, $table);
    }

    /** Registrazione del cliente (nome, cognome, email, telefono, consenso privacy). */
    public function register(Request $req, string $token): array
    {
        RateLimit::hit('public-guest', (string) $req->ip(), 8, 15 * 60);
        [$company, $s] = $this->company($token);
        if (! in_array($s->public_mode, ['required', 'optional'], true)) {
            throw new AppError(409, 'registration_off', 'Questo locale non chiede la registrazione.');
        }
        $b = $this->parseBody($req, S::object([
            'firstName' => S::reqText('Il nome', 80),
            'lastName' => S::reqText('Il cognome', 80),
            'email' => S::string()->trim()->toLowerCase()->max(254)->refine(fn ($v) => filter_var($v, FILTER_VALIDATE_EMAIL) !== false, 'Email non valida.'),
            'phone' => S::string()->trim()->max(40)->refine(fn ($v) => preg_match('/^\+?[0-9 ().-]{6,}$/', $v) === 1, 'Telefono non valido.'),
            'privacyOk' => S::bool(),
            'marketing' => S::bool()->default(false),
            'tableQr' => S::string()->max(40)->nullable()->optional(),
            'website' => S::string()->max(200)->nullable()->optional(), // trappola per i bot
        ]));
        if (! $b['privacyOk']) {
            $msg = 'Per continuare serve il consenso al trattamento dei dati.';
            throw new AppError(422, 'validation_failed', $msg, ['fields' => ['privacyOk' => $msg]]);
        }
        if (($b['website'] ?? '') !== '') {
            throw new AppError(422, 'validation_failed', 'Richiesta non valida.');
        }
        $tableId = ($b['tableQr'] ?? null) ? DB::table('dining_tables')->where('qr_token', $b['tableQr'])->where('company_id', $company->id)->value('id') : null;
        $plain = Str::random(40);
        $gift = $s->public_mode === 'optional' && $s->gift_text ? $s->gift_text : null;
        $code = $gift ? strtoupper(Str::random(3)).'-'.random_int(100, 999) : null;
        DB::table('menu_guests')->insert([
            'id' => (string) Str::uuid(), 'company_id' => $company->id, 'first_name' => $b['firstName'], 'last_name' => $b['lastName'],
            'email' => $b['email'], 'phone' => $b['phone'], 'marketing_consent' => $b['marketing'] ? 1 : 0, 'privacy_accepted_at' => Clock::now(),
            'table_id' => $tableId, 'token_hash' => Crypto::hashToken($plain), 'gift_text' => $gift, 'gift_code' => $code, 'created_at' => Clock::now(),
        ]);

        return ['guestToken' => $plain, 'gift' => $gift ? ['text' => $gift, 'code' => $code] : null, 'firstName' => $b['firstName']];
    }

    /* ------------------------------------------------------------------ */

    private function company(string $token): array
    {
        $s = DB::table('ordering_settings')->where('public_token', $token)->first();
        $company = $s ? DB::table('companies')->where('id', $s->company_id)->whereNull('archived_at')->first(['id', 'name']) : null;
        if (! $s || ! $company) {
            throw AppError::notFound('Menu');
        }

        return [$company, $s];
    }

    private function guest(Request $req, string $companyId): ?object
    {
        $t = (string) $req->header('X-Guest-Token', '');

        return $t !== '' ? DB::table('menu_guests')->where('company_id', $companyId)->where('token_hash', Crypto::hashToken($t))->first() : null;
    }

    private function payload(Request $req, object $company, object $s, ?object $table): array
    {
        $guest = $this->guest($req, $company->id);
        $base = [
            'company' => $company->name, 'token' => $s->public_token, 'mode' => $s->public_mode, 'table' => $table?->label, 'tableQr' => $table?->qr_token,
            'giftText' => $s->public_mode === 'optional' ? $s->gift_text : null, 'coverCharge' => $s->cover_charge,
            'guest' => $guest ? ['firstName' => $guest->first_name, 'gift' => $guest->gift_code ? ['text' => $guest->gift_text, 'code' => $guest->gift_code, 'redeemed' => $guest->gift_redeemed_at !== null] : null] : null,
            'ordering' => false, // predisposto: il cliente ordina dal telefono (da attivare)
        ];
        if ($s->public_mode === 'off') {
            return [...$base, 'locked' => true, 'sections' => []];
        }
        if ($s->public_mode === 'required' && ! $guest) {
            return [...$base, 'locked' => true, 'sections' => []];
        }
        $sections = DB::table('menu_sections')->where('company_id', $company->id)->where('is_visible', 1)->orderBy('sort')->get();
        $items = DB::table('menu_items')->where('company_id', $company->id)->whereNull('archived_at')->where('is_public', 1)->whereIn('section_id', $sections->pluck('id'))->orderBy('sort')->orderBy('name')->get();

        return [...$base, 'locked' => false, 'sections' => $sections->map(fn ($x) => [
            'id' => $x->id, 'name' => $x->name,
            'items' => $items->where('section_id', $x->id)->values()->map(fn ($m) => ['id' => $m->id, 'name' => $m->name, 'description' => $m->description, 'price' => $m->price, 'isAvailable' => (bool) $m->is_available])->all(),
        ])->filter(fn ($x) => count($x['items']) > 0)->values()->all()];
    }
}
