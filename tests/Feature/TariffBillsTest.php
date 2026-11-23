<?php

namespace Tests\Feature;

use Illuminate\Http\Client\Request as HttpRequest;
use Illuminate\Http\UploadedFile;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Http;
use Tests\ApiClient;
use Tests\ApiResponse;
use Tests\Support\PdfFixture;
use Tests\TestCase;

/** NUOVO — Bollette delle utenze: caricamento, lettura automatica (servizio simulato), conferma, archivio. */
class TariffBillsTest extends TestCase
{
    private ApiClient $a;

    private string $company;

    private string $luce;

    private string $gas;

    private const PDF = "%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF";

    protected function setUp(): void
    {
        parent::setUp();
        $this->company = $this->createCompany('Trattoria Bollette');
        $this->addMember($this->company, $this->createUser('admin@bol.test', 'Admin'), 'admin');
        $this->addMember($this->company, $this->createUser('op@bol.test', 'Op'), 'operator');
        $this->a = $this->loginAs('admin@bol.test');
        $this->luce = $this->ok($this->a->post('/api/tariffs', ['name' => 'Elettricità', 'kind' => 'electricity', 'unit' => 'kwh']))['id'];
        $this->gas = $this->ok($this->a->post('/api/tariffs', ['name' => 'Gas cucina', 'kind' => 'gas', 'unit' => 'smc']))['id'];
        config(['foodcost.bill_ai.key' => 'chiave-di-prova', 'foodcost.bill_ai.url' => 'https://api.anthropic.com/v1/messages', 'foodcost.bill_ai.monthly_limit' => 40]);
    }

    protected function tearDown(): void
    {
        foreach (glob(storage_path("app/bills/{$this->company}/*")) ?: [] as $f) {
            @unlink($f);
        }
        @rmdir(storage_path("app/bills/{$this->company}"));
        parent::tearDown();
    }

    private function luceLetta(array $override = []): array
    {
        return array_merge([
            'e_una_bolletta' => true, 'tipo_utenza' => 'electricity', 'fornitore' => 'Enel Energia', 'numero_fattura' => '123',
            'data_emissione' => '2026-10-05', 'periodo_dal' => '2026-08-01', 'periodo_al' => '2026-09-30',
            'consumo' => '2000', 'unita_consumo' => 'kwh', 'consumo_stimato' => false,
            'voci' => [
                ['descrizione' => 'Spesa per la materia energia', 'importo_netto_iva' => '400.00', 'tipo' => 'variable', 'includi' => true],
                ['descrizione' => 'Trasporto e gestione contatore', 'importo_netto_iva' => '90.00', 'tipo' => 'variable', 'includi' => true],
                ['descrizione' => 'Oneri di sistema', 'importo_netto_iva' => '70.00', 'tipo' => 'variable', 'includi' => true],
                ['descrizione' => 'Quota fissa e potenza', 'importo_netto_iva' => '60.00', 'tipo' => 'fixed', 'includi' => true],
                ['descrizione' => 'Canone RAI', 'importo_netto_iva' => '18.00', 'tipo' => 'fixed', 'includi' => false],
            ],
            'imponibile_totale' => '638.00', 'aliquota_iva' => '10', 'totale_da_pagare' => '701.80', 'note' => null,
        ], $override);
    }

    private function fakeAi(array $input, int $status = 200): void
    {
        Http::fake(['api.anthropic.com/*' => Http::response($status === 200
            ? ['content' => [['type' => 'tool_use', 'name' => 'registra_bolletta', 'input' => $input]]]
            : ['error' => ['type' => 'api_error', 'message' => 'boom']], $status)]);
    }

    private function upload(string $tariff, string $content = self::PDF, string $name = 'bolletta.pdf', ?ApiClient $c = null): ApiResponse
    {
        $tmp = tempnam(sys_get_temp_dir(), 'bol');
        file_put_contents($tmp, $content);

        return ($c ?? $this->a)->request('POST', "/api/tariffs/{$tariff}/bills", null, true, null, ['file' => new UploadedFile($tmp, $name, 'application/octet-stream', null, true)]);
    }

    public function test_lettura_precompila_e_conferma_collega_la_bolletta(): void
    {
        $this->fakeAi($this->luceLetta());
        $r = $this->ok($this->upload($this->luce));
        $this->assertSame('ok', $r['readStatus']);
        $f = $r['form'];
        $this->assertSame(['2026-08-01', '2026-08-01', '2026-09-30', '2000', 'kwh'], [$f['validFrom'], $f['periodFrom'], $f['periodTo'], $f['consumption'], $f['consumptionUnit']]);
        // quote fisse proposte escluse (vanno nella redditività), canone RAI escluso
        $this->assertSame([true, true, true, false, false], array_column($f['components'], 'include'));
        $this->assertSame('Enel Energia', $r['info']['supplier']);
        $this->assertSame([], $r['warnings']);

        Http::assertSent(function (HttpRequest $req) {
            $b = $req->data();

            return $req->hasHeader('x-api-key', 'chiave-di-prova') && $b['tool_choice']['name'] === 'registra_bolletta'
                && $b['messages'][0]['content'][0]['type'] === 'document' && $b['messages'][0]['content'][0]['source']['media_type'] === 'application/pdf';
        });

        // conferma del ristoratore: il valore nasce collegato alla bolletta
        $v = $this->ok($this->a->post("/api/tariffs/{$this->luce}/versions", ['mode' => 'bill', 'vatBasis' => 'net', 'billFileId' => $r['id'], ...array_diff_key($f, ['m3ToSmc' => 1, 'smcToKwh' => 1])]));
        $list = $this->ok($this->a->get("/api/tariffs/{$this->luce}/bills"));
        $this->assertCount(1, $list['data']);
        $b = $list['data'][0];
        $this->assertSame($v['id'], $b['version']['id']);
        $this->assertSame('0.28000000', $b['version']['pricePerUnit']); // (400+90+70)/2000
        $this->assertSame(['Enel Energia', '2026-08-01', '2026-09-30', '701.80'], [$b['supplier'], $b['periodFrom'], $b['periodTo'], $b['totalAmount']]);

        // eliminando il valore la bolletta resta nell'archivio
        $this->ok($this->a->request('DELETE', "/api/tariffs/{$this->luce}/versions/{$v['id']}"));
        $b = $this->ok($this->a->get("/api/tariffs/{$this->luce}/bills"))['data'][0];
        $this->assertNull($b['version']);
    }

    public function test_file_scaricabile_ed_eliminabile(): void
    {
        $this->fakeAi($this->luceLetta());
        $id = $this->ok($this->upload($this->luce))['id'];
        $res = $this->a->get("/api/tariffs/{$this->luce}/bills/{$id}/file?download=1");
        $this->assertSame(200, $res->status);
        $this->assertSame(self::PDF, $res->raw->getContent());
        $this->assertSame('application/pdf', $res->raw->headers->get('Content-Type'));
        $this->assertStringStartsWith('attachment;', $res->raw->headers->get('Content-Disposition'));
        $this->assertSame('nosniff', $res->raw->headers->get('X-Content-Type-Options'));
        $path = storage_path('app/'.DB::table('tariff_bills')->where('id', $id)->value('storage_path'));
        $this->assertFileExists($path);

        $this->ok($this->a->request('DELETE', "/api/tariffs/{$this->luce}/bills/{$id}"));
        $this->assertFileDoesNotExist($path);
        $this->assertSame(404, $this->a->get("/api/tariffs/{$this->luce}/bills/{$id}/file")->status);
    }

    public function test_senza_chiave_foto_archiviata_e_pdf_senza_testo(): void
    {
        config(['foodcost.bill_ai.key' => '']);
        Http::fake();
        $png = base64_decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==');
        $r = $this->ok($this->upload($this->luce, $png, 'foto.png'));
        $this->assertSame('off', $r['readStatus']);
        $this->assertNull($r['form']);
        $this->assertStringContainsString('foto non si leggono', $r['message']);
        // PDF senza testo (scansione) e PDF danneggiato
        $r = $this->ok($this->upload($this->luce, PdfFixture::make([])));
        $this->assertSame(['failed', 'local'], [$r['readStatus'], $r['method']]);
        $this->assertStringContainsString('non contiene testo', $r['message']);
        $this->assertStringContainsString('danneggiato', $this->ok($this->upload($this->luce))['message']);
        Http::assertNothingSent();
        $meta = $this->ok($this->a->get("/api/tariffs/{$this->luce}/bills"))['meta'];
        $this->assertSame([false, 'local'], [$meta['aiEnabled'], $meta['reader']]);
    }

    public function test_lettura_locale_luce(): void
    {
        config(['foodcost.bill_ai.key' => '']);
        Http::fake();
        $r = $this->ok($this->upload($this->luce, PdfFixture::make(PdfFixture::LUCE)));
        $this->assertSame(['ok', 'local'], [$r['readStatus'], $r['method']]);
        $f = $r['form'];
        $this->assertSame(['2026-08-01', '2026-09-30', '2000'], [$f['periodFrom'], $f['periodTo'], $f['consumption']]);
        $this->assertSame([['Spesa per la materia / vendita', '400', true], ['Trasporto e gestione del contatore', '90', true], ['Oneri di sistema', '70', true], ['Imposte (accise)', '45', true], ['Canone TV', '18', false]],
            array_map(fn ($c) => [$c['label'], $c['amount'], $c['include']], $f['components']));
        $this->assertSame(['Enel Energia', '004512345678', '2026-10-05', '703.3', '623'], [$r['info']['supplier'], $r['info']['billNumber'], $r['info']['issueDate'], $r['info']['totalAmount'], $r['info']['taxableAmount']]);
        $this->assertSame([], $r['warnings']);
        $this->assertTrue(collect($r['found'])->every(fn ($x) => $x['ok']));
        Http::assertNothingSent();
        // conferma: (400 + 90 + 70 + 45) / 2000 = 0,3025 €/kWh
        $this->ok($this->a->post("/api/tariffs/{$this->luce}/versions", ['mode' => 'bill', 'vatBasis' => 'net', 'billFileId' => $r['id'], ...array_diff_key($f, ['m3ToSmc' => 1, 'smcToKwh' => 1])]));
        $this->assertSame('0.30250000', $this->ok($this->a->get("/api/tariffs/{$this->luce}/bills"))['data'][0]['version']['pricePerUnit']);
    }

    public function test_lettura_locale_gas_bolletta_trasparente(): void
    {
        config(['foodcost.bill_ai.key' => '']);
        $r = $this->ok($this->upload($this->gas, PdfFixture::make(PdfFixture::GAS)));
        $f = $r['form'];
        $this->assertSame(['2026-08-01', '2026-09-30', '500', 'smc', '1.02', '10.7'], [$f['periodFrom'], $f['periodTo'], $f['consumption'], $f['consumptionUnit'], $f['m3ToSmc'], $f['smcToKwh']]);
        $this->assertSame(['300', '120', '60'], array_column($f['components'], 'amount'));
        $this->assertSame(['A2A Energia', '528'], [$r['info']['supplier'], $r['info']['totalAmount']]);
        $this->assertFalse(collect($r['found'])->firstWhere('label', 'Imponibile')['ok']);
    }

    public function test_lettura_locale_acqua(): void
    {
        config(['foodcost.bill_ai.key' => '']);
        $acqua = $this->ok($this->a->post('/api/tariffs', ['name' => 'Acqua', 'kind' => 'water', 'unit' => 'm3']))['id'];
        $r = $this->ok($this->upload($acqua, PdfFixture::make(PdfFixture::ACQUA)));
        $f = $r['form'];
        $this->assertSame(['2026-07-01', '2026-09-30', '85'], [$f['periodFrom'], $f['periodTo'], $f['consumption']]);
        $this->assertSame([['Acquedotto', '95.2'], ['Fognatura', '30.1'], ['Depurazione', '60.4'], ['Quota fissa', '12.5']], array_map(fn ($c) => [$c['label'], $c['amount']], $f['components']));
        $this->assertSame('Publiacqua', $r['info']['supplier']);
    }

    public function test_errore_del_servizio_non_perde_il_file(): void
    {
        $this->fakeAi([], 500);
        $r = $this->ok($this->upload($this->luce));
        $this->assertSame('failed', $r['readStatus']);
        $this->assertStringContainsString('archiviata', $r['message']);
        $this->assertCount(1, $this->ok($this->a->get("/api/tariffs/{$this->luce}/bills"))['data']);
    }

    public function test_limite_mensile(): void
    {
        config(['foodcost.bill_ai.monthly_limit' => 1]);
        $this->fakeAi($this->luceLetta());
        $this->assertSame('ok', $this->ok($this->upload($this->luce))['readStatus']);
        $r = $this->ok($this->upload($this->luce, self::PDF.' '));
        $this->assertSame('limit', $r['readStatus']);
        Http::assertSentCount(1);
    }

    public function test_tipi_di_file_controllati_dal_contenuto(): void
    {
        $this->fakeAi($this->luceLetta());
        $this->assertSame('unsupported_type', $this->upload($this->luce, 'MZ eseguibile', 'bolletta.pdf')->body['error']['code']);
        $this->assertStringContainsString('HEIC', $this->upload($this->luce, 'xxxxftypheic', 'foto.heic')->body['error']['message']);
        // una foto PNG viene inviata come immagine
        $png = base64_decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==');
        $this->assertSame('ok', $this->ok($this->upload($this->luce, $png, 'foto.png'))['readStatus']);
        Http::assertSent(fn (HttpRequest $r) => $r->data()['messages'][0]['content'][0]['type'] === 'image');
        // doppione segnalato
        $this->assertSame('Questa bolletta era già stata caricata in questa utenza.', $this->ok($this->upload($this->luce, $png, 'foto.png'))['warnings'][0]);
    }

    public function test_gas_in_metri_cubi_convertito_e_coefficienti(): void
    {
        $this->fakeAi($this->luceLetta(['tipo_utenza' => 'gas', 'consumo' => '500', 'unita_consumo' => 'm3', 'coefficiente_c' => '1.02', 'pcs_gj_smc' => '0.03852', 'consumo_stimato' => true]));
        $r = $this->ok($this->upload($this->gas));
        $this->assertSame('510', $r['form']['consumption']);
        $this->assertSame('smc', $r['form']['consumptionUnit']);
        $this->assertSame('1.02', $r['form']['m3ToSmc']);
        $this->assertSame('10.7', $r['form']['smcToKwh']);
        $this->assertStringContainsString('convertito in Smc', implode(' ', $r['warnings']));
        $this->assertStringContainsString('stimati', implode(' ', $r['warnings']));
    }

    public function test_avvisi_utenza_sbagliata_e_somma_diversa(): void
    {
        $this->fakeAi($this->luceLetta(['imponibile_totale' => '900.00']));
        $r = $this->ok($this->upload($this->gas));
        $w = implode(' ', $r['warnings']);
        $this->assertStringContainsString('sembra di luce', $w);
        $this->assertStringContainsString('non coincide con l’imponibile', $w);
        // kWh su utenza gas: consumo non riportato
        $this->assertNull($r['form']['consumption']);
    }

    public function test_permessi_e_isolamento(): void
    {
        $this->fakeAi($this->luceLetta());
        $id = $this->ok($this->upload($this->luce))['id'];
        $op = $this->loginAs('op@bol.test');
        $this->assertSame(403, $this->upload($this->luce, self::PDF, 'b.pdf', $op)->status);
        $this->assertSame(403, $op->request('DELETE', "/api/tariffs/{$this->luce}/bills/{$id}")->status);

        $other = $this->createCompany('Altra');
        $this->addMember($other, $this->createUser('x@altra.test', 'X'), 'admin');
        $x = $this->loginAs('x@altra.test');
        $this->assertSame(404, $x->get("/api/tariffs/{$this->luce}/bills")->status);
        $this->assertSame(404, $x->get("/api/tariffs/{$this->luce}/bills/{$id}/file")->status);
        $altra = $this->ok($x->post('/api/tariffs', ['name' => 'Luce', 'kind' => 'electricity', 'unit' => 'kwh']))['id'];
        // non si può collegare la bolletta di un'altra azienda
        $res = $x->post("/api/tariffs/{$altra}/versions", ['mode' => 'bill', 'vatBasis' => 'net', 'billFileId' => $id, 'validFrom' => '2026-08-01', 'periodFrom' => '2026-08-01', 'periodTo' => '2026-09-30', 'consumption' => '10', 'consumptionUnit' => 'kwh', 'components' => [['label' => 'x', 'amount' => '1', 'kind' => 'variable', 'include' => true]]]);
        $this->assertSame(422, $res->status);
        $this->assertSame(0, DB::table('tariff_versions')->where('tariff_id', $altra)->count());
    }
}
