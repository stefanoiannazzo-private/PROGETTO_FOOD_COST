<?php

namespace Tests\Feature;

use App\Services\Imports\Reader;
use App\Services\Jobs;
use App\Support\Clock;
use Illuminate\Http\UploadedFile;
use Illuminate\Support\Facades\DB;
use OpenSpout\Common\Entity\Cell;
use OpenSpout\Common\Entity\Row;
use OpenSpout\Writer\XLSX\Writer;
use Tests\ApiClient;
use Tests\ApiResponse;
use Tests\TestCase;

/** Port di apps/api/test/imports.test.ts (ogni test ricostruisce i propri prerequisiti). */
class ImportsTest extends TestCase
{
    private ApiClient $admin;

    private ApiClient $manager;

    private ApiClient $other;

    protected function setUp(): void
    {
        parent::setUp();
        $c = $this->createCompany('Laboratorio Import');
        $this->addMember($c, $this->createUser('admin@imp.test', 'Admin'), 'admin');
        $this->addMember($c, $this->createUser('resp@imp.test', 'Resp'), 'manager');
        $c2 = $this->createCompany('Altra azienda');
        $this->addMember($c2, $this->createUser('altro@imp.test', 'Altro'), 'admin');
        $this->admin = $this->loginAs('admin@imp.test');
        $this->manager = $this->loginAs('resp@imp.test');
        $this->other = $this->loginAs('altro@imp.test');
    }

    private function upload(ApiClient $c, string $type, string $filename, string $content): ApiResponse
    {
        $tmp = tempnam(sys_get_temp_dir(), 'fcup');
        file_put_contents($tmp, $content);

        return $c->upload('/api/imports', $type, new UploadedFile($tmp, $filename, 'application/octet-stream', null, true));
    }

    private function drain(): void
    {
        while (Jobs::runPending(null, 120) > 0) {
            // continua
        }
    }

    private function validate(ApiClient $c, string $id, array $mapping, array $options = []): array
    {
        $this->ok($c->post("/api/imports/{$id}/validate", ['options' => array_merge(['headerRow' => 1, 'numberFormat' => 'it', 'onExisting' => 'update', 'onNew' => 'create', 'generateCodes' => true], $options), 'mapping' => $mapping]));
        $this->drain();

        return $this->ok($c->get("/api/imports/{$id}"));
    }

    private static function latin1(string $s): string
    {
        return mb_convert_encoding($s, 'ISO-8859-1', 'UTF-8');
    }

    private function assertSubset(array $expected, array $actual): void
    {
        foreach ($expected as $k => $v) {
            $this->assertArrayHasKey($k, $actual);
            $this->assertSame($v, $actual[$k], "chiave {$k}");
        }
    }

    // --- Importazione ingredienti da CSV italiano ---

    public function test_modelli_csv_e_xlsx(): void
    {
        $csv = $this->admin->get('/api/imports/templates/ingredients.csv');
        $this->assertSame(200, $csv->status);
        $this->assertStringContainsString('Codice;Nome;Categoria', (string) $csv->body);
        $x = $this->admin->get('/api/imports/templates/ingredients.xlsx');
        $this->assertSame(200, $x->status, substr((string) $x->raw->getContent(), 0, 300));
        $tmp = tempnam(sys_get_temp_dir(), 'fcx').'.xlsx';
        $raw = $x->raw;
        file_put_contents($tmp, $raw instanceof \Symfony\Component\HttpFoundation\BinaryFileResponse ? file_get_contents($raw->getFile()->getPathname()) : $raw->getContent());
        $this->assertSame(['Dati', 'Istruzioni'], Reader::listSheets($tmp));
    }

    private const LISTINO = [
        'Codice;Nome;Categoria;Fornitore;Prezzo confezione;Contenuto confezione;Unità contenuto;Data prezzo;Resa edibile %',
        'FAR-00;Farina 00;Farine;Molino;19,50;25;kg;01/01/2026;',
        'CAF-01;Caffè in grani;Bevande;Torrefazione;1.250,00;60;kg;01/01/2026;',
        'CAR-01;Carote;Verdure;Orto;5,50;5;kg;01/01/2026;80',
        ';Zucchero semolato;Dolcificanti;;12,00;10;kg;01/01/2026;',
    ];

    private function uploadListino(): ApiResponse
    {
        return $this->upload($this->admin, 'ingredients', 'listino.csv', self::latin1(implode("\r\n", self::LISTINO)));
    }

    /** Carica, valida e applica il listino (prerequisito dei test successivi nell'originale). */
    private function applyListino(): string
    {
        $r = $this->uploadListino();
        $imp = $this->validate($this->admin, $r->body['id'], $r->body['suggestedMapping'], ['encoding' => 'latin1', 'delimiter' => ';']);
        $this->ok($this->admin->post("/api/imports/{$r->body['id']}/confirm", ['lockVersion' => $imp['lockVersion']]));
        $this->drain();

        return $r->body['id'];
    }

    public function test_rileva_separatore_codifica_e_abbinamento(): void
    {
        $r = $this->uploadListino();
        $this->assertSame(200, $r->status, json_encode($r->body));
        $this->assertSame(';', $r->body['detected']['delimiter']);
        $this->assertSame('latin1', $r->body['detected']['encoding']);
        $this->assertContains('Unità contenuto', $r->body['headers']);
        $this->assertSame('Caffè in grani', $r->body['sample'][1][1]);
        $this->assertSubset(['code' => 'Codice', 'name' => 'Nome', 'packagePrice' => 'Prezzo confezione', 'packageUnit' => 'Unità contenuto', 'priceDate' => 'Data prezzo', 'edibleYieldPercent' => 'Resa edibile %'], $r->body['suggestedMapping']);
    }

    public function test_valida_tutto_prima_di_scrivere(): void
    {
        $r = $this->uploadListino();
        $id = $r->body['id'];
        $imp = $this->validate($this->admin, $id, $r->body['suggestedMapping'], ['encoding' => 'latin1', 'delimiter' => ';']);
        $this->assertSame('validated', $imp['status']);
        $this->assertSubset(['totalRows' => 4, 'create' => 4, 'update' => 0, 'error' => 0], $imp['summary']);
        $rows = collect($this->ok($this->admin->get("/api/imports/{$id}/rows"))['data'])->keyBy('row_number');
        $this->assertSubset(['packagePrice' => '1250', 'packageContent' => '60', 'priceDate' => '2026-01-01'], $rows[3]['normalized']);
        $this->assertSame('80', $rows[4]['normalized']['edibleYieldPercent']);
        $this->assertMatchesRegularExpression('/generato/', $rows[5]['warnings'][0]);
        $this->assertSame(0, DB::table('ingredients')->count());
    }

    /** NUOVO: il superadmin in «Assisti» importa per il cliente; un ex superadmin no. */
    public function test_importazione_in_modalita_assistenza(): void
    {
        $company = DB::table('companies')->where('name', 'Laboratorio Import')->value('id');
        $this->createUser('super@imp.test', 'Super', true);
        $s = $this->loginAs('super@imp.test');
        $this->ok($s->post('/api/auth/company', ['companyId' => $company]));
        $r = $this->upload($s, 'ingredients', 'listino.csv', self::latin1(implode("\r\n", self::LISTINO)));
        $id = $r->body['id'];
        $this->validate($s, $id, $r->body['suggestedMapping'], ['encoding' => 'latin1', 'delimiter' => ';']);
        $imp = $this->ok($s->get("/api/imports/{$id}"));
        $this->ok($s->post("/api/imports/{$id}/confirm", ['lockVersion' => $imp['lockVersion']]));
        $this->drain();
        $this->assertSame('applied', $this->ok($s->get("/api/imports/{$id}"))['status']);
        $this->assertSame(4, $this->ok($this->admin->get('/api/ingredients'))['meta']['total'], 'il cliente vede i prodotti importati');
        $this->assertSame(1, DB::table('audit_logs')->where('entity_id', $id)->where('action', 'applied')->where('user_id', DB::table('users')->where('email', 'super@imp.test')->value('id'))->count());

        // se nel frattempo non è più superadmin, l'importazione non si applica
        $r2 = $this->upload($s, 'ingredients', 'listino2.csv', self::latin1(implode("\r\n", self::LISTINO)));
        $this->validate($s, $r2->body['id'], $r2->body['suggestedMapping'], ['encoding' => 'latin1', 'delimiter' => ';']);
        $imp2 = $this->ok($s->get("/api/imports/{$r2->body['id']}"));
        $this->ok($s->post("/api/imports/{$r2->body['id']}/confirm", ['lockVersion' => $imp2['lockVersion']]));
        DB::table('users')->where('email', 'super@imp.test')->update(['is_platform_admin' => 0]);
        $this->drain();
        $this->assertSame('failed', DB::table('imports')->where('id', $r2->body['id'])->value('status'));
    }

    public function test_conferma_applicazione_atomica_idempotente(): void
    {
        $r = $this->uploadListino();
        $id = $r->body['id'];
        $this->validate($this->admin, $id, $r->body['suggestedMapping'], ['encoding' => 'latin1', 'delimiter' => ';']);
        $imp = $this->ok($this->admin->get("/api/imports/{$id}"));
        $this->ok($this->admin->post("/api/imports/{$id}/confirm", ['lockVersion' => $imp['lockVersion']]));
        $again = $this->ok($this->admin->post("/api/imports/{$id}/confirm", ['lockVersion' => $imp['lockVersion']]));
        $this->assertTrue($again['alreadyConfirmed']);
        $this->drain();
        $this->assertSame('applied', $this->ok($this->admin->get("/api/imports/{$id}"))['status']);
        $list = $this->ok($this->admin->get('/api/ingredients?sort=code'));
        $this->assertSame(4, $list['meta']['total']);
        $caffe = collect($list['data'])->firstWhere('code', 'CAF-01');
        $this->assertSame('1250.000000', $caffe['price']['packagePrice']);
        $this->assertStringStartsWith('20.8333', $caffe['price']['unitPrice']);
        $this->assertMatchesRegularExpression('/^ING-\d{5}$/', collect($list['data'])->firstWhere('name', 'Zucchero semolato')['code']);
        $prices = DB::table('ingredient_prices')->get();
        $this->assertCount(4, $prices);
        $this->assertTrue($prices->every(fn ($p) => $p->import_id === $id));
        DB::table('jobs')->insert(['type' => 'import.apply', 'payload' => json_encode(['importId' => $id]), 'run_at' => Clock::now(), 'created_at' => Clock::now()]);
        $this->drain();
        $this->assertSame(4, DB::table('ingredient_prices')->count());
    }

    public function test_reimport_prezzi_identici_e_diversi(): void
    {
        $this->applyListino();
        $same = self::latin1("Codice;Nome;Prezzo confezione;Contenuto confezione;Unità contenuto;Data prezzo\r\nFAR-00;Farina 00;19,50;25;kg;01/01/2026\r\n");
        $r = $this->upload($this->admin, 'ingredients', 'ripeto.csv', $same);
        $imp = $this->validate($this->admin, $r->body['id'], $r->body['suggestedMapping']);
        $this->assertSubset(['update' => 1, 'error' => 0], $imp['summary']);
        $rows = $this->ok($this->admin->get("/api/imports/{$r->body['id']}/rows"));
        $this->assertMatchesRegularExpression('/non verrà duplicato/', $rows['data'][0]['warnings'][0]);
        $this->ok($this->admin->post("/api/imports/{$r->body['id']}/confirm", ['lockVersion' => $imp['lockVersion']]));
        $this->drain();
        $this->assertSame(4, DB::table('ingredient_prices')->count());

        $diff = self::latin1("Codice;Prezzo confezione;Data prezzo;Contenuto confezione;Unità contenuto;Nome\r\nFAR-00;21,00;01/01/2026;25;kg;Farina\r\n");
        $r2 = $this->upload($this->admin, 'ingredients', 'diverso.csv', $diff);
        $imp2 = $this->validate($this->admin, $r2->body['id'], $r2->body['suggestedMapping']);
        $this->assertSame(1, $imp2['summary']['error']);
        $this->assertSame(409, $this->admin->post("/api/imports/{$r2->body['id']}/confirm", ['lockVersion' => $imp2['lockVersion']])->status);
    }

    // --- Errori, duplicati e atomicità ---

    public function test_duplicati_e_dati_non_validi(): void
    {
        $csv = implode("\n", [
            'Codice;Nome;Prezzo confezione;Contenuto confezione;Unità contenuto;Data prezzo',
            'DUP-1;Uno;1,00;1;kg;01/02/2026',
            'DUP-1;Uno bis;2,00;1;kg;01/02/2026',
            'BAD-1;Litri senza densità;3,00;0;kg;31/02/2026',
            'BAD-2;Unità strana;3,00;1;sacchi;01/02/2026',
            'OK-1;Valido;3,00;1;kg;01/02/2026',
            'BAD-3;Prezzo senza data;3,00;1;kg;',
        ]);
        $r = $this->upload($this->admin, 'ingredients', 'errori.csv', $csv);
        $imp = $this->validate($this->admin, $r->body['id'], $r->body['suggestedMapping']);
        $this->assertSubset(['totalRows' => 6, 'error' => 5, 'create' => 1, 'duplicates' => 1], $imp['summary']);
        $errs = $this->ok($this->admin->get("/api/imports/{$r->body['id']}/rows?action=error"));
        $text = json_encode(array_column($errs['data'], 'errors'), JSON_UNESCAPED_UNICODE);
        foreach (['/duplicato nel file \(righe 2, 3\)/', '/non è una data esistente/', '/maggiore di zero/', '/sacchi/', '/Data del prezzo obbligatoria/'] as $re) {
            $this->assertMatchesRegularExpression($re, $text);
        }
        $this->assertSame(409, $this->admin->post("/api/imports/{$r->body['id']}/confirm", ['lockVersion' => $imp['lockVersion']])->status);
        $this->assertSame(0, DB::table('ingredients')->where('code', 'OK-1')->count());
    }

    public function test_report_neutralizza_formule(): void
    {
        $csv = "Codice;Nome;Contenuto confezione;Unità contenuto\nINJ-1;\"=HYPERLINK(\"\"http://x\"\",\"\"clic\"\")\";0;kg\n";
        $r = $this->upload($this->admin, 'ingredients', 'inj.csv', $csv);
        $this->validate($this->admin, $r->body['id'], $r->body['suggestedMapping']);
        $rep = (string) $this->admin->get("/api/imports/{$r->body['id']}/report.csv")->body;
        $this->assertStringContainsString(';"\'=HYPERLINK(""http://x"",""clic"")";', $rep);
        $this->assertDoesNotMatchRegularExpression('/;=HYPERLINK/', $rep);
        $this->assertSame("\u{FEFF}Riga;Esito;Errori;Avvisi;Codice;Nome;Contenuto confezione;Unità contenuto", explode("\r\n", $rep)[0]);
    }

    public function test_modifica_dopo_anteprima_fallisce_senza_scrivere(): void
    {
        $this->applyListino();
        $csv = "Codice;Nome;Prezzo confezione;Contenuto confezione;Unità contenuto;Data prezzo\nCAR-01;Carote bio;6,00;5;kg;01/03/2026\nNEW-9;Nuovo;1,00;1;kg;01/03/2026\n";
        $r = $this->upload($this->admin, 'ingredients', 'conflitto.csv', $csv);
        $imp = $this->validate($this->admin, $r->body['id'], $r->body['suggestedMapping']);
        $this->assertSubset(['update' => 1, 'create' => 1, 'error' => 0], $imp['summary']);
        usleep(20_000);
        DB::table('ingredients')->where('code', 'CAR-01')->update(['notes' => 'modifica concorrente', 'updated_at' => Clock::now()]);
        $this->ok($this->admin->post("/api/imports/{$r->body['id']}/confirm", ['lockVersion' => $imp['lockVersion']]));
        $this->drain();
        $after = $this->ok($this->admin->get("/api/imports/{$r->body['id']}"));
        $this->assertSame('failed', $after['status']);
        $this->assertMatchesRegularExpression('/modificato dopo l’anteprima/u', $after['error']);
        $this->assertSame(0, DB::table('ingredients')->where('code', 'NEW-9')->count());
    }

    /** Senza worker: la sola richiesta di avanzamento (GET) fa procedere validazione e applicazione di quell'importazione. */
    public function test_avanzamento_senza_worker_tramite_polling(): void
    {
        $r = $this->uploadListino();
        $id = $r->body['id'];
        $this->ok($this->admin->post("/api/imports/{$id}/validate", ['options' => ['headerRow' => 1, 'encoding' => 'latin1', 'delimiter' => ';'], 'mapping' => $r->body['suggestedMapping']]));
        $imp = $this->ok($this->admin->get("/api/imports/{$id}"));
        $this->assertSame('validated', $imp['status']);
        $this->ok($this->admin->post("/api/imports/{$id}/confirm", ['lockVersion' => $imp['lockVersion']]));
        $this->assertSame('applied', $this->ok($this->admin->get("/api/imports/{$id}"))['status']);
        $this->assertSame(4, DB::table('ingredients')->count());
        // il filtro per importazione non tocca i lavori di altre importazioni
        Jobs::enqueue('import.validate', ['importId' => '00000000-0000-4000-8000-000000000000']);
        $this->assertSame(0, Jobs::runPending($id, 5));
    }

    /** Codici generati in sequenza (come Codes::next riga per riga) e conflitto con un codice esplicito successivo. */
    public function test_codici_generati_in_sequenza(): void
    {
        $ok = "Codice;Nome;Contenuto confezione;Unità contenuto\n;Uno;1;kg\nING-00007;Sette;1;kg\n;Otto;1;kg\n";
        $r = $this->upload($this->admin, 'ingredients', 'seq.csv', $ok);
        $imp = $this->validate($this->admin, $r->body['id'], $r->body['suggestedMapping']);
        $this->ok($this->admin->post("/api/imports/{$r->body['id']}/confirm", ['lockVersion' => $imp['lockVersion']]));
        $this->drain();
        $this->assertSame(['ING-00001' => 'Uno', 'ING-00007' => 'Sette', 'ING-00008' => 'Otto'], DB::table('ingredients')->orderBy('code')->pluck('name', 'code')->all());

        $clash = "Codice;Nome;Contenuto confezione;Unità contenuto\n;Nove;1;kg\ning-00009;Esplicito;1;kg\n";
        $r2 = $this->upload($this->admin, 'ingredients', 'clash.csv', $clash);
        $imp2 = $this->validate($this->admin, $r2->body['id'], $r2->body['suggestedMapping']);
        $this->assertSame(0, $imp2['summary']['error']);
        $this->ok($this->admin->post("/api/imports/{$r2->body['id']}/confirm", ['lockVersion' => $imp2['lockVersion']]));
        $this->drain();
        $after = $this->ok($this->admin->get("/api/imports/{$r2->body['id']}"));
        $this->assertSame('failed', $after['status']);
        $this->assertSame('Riga 3: il codice ing-00009 è stato creato da qualcun altro dopo l’anteprima. Rivalida l’importazione.', $after['error']);
        $this->assertSame(3, DB::table('ingredients')->count());
    }

    /** Conservazione: solo le importazioni più vecchie di IMPORT_RETENTION_DAYS perdono file e righe di staging. */
    public function test_pulizia_solo_delle_importazioni_scadute(): void
    {
        $old = $this->uploadListino()->body['id'];
        $recent = $this->uploadListino()->body['id'];
        DB::table('imports')->where('id', $old)->update(['created_at' => Clock::plusSeconds(-31 * 86400)]);
        $this->assertSame(1, Jobs::cleanupImports());
        $this->assertSame('', DB::table('imports')->where('id', $old)->value('storage_path'));
        $this->assertNotSame('', DB::table('imports')->where('id', $recent)->value('storage_path'));
        $this->assertTrue($this->ok($this->admin->get("/api/imports/{$recent}"))['fileAvailable']);
    }

    // --- Importazione da XLSX ---

    public function test_xlsx_fogli_date_numeri_e_formule(): void
    {
        $tmp = tempnam(sys_get_temp_dir(), 'fcx').'.xlsx';
        $w = new Writer;
        $w->openToFile($tmp);
        $w->getCurrentSheet()->setName('Note');
        $w->addRow(Row::fromValues(['foglio da ignorare']));
        $w->addNewSheetAndMakeItCurrent()->setName('Listino');
        $w->addRow(Row::fromValues(['Codice', 'Nome', 'Prezzo confezione', 'Contenuto confezione', 'Unità contenuto', 'Data prezzo']));
        $d = new \DateTimeImmutable('2026-03-15T00:00:00Z');
        $w->addRow(new Row([Cell::fromValue('XL-1'), Cell::fromValue('Burro'), Cell::fromValue(11.5), Cell::fromValue(1), Cell::fromValue('kg'), Cell::fromValue($d)]));
        $w->addRow(new Row([Cell::fromValue('XL-2'), Cell::fromValue('Latte'), new Cell\FormulaCell('=B1*2', null, 3), Cell::fromValue(1), Cell::fromValue('l'), Cell::fromValue($d)]));
        $w->close();
        $r = $this->upload($this->admin, 'ingredients', 'listino.xlsx', file_get_contents($tmp));
        $this->assertSame(200, $r->status, json_encode($r->body));
        $this->assertSame(['Note', 'Listino'], $r->body['sheets']);
        $imp = $this->validate($this->admin, $r->body['id'], ['code' => 'Codice', 'name' => 'Nome', 'packagePrice' => 'Prezzo confezione', 'packageContent' => 'Contenuto confezione', 'packageUnit' => 'Unità contenuto', 'priceDate' => 'Data prezzo'], ['sheet' => 'Listino']);
        $this->assertSubset(['totalRows' => 2, 'create' => 1, 'error' => 1], $imp['summary']);
        $rows = $this->ok($this->admin->get("/api/imports/{$r->body['id']}/rows"));
        $this->assertSubset(['packagePrice' => '11.5', 'priceDate' => '2026-03-15'], $rows['data'][0]['normalized']);
        $this->assertMatchesRegularExpression('/formula/', $rows['data'][1]['errors'][0]);
    }

    public function test_rifiuta_xls_e_file_non_conformi(): void
    {
        $this->assertMatchesRegularExpression('/\.xls non è supportato/', $this->upload($this->admin, 'ingredients', 'vecchio.xls', 'abc')->body['error']['message']);
        $this->assertSame(422, $this->upload($this->admin, 'ingredients', 'finto.xlsx', 'non è uno zip')->status);
    }

    // --- Importazione dipendenti ---

    public function test_dipendenti_richiede_permesso_retribuzioni(): void
    {
        $this->assertSame(403, $this->upload($this->manager, 'employees', 'dip.csv', "Codice;Nome\n")->status);
    }

    private function uploadEmployees(): array
    {
        $csv = implode("\n", ['Codice;Nome;Cognome;Mansione;Lordo mensile;Ore produttive mensili;Decorrenza;Modalità oneri;Oneri', 'D-1;Mario;Rossi;Cuoco;2.400,00;160;01/01/2026;percentuale;30', 'D-2;Anna;Neri;Aiuto;1.800,00;160;01/01/2026;;', 'D-3;Luca;Bassi;Lavapiatti;1.500,00;160;01/01/2026;;200']);
        $r = $this->upload($this->admin, 'employees', 'dipendenti.csv', $csv);

        return [$r, $this->validate($this->admin, $r->body['id'], $r->body['suggestedMapping'])];
    }

    public function test_importa_dipendenti_e_costi(): void
    {
        [$r, $imp] = $this->uploadEmployees();
        $this->assertSubset(['grossMonthly' => 'Lordo mensile', 'contributionsMode' => 'Modalità oneri', 'contributionsValue' => 'Oneri'], $r->body['suggestedMapping']);
        $this->assertSubset(['create' => 2, 'error' => 1], $imp['summary']);
        $errs = $this->ok($this->admin->get("/api/imports/{$r->body['id']}/rows?action=error"));
        $this->assertMatchesRegularExpression('/modalità degli oneri/', implode(' ', $errs['data'][0]['errors']));
    }

    public function test_altra_azienda_non_vede_importazioni(): void
    {
        $this->uploadEmployees();
        $id = $this->ok($this->admin->get('/api/imports'))['data'][0]['id'];
        $this->assertSame(404, $this->other->get("/api/imports/{$id}")->status);
        $this->assertSame(404, $this->other->get("/api/imports/{$id}/report.csv")->status);
        $this->assertSame(404, $this->other->post("/api/imports/{$id}/confirm", ['lockVersion' => 1])->status);
    }

    // --- Volumi ---

    public function test_5000_righe_a_blocchi(): void
    {
        $lines = ['Codice;Nome;Prezzo confezione;Contenuto confezione;Unità contenuto;Data prezzo'];
        for ($i = 0; $i < 5000; $i++) {
            $lines[] = sprintf('MASS-%d;Articolo %d;%d,%02d;%d;kg;01/01/2026', $i, $i, ($i % 97) + 1, $i % 100, ($i % 9) + 1);
        }
        $t0 = microtime(true);
        $r = $this->upload($this->admin, 'ingredients', 'massivo.csv', implode("\n", $lines));
        $imp = $this->validate($this->admin, $r->body['id'], $r->body['suggestedMapping']);
        $this->assertSubset(['totalRows' => 5000, 'create' => 5000, 'error' => 0], $imp['summary']);
        $this->ok($this->admin->post("/api/imports/{$r->body['id']}/confirm", ['lockVersion' => $imp['lockVersion']]));
        $this->drain();
        $this->assertSame('applied', $this->ok($this->admin->get("/api/imports/{$r->body['id']}"))['status']);
        $this->assertSame(5000, DB::table('ingredients')->where('code', 'like', 'MASS-%')->count());
        fwrite(STDERR, sprintf("\n5.000 righe: validazione e applicazione in %.1f s\n", microtime(true) - $t0));
    }

    public function test_oltre_limite_righe(): void
    {
        config(['foodcost.import_max_rows' => 3]);
        $content = "Codice;Nome;Contenuto confezione;Unità contenuto\n".implode("\n", array_map(fn ($i) => "L{$i};N;1;kg", range(0, 4)));
        $up = $this->upload($this->admin, 'ingredients', 'l.csv', $content)->body;
        $this->admin->post("/api/imports/{$up['id']}/validate", ['options' => ['headerRow' => 1], 'mapping' => $up['suggestedMapping']]);
        $this->drain();
        $imp = $this->ok($this->admin->get("/api/imports/{$up['id']}"));
        $this->assertSame('failed', $imp['status']);
        $this->assertMatchesRegularExpression('/limite di 3 righe/', $imp['error']);
    }
}
