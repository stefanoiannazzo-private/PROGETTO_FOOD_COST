<?php

namespace Tests\Feature;

use App\Services\Invoices\FatturaPA;
use Illuminate\Http\UploadedFile;
use Illuminate\Support\Facades\DB;
use Tests\ApiClient;
use Tests\ApiResponse;
use Tests\TestCase;
use ZipArchive;

/** NUOVO — Fatture XML dei fornitori: lettura (XML, P7M, ZIP), abbinamento riga per riga, prezzi, memoria, doppioni. */
class SupplierInvoicesTest extends TestCase
{
    private ApiClient $a;

    private string $company;

    protected function setUp(): void
    {
        parent::setUp();
        $this->company = $this->createCompany('Trattoria Fatture');
        $this->addMember($this->company, $this->createUser('admin@fat.test', 'Admin'), 'admin');
        $this->addMember($this->company, $this->createUser('op@fat.test', 'Op'), 'operator');
        $this->a = $this->loginAs('admin@fat.test');
    }

    private static function xml(string $number = 'FT/1234', string $date = '2026-11-10'): string
    {
        $x = (string) file_get_contents(base_path('tests/fixtures/invoices/IT01234567890_00001.xml'));

        return str_replace(['<Numero>FT/1234</Numero>', '<Data>2026-11-10</Data>'], ["<Numero>{$number}</Numero>", "<Data>{$date}</Data>"], $x);
    }

    /** Busta CAdES (.p7m, DER) creata al volo con un certificato di prova. */
    private static function p7m(string $xml): string
    {
        $key = openssl_pkey_new(['private_key_bits' => 2048, 'private_key_type' => OPENSSL_KEYTYPE_RSA]);
        $cert = openssl_csr_sign(openssl_csr_new(['commonName' => 'Prova'], $key), null, $key, 1);
        $in = tempnam(sys_get_temp_dir(), 'in');
        $out = tempnam(sys_get_temp_dir(), 'out');
        file_put_contents($in, $xml);
        openssl_cms_sign($in, $out, $cert, $key, [], OPENSSL_CMS_BINARY, OPENSSL_ENCODING_DER);
        $der = (string) file_get_contents($out);
        @unlink($in);
        @unlink($out);

        return $der;
    }

    private function upload(array $files, ?ApiClient $c = null): ApiResponse
    {
        $up = [];
        foreach ($files as $name => $content) {
            $tmp = tempnam(sys_get_temp_dir(), 'fat');
            file_put_contents($tmp, $content);
            $up[] = new UploadedFile($tmp, $name, 'application/octet-stream', null, true);
        }

        return ($c ?? $this->a)->request('POST', '/api/supplier-invoices', null, true, null, ['files' => $up]);
    }

    public function test_legge_righe_sconti_e_modalita(): void
    {
        $inv = FatturaPA::parse(self::xml())[0];
        $this->assertSame('Caseificio Esempio S.r.l.', $inv['supplierName']);
        $this->assertSame('IT01234567890', $inv['supplierVat']);
        $this->assertSame('FT/1234', $inv['number']);
        $this->assertSame('2026-11-10', $inv['date']);
        [$moz, $passata, $olio, $acqua, $trasporto, $sconto] = $inv['lines'];
        // 36 € / 5 kg = 7,20 €/kg (sconto di riga del 10% compreso)
        $this->assertSame('kg', $moz['mode']);
        $this->assertSame('7.2', rtrim(rtrim($moz['netUnitPrice'], '0'), '.'));
        $this->assertSame('MOZ01', $moz['code']);
        $this->assertSame(['conf', '700', 'g'], [$passata['mode'], $passata['packageContent'], $passata['packageUnit']]);
        $this->assertSame('l', $olio['mode']);
        $this->assertSame(['conf', '9', 'l'], [$acqua['mode'], $acqua['packageContent'], $acqua['packageUnit']]);
        $this->assertFalse($trasporto['skip']);
        $this->assertTrue($sconto['skip']);
    }

    public function test_p7m_base64_zip_e_file_non_validi(): void
    {
        $xml = self::xml();
        $der = self::p7m($xml);
        $this->assertStringContainsString('FT/1234', (string) FatturaPA::toXml($der));
        $this->assertStringContainsString('FT/1234', (string) FatturaPA::toXml(chunk_split(base64_encode($der))));
        // lettura DER senza OpenSSL (come fallback)
        $m = new \ReflectionMethod(FatturaPA::class, 'derContent');
        $this->assertStringContainsString('<Numero>FT/1234</Numero>', (string) $m->invoke(null, $der));

        $tmp = tempnam(sys_get_temp_dir(), 'zip');
        $zip = new ZipArchive;
        $zip->open($tmp, ZipArchive::OVERWRITE);
        $zip->addFromString('IT01234567890_A1.xml.p7m', self::p7m(self::xml('A1')));
        $zip->addFromString('IT01234567890_A2.xml', self::xml('A2'));
        $zip->addFromString('IT01234567890_A2_MT_001.xml', '<Metadati/>');
        $zip->addFromString('leggimi.txt', 'ciao');
        $zip->close();
        $r = $this->ok($this->upload(['fatture.zip' => file_get_contents($tmp), 'rotto.xml' => '<ciao/>']));
        @unlink($tmp);
        $this->assertCount(2, $r['created']);
        $this->assertCount(1, $r['errors']);
        $this->assertSame('rotto.xml', $r['errors'][0]['file']);

        // DOCTYPE/ENTITY rifiutati
        $this->expectException(\App\Support\AppError::class);
        FatturaPA::parse('<?xml version="1.0"?><!DOCTYPE x [<!ENTITY e SYSTEM "file:///etc/passwd">]><FatturaElettronica>&e;</FatturaElettronica>');
    }

    public function test_conferma_crea_prodotti_prezzi_e_ricorda_gli_abbinamenti(): void
    {
        $esistente = $this->ok($this->a->post('/api/ingredients', [
            'name' => 'Olio extravergine', 'category' => 'Condimenti', 'supplier' => 'Altro', 'purchaseUnit' => 'litro', 'packageContent' => '1', 'packageUnit' => 'l', 'usageUnit' => 'ml',
        ]))['id'];
        $id = $this->ok($this->upload(['f.xml' => self::xml()]))['created'][0];
        $inv = $this->ok($this->a->get("/api/supplier-invoices/{$id}"));
        $this->assertCount(6, $inv['lines']);
        $this->assertSame('ignore', $inv['lines'][5]['suggestion']['action']);

        // categoria mancante e confezione senza contenuto: errori per riga, nulla viene scritto
        $bad = $this->a->post("/api/supplier-invoices/{$id}/confirm", ['lines' => [
            ['n' => 1, 'action' => 'new', 'name' => 'Mozzarella fiordilatte', 'mode' => 'kg'],
            ['n' => 2, 'action' => 'new', 'name' => 'Passata', 'category' => 'Conserve', 'mode' => 'conf'],
        ]]);
        $this->assertSame(422, $bad->status);
        $f = $bad->body['error']['details']['fields'];
        $this->assertArrayHasKey('line1.category', $f);
        $this->assertArrayHasKey('line2.packageContent', $f);
        $this->assertArrayHasKey('line3', $f);
        $this->assertSame(0, DB::table('ingredients')->where('company_id', $this->company)->where('name', 'Passata')->count());

        // a peso su un prodotto registrato a litri: incompatibile
        $bad = $this->a->post("/api/supplier-invoices/{$id}/confirm", ['lines' => [
            ['n' => 3, 'action' => 'existing', 'ingredientId' => $esistente, 'mode' => 'kg'],
        ]]);
        $this->assertStringContainsString('a volume', $bad->body['error']['details']['fields']['line3.mode']);

        $r = $this->ok($this->a->post("/api/supplier-invoices/{$id}/confirm", ['lines' => [
            ['n' => 1, 'action' => 'new', 'name' => 'Mozzarella fiordilatte', 'category' => 'Latticini', 'mode' => 'kg'],
            ['n' => 2, 'action' => 'new', 'name' => 'Passata di pomodoro', 'category' => 'Conserve', 'mode' => 'conf', 'packageContent' => '700', 'packageUnit' => 'g', 'purchaseUnit' => 'bottiglia'],
            ['n' => 3, 'action' => 'existing', 'ingredientId' => $esistente, 'mode' => 'l'],
            ['n' => 4, 'action' => 'ignore'],
            ['n' => 5, 'action' => 'ignore'],
            ['n' => 6, 'action' => 'ignore'],
        ]]));
        $this->assertSame([2, 3, 3, 0], [$r['created'], $r['prices'], $r['ignored'], $r['skipped']]);

        $moz = DB::table('ingredients')->where('company_id', $this->company)->where('name', 'Mozzarella fiordilatte')->first();
        $this->assertSame(['Latticini', 'Caseificio Esempio S.r.l.', 'kg', 'kg', 'g'], [$moz->category, $moz->supplier, $moz->purchase_unit, $moz->package_unit, $moz->usage_unit]);
        $p = DB::table('ingredient_prices')->where('ingredient_id', $moz->id)->first();
        $this->assertSame('7.2', rtrim(rtrim((string) $p->package_price, '0'), '.'));
        $this->assertSame('2026-11-10', substr((string) $p->valid_from, 0, 10));
        $this->assertStringContainsString('Fattura FT/1234', $p->source);
        $pas = DB::table('ingredients')->where('company_id', $this->company)->where('name', 'Passata di pomodoro')->first();
        $this->assertSame(['bottiglia', '700', 'g'], [$pas->purchase_unit, rtrim(rtrim((string) $pas->package_content, '0'), '.'), $pas->package_unit]);
        $this->assertSame(1, DB::table('ingredient_prices')->where('ingredient_id', $esistente)->count());

        // stessa fattura di nuovo: già importata
        $again = $this->ok($this->upload(['f.xml' => self::xml()]));
        $this->assertSame([], $again['created']);
        $this->assertSame('FT/1234', $again['duplicates'][0]['number']);
        $this->assertSame(409, $this->a->post("/api/supplier-invoices/{$id}/confirm", ['lines' => []])->status);

        // fattura successiva dello stesso fornitore: le righe sono riconosciute
        $id2 = $this->ok($this->upload(['g.xml' => self::xml('FT/1300', '2026-11-20')]))['created'][0];
        $s = array_column($this->ok($this->a->get("/api/supplier-invoices/{$id2}"))['lines'], 'suggestion', 'n');
        $this->assertSame(['existing', $moz->id, 'kg', true], [$s[1]['action'], $s[1]['ingredientId'], $s[1]['mode'], $s[1]['remembered']]);
        $this->assertSame(['existing', '700', 'g'], [$s[2]['action'], $s[2]['packageContent'], $s[2]['packageUnit']]);
        $this->assertSame(['ignore', true], [$s[4]['action'], $s[4]['remembered']]);

        // bozza scartabile, fattura importata no
        $this->ok($this->a->request("DELETE", "/api/supplier-invoices/{$id2}"));
        $this->assertSame(409, $this->a->request("DELETE", "/api/supplier-invoices/{$id}")->status);
        $this->assertCount(1, $this->ok($this->a->get('/api/supplier-invoices'))['data']);
        $this->assertStringContainsString('FatturaElettronica', $this->a->get("/api/supplier-invoices/{$id}/file")->raw->getContent());
    }

    public function test_permessi_e_isolamento(): void
    {
        $this->assertSame(403, $this->upload(['f.xml' => self::xml()], $this->loginAs('op@fat.test'))->status);
        $id = $this->ok($this->upload(['f.xml' => self::xml()]))['created'][0];
        $other = $this->createCompany('Altra');
        $this->addMember($other, $this->createUser('x@altra.test', 'X'), 'admin');
        $this->assertSame(404, $this->loginAs('x@altra.test')->get("/api/supplier-invoices/{$id}")->status);
    }
}
